import { DurableObject } from "cloudflare:workers";
import { formatTrackRecord, SPECIAL_INSTRUCTIONS } from "../agents/prompts";
import { AGENTS, AGENT_IDS, CORE_AGENTS, displayName, isAgentId } from "../agents/registry";
import { BudgetExceeded, executeApproved, parseArgs, runAgentTurn } from "../agents/runner";
import { runChat, type CallOptions } from "../ai/workers-ai";
import { LIMITS, SYSTEM_MODELS } from "../config";
import { MemoryStore, type Followup } from "../memory/store";
import { toMarkdown } from "../skills/builtin/docs";
import { followupInstruction } from "../skills/builtin/powers";
import { getSkill } from "../skills/registry";
import type { RoomHooks, SkillContext } from "../skills/types";
import { escapeHtml } from "../telegram/format";
import {
  botToken,
  downloadAsDataUri,
  downloadFile,
  editMessageHtml,
  answerCallback,
  hostAgent,
  parseIds,
  sendAs,
  sendPhotoAs,
  sendSystem,
  sendSystemHtml,
  sendTyping,
  sendVoiceAs,
  type InlineKeyboard,
} from "../telegram/api";
import type { AgentId, CallbackAction, Env, IncomingMessage, Mode, TranscriptMessage } from "../types";
import { encodeRoom, signRoomToken } from "../voice/auth";
import { estimateSpeechMs, speechStream, speechToText, voiceNote } from "../voice/speech";
import { chooseSpeakers, collectBids } from "./bids";
import { route, routeLive, type Command, type Step, type SystemCommand } from "./router";

/** The discussion currently being played out in this conversation. */
interface ActivePlan {
  generation: number;
  discussionId: number;
  mode: Mode;
  topic: string;
  steps: Step[];
  posts: number;
  /** Image the agents should look at in this discussion. */
  imageFileId?: string;
  /** Reply with voice notes (founder spoke, or /voice on). */
  voiceReplies: boolean;
  /** Live call: speak into the WebSocket instead of (as well as) Telegram. */
  live: boolean;
}

/** Where this room lives. Set by the first message. */
interface Identity {
  convId: number;
  chatId: number;
  dmAgent?: AgentId;
}

type AgentState = "thinking" | "speaking" | "listening" | "dormant";

const IMAGE_MEMORY_MS = 3600_000;

const HELP = `AI Council

Talk normally: the most relevant members reply. Send a voice note and they answer with voice notes.
@Atlas / "Nova, ..." / reply to a member / DM a member's bot: only they answer.

Discussions
/council <topic>: blind round, then debate, then a Nexus summary
/debate <topic>: ${LIMITS.debateRounds} rounds of argument
/brainstorm <topic>: cooperative ideas
/critic: everyone attacks the current idea
/premortem <plan>: Atlas imagines the failure, Sage checks it
/decide <question>: Atlas builds a decision matrix
/personas <idea>: Axiom role-plays customers
/minutes: Nexus writes minutes, decisions and action items
/brief: Nexus's brief now; /brief on|off for every morning

Memory & records
/actions  /claims  /ideas  /record  /followups  /cost

Voice
/call: open the live voice room
/voice on|off: always answer with voice notes

/stop: end the current discussion   /status: who's here

Specialists wake up on their own: 💻 Cipher and 🏗️ Forge for code and architecture, 👁️ Iris for images and links.`;

/**
 * One instance per conversation (a group, or a DM with one agent). Serializes everything
 * that happens there.
 *
 * A single alarm drives both the running discussion (one agent turn per tick) and the
 * agents' self-scheduled follow-ups. Human messages bump `generation`; each turn
 * re-checks it before posting, so a new human message interrupts within one turn.
 */
export class CouncilRoom extends DurableObject<Env> {
  private store: MemoryStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new MemoryStore(env.DB, env.AI, env.VECTORIZE);
  }

  // =========================================================================
  // Entry points
  // =========================================================================

  async handleMessage(raw: IncomingMessage): Promise<void> {
    const identity = await this.remember(raw);
    const msg = await this.preprocess(raw, identity);
    if (!msg) return;
    if (msg.imageFileId) {
      await this.ctx.storage.put({ lastImageFileId: msg.imageFileId, lastImageAt: Date.now() });
    }

    const transcript = await this.store.recentMessages(identity.convId, LIMITS.transcriptWindow);
    const recentSpeakers = [...new Set(transcript.map((m) => m.speaker).reverse())].filter(isAgentId);
    const command = route(msg, { recentSpeakers });
    await this.execute(command, msg, identity);
  }

  async handleCallback(cb: CallbackAction): Promise<void> {
    const identity = await this.identity();
    const m = /^ap:(\d+):([yn])$/.exec(cb.data);
    if (!m || !identity) return answerCallback(this.env, cb.viaAgent, cb.callbackId, "Unknown action.");
    const approval = await this.store.getApproval(Number(m[1]));
    if (!approval || approval.conv_id !== identity.convId) return answerCallback(this.env, cb.viaAgent, cb.callbackId, "Unknown request.");

    const approve = m[2] === "y";
    if (!(await this.store.decideApproval(approval.id, approve ? "approved" : "rejected"))) {
      return answerCallback(this.env, cb.viaAgent, cb.callbackId, "Already decided.");
    }
    const who = displayName(approval.agent);
    const head = `${escapeHtml(who)}: ${escapeHtml(approval.summary)}`;
    await this.addTranscript(identity, null, approval.agent, `[founder ${approve ? "approved" : "rejected"} request #${approval.id}: ${approval.summary}]`);

    if (!approve) {
      await answerCallback(this.env, cb.viaAgent, cb.callbackId, "Rejected");
      return editMessageHtml(this.env, cb.viaAgent, cb.chatId, cb.messageId, `❌ <b>Rejected</b>\n${head}`);
    }

    await answerCallback(this.env, cb.viaAgent, cb.callbackId, "Approved: running…");
    await editMessageHtml(this.env, cb.viaAgent, cb.chatId, cb.messageId, `⏳ <b>Approved, running…</b>\n${head}`);
    const skill = getSkill(approval.skill);
    const args = parseArgs(approval.args_json) ?? {};
    let result: string;
    try {
      if (!skill) throw new Error(`skill ${approval.skill} no longer exists`);
      const transcript = await this.store.recentMessages(identity.convId, LIMITS.transcriptWindow);
      result = await executeApproved(skill, args, this.skillContext(approval.agent, identity, transcript));
      await this.store.setApprovalResult(approval.id, "approved", result);
      await editMessageHtml(this.env, cb.viaAgent, cb.chatId, cb.messageId, `✅ <b>Done</b>\n${head}\n\n<pre>${escapeHtml(result.slice(0, 1500))}</pre>`);
    } catch (err) {
      result = `failed: ${err instanceof Error ? err.message : String(err)}`;
      await this.store.setApprovalResult(approval.id, "failed", result);
      await editMessageHtml(this.env, cb.viaAgent, cb.chatId, cb.messageId, `⚠️ <b>Failed</b>\n${head}\n\n${escapeHtml(result.slice(0, 800))}`);
    }

    // Let the agent pick its task back up, unless the founder has moved on to something else.
    if (!(await this.ctx.storage.get<ActivePlan>("plan"))) {
      await this.startPlan(identity, "direct", "", [
        {
          agents: [identity.dmAgent ?? approval.agent],
          parallel: false,
          turn: "normal",
          instruction: `The founder approved your request #${approval.id} (${approval.summary}). Result: ${result.slice(0, 1500)}\nTell the founder in a sentence or two what happened and continue the task if there is a next step.`,
        },
      ]);
    }
  }

  /** Cron: the morning brief (Nexus passes if there's nothing to say). */
  async startBrief(): Promise<void> {
    const identity = await this.identity();
    if (!identity || (await this.ctx.storage.get<ActivePlan>("plan"))) return;
    const agent = identity.dmAgent ?? "nexus";
    await this.startPlan(identity, "direct", "daily brief", [
      { agents: [agent], parallel: false, turn: "normal", instruction: SPECIAL_INSTRUCTIONS.brief },
    ]);
  }

  /** WebSocket upgrade for the live voice room. The Worker has already authenticated the caller. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const identity = await this.identity();
    if (!identity) return new Response("This room has no conversation yet. Send a message in the chat first.", { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.send(
      JSON.stringify({
        type: "hello",
        agents: AGENT_IDS.filter((id) => !identity.dmAgent || id === identity.dmAgent).map((id) => ({
          id,
          name: AGENTS[id].name,
          emoji: AGENTS[id].emoji,
          role: AGENTS[id].role,
          state: AGENTS[id].tier === "core" || id === identity.dmAgent ? "listening" : "dormant",
        })),
      }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const identity = await this.identity();
    if (!identity) return;

    if (typeof message !== "string") {
      if (message.byteLength < 2000 || message.byteLength > 4 * 1024 * 1024) return;
      let text = "";
      try {
        text = await speechToText(this.env.AI, new Uint8Array(message), this.callOptions(identity));
      } catch (err) {
        console.error("transcription failed", err);
        ws.send(JSON.stringify({ type: "error", message: "Couldn't transcribe that." }));
        return;
      }
      if (text.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return;
      this.broadcast({ type: "heard", text });
      return this.handleLive(identity, text);
    }

    let data: { type?: string; text?: string };
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    switch (data.type) {
      case "interrupt": {
        const plan = await this.ctx.storage.get<ActivePlan>("plan");
        if (plan?.live) await this.interrupt("interrupted");
        return;
      }
      case "played": {
        const plan = await this.ctx.storage.get<ActivePlan>("plan");
        if (plan?.live) {
          await this.ctx.storage.put("planDueAt", Date.now());
          await this.scheduleNext();
        }
        return;
      }
      case "say":
        if (data.text?.trim()) return this.handleLive(identity, data.text.trim());
        return;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // Last listener left the call: stop talking into the void. The closing socket may
    // still be listed while this handler runs, so count only the others that are open.
    const others = this.ctx.getWebSockets().filter((s) => s !== ws && s.readyState === WebSocket.OPEN);
    if (others.length === 0) {
      const plan = await this.ctx.storage.get<ActivePlan>("plan");
      if (plan?.live) await this.interrupt("stopped");
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const plan = await this.ctx.storage.get<ActivePlan>("plan");
    const dueAt = await this.ctx.storage.get<number>("planDueAt");
    const identity = await this.identity();

    if (plan && plan.generation !== (await this.generation())) {
      await this.ctx.storage.delete(["plan", "planDueAt"]);
    } else if (plan && identity) {
      if (dueAt !== undefined && dueAt <= now) await this.runStep(plan, identity);
    } else if (identity) {
      const [due] = await this.store.dueFollowups(identity.convId, now, 1);
      if (due) await this.startFollowup(due, identity);
    }
    await this.scheduleNext();
  }

  // =========================================================================
  // Commands
  // =========================================================================

  private async execute(command: Command, msg: IncomingMessage, identity: Identity): Promise<void> {
    const via = identity.dmAgent;
    switch (command.kind) {
      case "status":
        return sendSystem(this.env, identity.chatId, await this.statusText(), via);
      case "help":
        return sendSystem(this.env, identity.chatId, HELP, via);
      case "system":
        return this.systemCommand(command.name, command.arg, identity);
      case "brief_toggle":
        await this.store.setChatFlag(identity.convId, "brief_enabled", command.on);
        return sendSystem(this.env, identity.chatId, command.on ? "☀️ Nexus will post a brief every morning." : "Daily brief off.", via);
      case "stop": {
        const had = await this.interrupt("stopped");
        await this.scheduleNext();
        return sendSystem(this.env, identity.chatId, had ? "⏹ Discussion stopped." : "Nothing is running.", via);
      }
      case "discuss": {
        await this.interrupt("interrupted");
        const settings = await this.store.chatSettings(identity.convId);
        const discussionId = await this.store.createDiscussion(identity.convId, command.mode, command.topic);
        const human = msg.text + (msg.imageFileId ? " [sent an image]" : "");
        await this.addTranscript(identity, discussionId, "human", human.trim(), msg.fromName, msg.messageId || undefined);
        await this.startPlan(identity, command.mode, command.topic, command.steps, {
          discussionId,
          imageFileId: await this.imageFor(msg, command.agents),
          voiceReplies: !!msg.viaVoice || !!settings?.voice_replies,
        });
        return;
      }
    }
  }

  private async handleLive(identity: Identity, text: string): Promise<void> {
    const msg: IncomingMessage = {
      chatId: identity.chatId,
      convId: identity.convId,
      messageId: 0,
      fromId: 0,
      fromName: "Founder",
      text,
      viaVoice: true,
      dmAgent: identity.dmAgent,
    };
    // Keep the Telegram chat as the single transcript of the call.
    void sendSystem(this.env, identity.chatId, `🎙️ ${text}`, identity.dmAgent).catch(() => {});
    await this.interrupt("interrupted");
    const command = identity.dmAgent
      ? ({ kind: "discuss", mode: "live", topic: "", agents: [identity.dmAgent], steps: [{ agents: [identity.dmAgent], parallel: false, turn: "normal" }] } as const)
      : routeLive(msg);
    if (command.kind !== "discuss") return;
    const discussionId = await this.store.createDiscussion(identity.convId, "live", "");
    await this.addTranscript(identity, discussionId, "human", text, "Founder (call)");
    await this.startPlan(identity, "live", "", command.steps.map((s) => ({ ...s, agents: [...s.agents] })), {
      discussionId,
      voiceReplies: false,
      live: true,
    });
  }

  private async systemCommand(name: SystemCommand, arg: string, identity: Identity): Promise<void> {
    const via = identity.dmAgent;
    const send = (text: string) => sendSystem(this.env, identity.chatId, text, via);
    const shared = this.sharedConvIds(identity);
    const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
    switch (name) {
      case "actions": {
        const items = await this.store.openActions(shared);
        return send(items.length ? `📋 Open action items\n\n${items.map((a) => `#${a.id} ${a.text} (${a.owner}${a.due_at ? `, due ${day(a.due_at)}` : ""})`).join("\n")}` : "No open action items.");
      }
      case "claims": {
        const claims = await this.store.recentClaims(identity.convId, 15);
        const mark = (v: string) => (v === "true" ? "✅" : v === "false" ? "❌" : "❓");
        return send(claims.length ? `🔎 Claim ledger\n\n${claims.map((c) => `${mark(c.verdict)} #${c.id} "${c.claim}" (${c.claimed_by})${c.source ? `\n   ${c.source}` : ""}`).join("\n")}` : "No checked claims yet.");
      }
      case "ideas": {
        const ideas = arg ? await this.store.searchIdeas(arg, 15) : await this.store.recentIdeas(15);
        return send(ideas.length ? `💡 Idea bank\n\n${ideas.map((i) => `#${i.id} ${i.idea}${i.tags ? ` [${i.tags}]` : ""}`).join("\n")}` : "The idea bank is empty.");
      }
      case "record": {
        const lines = await Promise.all(
          AGENT_IDS.filter((id) => AGENTS[id].kind === "chat").map(async (id) => `${displayName(id)}: ${formatTrackRecord(await this.store.trackRecord(id))}`),
        );
        return send(`🎯 Prediction track record\n\n${lines.join("\n")}`);
      }
      case "followups": {
        const f = await this.store.pendingFollowups(identity.convId);
        return send(f.length ? `⏰ Scheduled follow-ups\n\n${f.map((x) => `${new Date(x.due_at).toISOString().slice(0, 16).replace("T", " ")} ${displayName(x.agent)}: ${x.note}`).join("\n")}` : "No follow-ups scheduled.");
      }
      case "cost": {
        const rows = await this.store.usageReport(7);
        const today = new Date().toISOString().slice(0, 10);
        const budget = Number(this.env.DAILY_TOKEN_BUDGET_PER_AGENT) || 0;
        const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
        const byAgent = new Map<string, { today: number; week: number; calls: number }>();
        for (const r of rows) {
          const e = byAgent.get(r.agent) ?? { today: 0, week: 0, calls: 0 };
          const t = r.prompt + r.completion;
          e.week += t;
          e.calls += r.calls;
          if (r.day === today) e.today += t;
          byAgent.set(r.agent, e);
        }
        const lines = [...byAgent.entries()]
          .sort((a, b) => b[1].week - a[1].week)
          .map(([a, e]) => `${isAgentId(a) ? displayName(a) : a}: ${fmt(e.today)} today${budget ? ` / ${fmt(budget)}` : ""}, ${fmt(e.week)} in 7 days (${e.calls} calls)`);
        const gw = this.env.AI_GATEWAY_ID ? "\n\nCosts in dollars: AI Gateway dashboard." : "";
        return send(lines.length ? `💸 Token usage\n\n${lines.join("\n")}${gw}` : "No usage recorded yet.");
      }
      case "voice": {
        const on = !/^off$/i.test(arg);
        await this.store.setChatFlag(identity.convId, "voice_replies", on);
        return send(on ? "🔊 Members will answer with voice notes." : "Voice replies off (voice notes you send still get voice answers).");
      }
      case "call":
        return this.sendCallLink(identity);
    }
  }

  private async sendCallLink(identity: Identity): Promise<void> {
    const via = identity.dmAgent;
    const buttons: InlineKeyboard = [];
    if (this.env.MINIAPP_URL && !identity.dmAgent) {
      buttons.push([{ text: "🎙️ Join in Telegram", url: `${this.env.MINIAPP_URL}?startapp=${encodeRoom(identity.convId)}` }]);
    }
    if (this.env.PUBLIC_URL) {
      const token = await signRoomToken(this.env.TELEGRAM_WEBHOOK_SECRET, identity.convId);
      buttons.push([{ text: "🌐 Join in browser", url: `${this.env.PUBLIC_URL.replace(/\/$/, "")}/app?t=${encodeURIComponent(token)}` }]);
    }
    if (!buttons.length) return sendSystem(this.env, identity.chatId, "Set PUBLIC_URL (and optionally MINIAPP_URL) in wrangler.jsonc to enable calls.", via);
    await sendSystemHtml(this.env, identity.chatId, "🎙️ <b>AI Council Live</b>\nTap to join the voice room. Links expire in 6 hours.", via, { inline_keyboard: buttons });
  }

  // =========================================================================
  // Plans and turns
  // =========================================================================

  private async startPlan(
    identity: Identity,
    mode: Mode,
    topic: string,
    steps: Step[],
    opts: { discussionId?: number; imageFileId?: string; voiceReplies?: boolean; live?: boolean } = {},
  ): Promise<void> {
    const plan: ActivePlan = {
      generation: await this.generation(),
      discussionId: opts.discussionId ?? (await this.store.createDiscussion(identity.convId, mode, topic)),
      mode,
      topic,
      steps: steps.filter((s) => s.agents.length > 0),
      posts: 0,
      imageFileId: opts.imageFileId,
      voiceReplies: !!opts.voiceReplies,
      live: !!opts.live,
    };
    await this.ctx.storage.put({ plan, planDueAt: Date.now() });
    await this.scheduleNext();
  }

  private async startFollowup(f: Followup, identity: Identity): Promise<void> {
    await this.store.completeFollowup(f.id);
    // In a DM only the DM agent can post; it relays anything meant for another member.
    const agent = identity.dmAgent ?? f.agent;
    const relay = agent !== f.agent ? `(This was scheduled for ${AGENTS[f.agent].name}; handle it yourself.) ` : "";
    await this.startPlan(identity, "direct", `follow-up #${f.id}`, [
      { agents: [agent], parallel: false, turn: "normal", instruction: relay + followupInstruction(f.kind, f.note) },
    ]);
  }

  /** Executes the next step of the plan: one agent (sequential), a whole blind round (parallel), or live bidding. */
  private async runStep(plan: ActivePlan, identity: Identity): Promise<void> {
    this.enforceBudget(plan);
    const step = plan.steps[0];
    if (!step) return this.finish(plan, identity);
    const transcript = await this.store.recentMessages(identity.convId, LIMITS.transcriptWindow);

    if (step.bid) {
      step.agents.forEach((a) => this.setState(a, "thinking"));
      const bids = await collectBids(this.env.AI, this.store, step.agents, transcript, this.callOptions(identity), identity.convId);
      if (plan.generation !== (await this.generation())) return;
      const lastHuman = [...transcript].reverse().find((m) => m.speaker === "human")?.text ?? "";
      const winners = chooseSpeakers(bids, lastHuman);
      step.agents.filter((a) => !winners.includes(a)).forEach((a) => this.setState(a, "listening"));
      if (!winners.length) return this.finish(plan, identity);
      plan.steps[0] = { agents: winners, parallel: false, turn: "normal" };
      await this.ctx.storage.put({ plan, planDueAt: Date.now() });
      return;
    }

    const agents = step.parallel ? step.agents : step.agents.slice(0, 1);
    const image = plan.imageFileId ? await this.loadImage(plan.imageFileId, identity) : undefined;
    const speaking = plan.voiceReplies || plan.live;

    for (const a of agents) {
      this.setState(a, "thinking");
      void sendTyping(this.env, identity.dmAgent ?? a, identity.chatId, plan.voiceReplies ? "record_voice" : "typing");
    }
    const replies = await Promise.all(
      agents.map(async (agent) => {
        try {
          const text = await runAgentTurn(
            { mode: plan.mode, turn: step.turn, topic: plan.topic, transcript, instruction: step.instruction, speaking },
            this.skillContext(agent, identity, transcript, image),
          );
          return { agent, text, notice: null as string | null };
        } catch (err) {
          console.error(`${agent} turn failed`, err);
          const notice = err instanceof BudgetExceeded ? `💸 ${displayName(agent)} hit its daily token budget.` : `⚠️ ${displayName(agent)} couldn't respond.`;
          return { agent, text: null, notice };
        }
      }),
    );

    for (const r of replies) {
      // A human spoke while we were thinking: drop this discussion's remaining output.
      if (plan.generation !== (await this.generation())) return;
      if (r.text && plan.posts < LIMITS.maxPostsPerDiscussion) await this.post(plan, identity, r.agent, r.text);
      else {
        this.setState(r.agent, "listening");
        if (r.notice) await sendSystem(this.env, identity.chatId, r.notice, identity.dmAgent).catch(() => {});
      }
    }

    if (step.parallel) plan.steps.shift();
    else {
      step.agents.shift();
      if (!step.agents.length) plan.steps.shift();
    }

    if (plan.generation !== (await this.generation())) return;
    this.enforceBudget(plan);
    if (!plan.steps.length) return this.finish(plan, identity);

    // Live: wait for the client to report the audio finished (with a timeout); otherwise a short pause.
    const lastText = replies.map((r) => r.text).filter(Boolean).pop() ?? "";
    const wait = plan.live ? estimateSpeechMs(lastText) + 500 : LIMITS.cooldownMs;
    await this.ctx.storage.put({ plan, planDueAt: Date.now() + wait });
  }

  /** Near the post budget, skip ahead to the summary (if any) so a long debate still ends cleanly. */
  private enforceBudget(plan: ActivePlan): void {
    const hasSummary = plan.steps.some((s) => s.turn === "summary");
    const reserve = hasSummary ? 1 : 0;
    if (plan.posts >= LIMITS.maxPostsPerDiscussion - reserve) {
      plan.steps = plan.posts < LIMITS.maxPostsPerDiscussion ? plan.steps.filter((s) => s.turn === "summary") : [];
    }
  }

  private async post(plan: ActivePlan, identity: Identity, agent: AgentId, text: string): Promise<void> {
    const sender = identity.dmAgent ?? agent;
    let telegramId: number | undefined;

    if (plan.live) {
      this.setState(agent, "speaking");
      try {
        let seq = 0;
        for await (const chunk of speechStream(this.env.AI, agent, text, this.callOptions(identity))) {
          if (plan.generation !== (await this.generation())) break;
          this.broadcast({ type: "speak", agent, seq: seq++, text: chunk.text, audio: chunk.audioB64 });
        }
      } catch (err) {
        console.error("live speech failed", err);
      }
      this.broadcast({ type: "speak_end", agent, text });
      telegramId = await sendAs(this.env, sender, identity.chatId, text).catch(() => undefined);
    } else if (plan.voiceReplies) {
      try {
        const ogg = await voiceNote(this.env.AI, agent, text, this.callOptions(identity));
        if (!ogg) throw new Error("nothing to say out loud");
        const fitsCaption = text.length <= LIMITS.telegramMaxCaption - 40 && !text.includes("```");
        telegramId = await sendVoiceAs(this.env, sender, identity.chatId, ogg, fitsCaption ? text.replace(/[*_`#]/g, "") : undefined);
        if (!fitsCaption) await sendAs(this.env, sender, identity.chatId, text);
      } catch (err) {
        console.warn("voice reply failed, sending text", err);
        telegramId = await sendAs(this.env, sender, identity.chatId, text);
      }
      this.setState(agent, "listening");
    } else {
      telegramId = await sendAs(this.env, sender, identity.chatId, text);
      this.setState(agent, "listening");
    }

    plan.posts++;
    await this.addTranscript(identity, plan.discussionId, agent, text, AGENTS[agent].name, telegramId);
  }

  private async finish(plan: ActivePlan, identity: Identity): Promise<void> {
    await this.store.endDiscussion(plan.discussionId, "done", plan.posts);
    await this.ctx.storage.delete(["plan", "planDueAt"]);
    AGENT_IDS.forEach((a) => this.setState(a, AGENTS[a].tier === "core" ? "listening" : "dormant"));
    if (plan.posts === 0 && !["chat", "live", "direct"].includes(plan.mode)) {
      await sendSystem(this.env, identity.chatId, "The council had nothing to add.", identity.dmAgent);
    }
    if (plan.posts >= LIMITS.summarizeAfterPosts) this.ctx.waitUntil(this.summarize(plan.discussionId, identity));
  }

  /** Condense a finished discussion into long-term memory. */
  private async summarize(discussionId: number, identity: Identity): Promise<void> {
    try {
      const msgs = await this.store.discussionMessages(discussionId);
      const text = msgs.map((m) => `${m.speakerName}: ${m.text}`).join("\n\n").slice(0, 24_000);
      const r = await runChat(
        this.env.AI,
        SYSTEM_MODELS.fast,
        [
          {
            role: "user",
            content: `Summarize this AI council discussion for long-term memory in 3–5 sentences: the topic, each member's position (by name), what the founder decided, and what is still open. No preamble.\n\n${text}`,
          },
        ],
        { maxTokens: 300, ...this.callOptions(identity) },
      );
      await this.store.recordUsage(identity.convId, "nexus", SYSTEM_MODELS.fast, r.usage.promptTokens, r.usage.completionTokens);
      const summary = r.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (summary) await this.store.saveSummary(identity.convId, discussionId, summary);
    } catch (err) {
      console.warn("summary failed", err);
    }
  }

  /** Bump the generation and end the running plan. Returns true if something was running. */
  private async interrupt(status: "stopped" | "interrupted"): Promise<boolean> {
    await this.ctx.storage.put("generation", (await this.generation()) + 1);
    const plan = await this.ctx.storage.get<ActivePlan>("plan");
    if (!plan) return false;
    await this.store.endDiscussion(plan.discussionId, status, plan.posts);
    await this.ctx.storage.delete(["plan", "planDueAt"]);
    if (plan.live) this.broadcast({ type: "interrupted" });
    return true;
  }

  /** One alarm serves both the plan and the follow-ups: set it to whichever is due first. */
  private async scheduleNext(): Promise<void> {
    const identity = await this.identity();
    const plan = await this.ctx.storage.get<ActivePlan>("plan");
    const planDue = plan ? await this.ctx.storage.get<number>("planDueAt") : undefined;
    const followupDue = identity ? await this.store.nextFollowupAt(identity.convId) : null;
    const candidates = [planDue, plan ? null : followupDue].filter((t): t is number => typeof t === "number");
    // While a plan runs, follow-ups wait; check again shortly after it ends.
    if (plan && followupDue !== null && planDue === undefined) candidates.push(Date.now() + 60_000);
    if (!candidates.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now(), Math.min(...candidates)));
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private async generation(): Promise<number> {
    return (await this.ctx.storage.get<number>("generation")) ?? 0;
  }

  private async identity(): Promise<Identity | undefined> {
    return this.ctx.storage.get<Identity>("identity");
  }

  private async remember(msg: IncomingMessage): Promise<Identity> {
    const existing = await this.identity();
    if (existing) return existing;
    const identity: Identity = { convId: msg.convId, chatId: msg.chatId, dmAgent: msg.dmAgent };
    await this.ctx.storage.put("identity", identity);
    await this.store.upsertChat(msg.convId, msg.chatId, msg.dmAgent);
    return identity;
  }

  /** DMs share the home group's memory: there's one Atlas, whether you DM him or not. */
  private sharedConvIds(identity: Identity): number[] {
    const home = Number(this.env.HOME_CHAT_ID || parseIds(this.env.ALLOWED_CHAT_IDS)[0]);
    return home && home !== identity.convId ? [identity.convId, home] : [identity.convId];
  }

  private callOptions(identity: Identity): CallOptions {
    return { gatewayId: this.env.AI_GATEWAY_ID || undefined, metadata: { conv: identity.convId } };
  }

  private skillContext(agent: AgentId, identity: Identity, transcript: TranscriptMessage[], image?: string): SkillContext {
    return {
      env: this.env,
      store: this.store,
      convId: identity.convId,
      chatId: identity.chatId,
      agent,
      sharedConvIds: this.sharedConvIds(identity),
      image,
      transcript,
      consultDepth: 0,
      callOptions: this.callOptions(identity),
      hooks: this.hooks(identity),
    };
  }

  private hooks(identity: Identity): RoomHooks {
    return {
      scheduleNext: () => this.scheduleNext(),
      sendPhoto: (agent, png, caption) => sendPhotoAs(this.env, identity.dmAgent ?? agent, identity.chatId, png, caption),
      requestApproval: async (id, agent, summary) => {
        // The buttons come from the requesting agent's bot, so the callback reaches its webhook.
        const via = identity.dmAgent ?? (botToken(this.env, agent) ? agent : hostAgent(this.env));
        const html = `🔐 <b>${escapeHtml(displayName(agent))}</b> wants to ${escapeHtml(summary)}\n\nRequest #${id}`;
        const messageId = await sendSystemHtml(this.env, identity.chatId, html, via, {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `ap:${id}:y` },
              { text: "❌ Reject", callback_data: `ap:${id}:n` },
            ],
          ],
        });
        if (messageId) await this.store.setApprovalMessage(id, messageId);
      },
    };
  }

  private async addTranscript(
    identity: Identity,
    discussionId: number | null,
    speaker: AgentId | "human",
    text: string,
    speakerName?: string,
    telegramId?: number,
  ): Promise<void> {
    const name = speakerName ?? (speaker === "human" ? "Founder" : AGENTS[speaker].name);
    const id = await this.store.addMessage(
      { chatId: identity.convId, discussionId, speaker, speakerName: name, text, createdAt: Date.now() },
      telegramId,
    );
    this.ctx.waitUntil(this.store.index(identity.convId, `msg:${id}`, `${name}: ${text}`, { kind: "message", speaker }));
  }

  /** Voice notes → text (Whisper); documents → Markdown saved for doc.read. */
  private async preprocess(msg: IncomingMessage, identity: Identity): Promise<IncomingMessage | null> {
    const via = identity.dmAgent;
    let text = msg.text;
    let viaVoice = false;

    if (msg.voiceFileId) {
      try {
        const { bytes } = await downloadFile(this.env, msg.voiceFileId, via);
        const heard = await speechToText(this.env.AI, bytes, this.callOptions(identity));
        if (!heard) {
          await sendSystem(this.env, identity.chatId, "🎙️ I couldn't hear anything in that voice note.", via);
          return null;
        }
        text = text ? `${text}\n${heard}` : heard;
        viaVoice = true;
      } catch (err) {
        console.error("voice note failed", err);
        await sendSystem(this.env, identity.chatId, "🎙️ I couldn't process that voice note.", via);
        return null;
      }
    }

    if (msg.document) {
      try {
        const { bytes } = await downloadFile(this.env, msg.document.fileId, via);
        const markdown = await toMarkdown(this.env.AI, msg.document.name, bytes, msg.document.mimeType);
        const id = await this.store.saveDocument(identity.convId, msg.document.name, markdown);
        const preview = markdown.replace(/\s+/g, " ").slice(0, 600);
        text += `\n[sent document "${msg.document.name}" (doc #${id}, ${markdown.length} characters; read it with doc.read). It starts: ${preview}…]`;
      } catch (err) {
        console.warn("document conversion failed", err);
        text += `\n[sent document "${msg.document.name}", which couldn't be read]`;
      }
    }

    return { ...msg, text: text.trim(), viaVoice: viaVoice || msg.viaVoice };
  }

  /** The image agents should see: the one just sent, or a recent one if Iris was asked about it. */
  private async imageFor(msg: IncomingMessage, agents: AgentId[]): Promise<string | undefined> {
    if (msg.imageFileId) return msg.imageFileId;
    if (!agents.includes("iris")) return undefined;
    const [fileId, at] = await Promise.all([this.ctx.storage.get<string>("lastImageFileId"), this.ctx.storage.get<number>("lastImageAt")]);
    return fileId && at && Date.now() - at < IMAGE_MEMORY_MS ? fileId : undefined;
  }

  private async loadImage(fileId: string, identity: Identity): Promise<string | undefined> {
    try {
      return await downloadAsDataUri(this.env, fileId, identity.dmAgent);
    } catch (err) {
      console.error("image download failed", err);
      return undefined;
    }
  }

  private broadcast(message: unknown): void {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // closed socket; the runtime cleans it up
      }
    }
  }

  private setState(agent: AgentId, state: AgentState): void {
    if (this.ctx.getWebSockets().length) this.broadcast({ type: "state", agent, state });
  }

  private async statusText(): Promise<string> {
    const plan = await this.ctx.storage.get<ActivePlan>("plan");
    const env = this.env;
    const line = (id: AgentId) => {
      const a = AGENTS[id];
      const token = botToken(env, id) ? "" : " (no bot token: posts via host)";
      const state = a.tier === "core" ? "active" : "💤 dormant until needed";
      return `${a.emoji} ${a.name}: ${a.role}, ${state}${token}`;
    };
    const on = (v: unknown) => (v ? "✅" : "❌");
    const running = plan
      ? `Running: ${plan.mode} (discussion #${plan.discussionId}), ${plan.posts}/${LIMITS.maxPostsPerDiscussion} posts used.`
      : "Nothing running.";
    return [
      "Core council:",
      ...CORE_AGENTS.map(line),
      "",
      "Specialists:",
      ...AGENT_IDS.filter((id) => !CORE_AGENTS.includes(id)).map(line),
      "",
      `Skills: web search ${on(env.FIRECRAWL_API_KEY || env.BRAVE_API_KEY)} · GitHub ${on(env.GITHUB_TOKEN)} · sandbox ${on(env.Sandbox)} · browser ${on(env.BROWSER)} · semantic memory ${on(env.VECTORIZE)} · AI Gateway ${on(env.AI_GATEWAY_ID)}`,
      `Live calls: ${on(env.PUBLIC_URL || env.MINIAPP_URL)}`,
      "",
      running,
    ].join("\n");
  }
}
