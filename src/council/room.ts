import { DurableObject } from "cloudflare:workers";
import { SPECIAL_INSTRUCTIONS } from "../agents/prompts";
import { AGENTS, AGENT_IDS, displayName, isAgentId } from "../agents/registry";
import { BudgetExceeded, CouncilFrozen, executeApproved, parseArgs, runAgentTurn } from "../agents/runner";
import { bytesToBase64, runChat, type CallOptions } from "../ai/workers-ai";
import { LIMITS, SYSTEM_MODELS } from "../config";
import { callOptions as jobCallOptions, sharedConvIds } from "../jobs/common";
import { extractGraph } from "../knowledge/graph";
import { MemoryStore, type Followup } from "../memory/store";
import { toMarkdown } from "../skills/builtin/docs";
import { followupInstruction } from "../skills/builtin/powers";
import { findSkillById } from "../skills/registry";
import type { SkillContext } from "../skills/types";
import { escapeHtml } from "../telegram/format";
import {
  answerCallback,
  botToken,
  downloadAsDataUri,
  downloadFile,
  editMessageHtml,
  sendAs,
  sendSystem,
  sendSystemHtml,
  sendTyping,
  sendVoiceAs,
} from "../telegram/api";
import type { AgentId, CallbackAction, Env, Identity, IncomingMessage, Mode, TranscriptMessage } from "../types";
import { verifyRoomToken } from "../voice/auth";
import { FluxSession } from "../voice/flux";
import { EnergyVad, mulawToPcm16, pcm16ToWav } from "../voice/phone";
import { estimateSpeechMs, phoneSpeechStream, speechStream, speechToText, voiceNote } from "../voice/speech";
import { chooseSpeakers, collectBids } from "./bids";
import { runSystemCommand, type CommandHost } from "./commands";
import { findCrux } from "./crux";
import { CONTRARIAN_INSTRUCTION, groupthink } from "./diversity";
import { makeHooks } from "./post";
import { route, routeLive, type Command, type Step } from "./router";

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
  /** Live call: speak into the call as well as posting to Telegram. */
  live: boolean;
}

interface QueuedAlert {
  topic: string;
  steps: Step[];
}

interface SocketInfo {
  kind: "web" | "phone";
  verified?: boolean;
  streamSid?: string;
}

type AgentState = "thinking" | "speaking" | "listening" | "dormant";

const IMAGE_MEMORY_MS = 3600_000;
const PHONE_RATE = 8000;
const WEB_RATE = 16000;

const HELP = `AI Council

Talk normally: the most relevant members reply. Voice notes get voice answers. DM any member's bot for one-on-one.

Discussions
/council /debate /brainstorm <topic> · /critic
/premortem <plan> · /decide <question> · /personas <idea>
/forecast <yes/no question> · /resolve <#> yes|no
/minutes · /brief (on|off)

Work that runs by itself
/mission <goal> [--budget 300k] [--days 3] · /missions · /mission_reply <#> <answer> · /mission_stop <#>
/research <topic> · /build <section> [--repo owner/name]
/watch <url|feed|owner/repo> [agent] [6h] · /watchers · /unwatch <#>

Records
/actions /claims /ideas /decisions /record /lessons /followups /graph <name>

Control
/autonomy · /freeze · /unfreeze · /dryrun on|off · /audit · /why [agent] · /stop
/cost · /models · /tools · /eval · /reflect · /scout · /selftest · /admin · /backup

Voice: /call (live room, or phone) · /voice on|off

Specialists wake up on their own: 💻 Cipher and 🏗️ Forge for code and architecture, 👁️ Iris for images and links.`;

/**
 * One instance per conversation (a group, or a DM with one agent). Serializes everything
 * that happens there.
 *
 * A single alarm drives the running discussion (one agent turn per tick), queued watcher
 * alerts, and the agents' self-scheduled follow-ups. Founder messages bump `generation`;
 * each turn re-checks it before posting, so a new message interrupts within one turn.
 */
export class CouncilRoom extends DurableObject<Env> {
  private store: MemoryStore;
  private flux = new Map<WebSocket, FluxSession>();
  private fluxOpening = new Set<WebSocket>();
  private fluxFailed = new Set<WebSocket>();
  private vads = new Map<WebSocket, EnergyVad>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new MemoryStore(env.DB, env.AI, env.VECTORIZE);
  }

  // =========================================================================
  // RPC entry points
  // =========================================================================

  async handleMessage(raw: IncomingMessage): Promise<void> {
    const identity = await this.remember(raw);
    const msg = await this.preprocess(raw, identity);
    if (!msg) return;
    if (msg.imageFileId) await this.ctx.storage.put({ lastImageFileId: msg.imageFileId, lastImageAt: Date.now() });

    const transcript = await this.store.recentMessages(identity.convId, LIMITS.transcriptWindow);
    const recentSpeakers = [...new Set(transcript.map((m) => m.speaker).reverse())].filter(isAgentId);
    await this.execute(route(msg, { recentSpeakers }), msg, identity);
  }

  async handleCallback(cb: CallbackAction): Promise<void> {
    const identity = await this.identity();
    if (!identity) return answerCallback(this.env, cb.viaAgent, cb.callbackId, "Unknown action.");
    const kg = /^kg:(\d+):(new|old)$/.exec(cb.data);
    if (kg) return this.settleConflict(cb, Number(kg[1]), kg[2] === "new");
    const m = /^ap:(\d+):([yn])$/.exec(cb.data);
    if (!m) return answerCallback(this.env, cb.viaAgent, cb.callbackId, "Unknown action.");

    const approval = await this.store.getApproval(Number(m[1]));
    if (!approval || approval.conv_id !== identity.convId) return answerCallback(this.env, cb.viaAgent, cb.callbackId, "Unknown request.");
    const approve = m[2] === "y";
    if (!(await this.store.decideApproval(approval.id, approve ? "approved" : "rejected"))) {
      return answerCallback(this.env, cb.viaAgent, cb.callbackId, "Already decided.");
    }
    const head = `${escapeHtml(displayName(approval.agent))}: ${escapeHtml(approval.summary.slice(0, 1500))}`;
    await this.addTranscript(identity, null, approval.agent, `[founder ${approve ? "approved" : "rejected"} request #${approval.id}: ${approval.summary.slice(0, 500)}]`);

    if (!approve) {
      await answerCallback(this.env, cb.viaAgent, cb.callbackId, "Rejected");
      if (approval.skill === "tools.activate") {
        const toolId = Number((parseArgs(approval.args_json) ?? {}).id);
        if (toolId) await this.store.ops.setToolStatus(toolId, "rejected", "Rejected by the founder.");
      }
      if (approval.skill === "persona.update") {
        const personaId = Number((parseArgs(approval.args_json) ?? {}).persona_id);
        if (personaId) await this.store.ops.setPersonaStatus(personaId, "rejected");
      }
      return editMessageHtml(this.env, cb.viaAgent, cb.chatId, cb.messageId, `❌ <b>Rejected</b>\n${head}`);
    }

    await answerCallback(this.env, cb.viaAgent, cb.callbackId, "Approved: running…");
    await editMessageHtml(this.env, cb.viaAgent, cb.chatId, cb.messageId, `⏳ <b>Approved, running…</b>\n${head}`);
    let result: string;
    try {
      const skill = await findSkillById(this.env, this.store, approval.skill);
      if (!skill) throw new Error(`skill ${approval.skill} is no longer available`);
      const transcript = await this.store.recentMessages(identity.convId, LIMITS.transcriptWindow);
      result = await executeApproved(skill, parseArgs(approval.args_json) ?? {}, this.skillContext(approval.agent, identity, transcript));
      await this.store.setApprovalResult(approval.id, "approved", result);
      await editMessageHtml(this.env, cb.viaAgent, cb.chatId, cb.messageId, `✅ <b>Done</b>\n${head}\n\n<pre>${escapeHtml(result.slice(0, 1500))}</pre>`);
    } catch (err) {
      result = `failed: ${err instanceof Error ? err.message : String(err)}`;
      await this.store.setApprovalResult(approval.id, "failed", result);
      await editMessageHtml(this.env, cb.viaAgent, cb.chatId, cb.messageId, `⚠️ <b>Failed</b>\n${head}\n\n${escapeHtml(result.slice(0, 800))}`);
    }
    if (["tools.activate", "persona.update", "model.swap"].includes(approval.skill)) return;

    const followUp = `The founder approved your request #${approval.id} (${approval.summary.slice(0, 300)}). Result: ${result.slice(0, 1500)}\nTell the founder in a sentence or two what happened and continue the task if there is a next step.`;
    // Work for a mission goes back to the mission; otherwise the agent picks it up here.
    if (approval.mission_id) {
      const mission = await this.store.ops.getMission(approval.mission_id);
      if (mission && ["running", "blocked"].includes(mission.status)) {
        await this.store.ops.addTasks(mission.id, [{ key: `ap${approval.id}`, title: `Continue after approval #${approval.id}`, detail: followUp, assignee: approval.agent, dependsOn: [] }]);
        return;
      }
    }
    if (!(await this.ctx.storage.get<ActivePlan>("plan"))) {
      await this.startPlan(identity, "direct", "", [{ agents: [identity.dmAgent ?? approval.agent], parallel: false, turn: "normal", instruction: followUp }]);
    }
  }

  /** Cron: the morning brief, with the watchers' digest (Nexus passes if there's nothing to say). */
  async startBrief(): Promise<void> {
    const identity = await this.identity();
    if (!identity || (await this.ctx.storage.get<ActivePlan>("plan")) || (await this.store.ops.isFrozen())) return;
    const digest = await this.store.ops.undeliveredDigest(sharedConvIds(this.env, identity.convId));
    await this.store.ops.markDigestDelivered(digest.map((d) => d.id));
    const extra = digest.length ? `\n\nInclude what members noticed since the last brief:\n${digest.map((d) => `- ${d.agent}: ${d.summary}`).join("\n")}` : "";
    await this.startPlan(identity, "direct", "daily brief", [{ agents: [identity.dmAgent ?? "nexus"], parallel: false, turn: "normal", instruction: SPECIAL_INSTRUCTIONS.brief + extra }]);
  }

  /** Cron: Monday planning and Friday retro. */
  async startRoutine(kind: "weekly_plan" | "weekly_retro"): Promise<void> {
    const identity = await this.identity();
    if (!identity || (await this.ctx.storage.get<ActivePlan>("plan")) || (await this.store.ops.isFrozen())) return;
    const instruction =
      kind === "weekly_plan"
        ? "It's Monday. Propose this week's 3-5 goals for the founder, based on running missions, open action items, decisions due for review, and last week's results. For each goal: why it matters and the first step. Ask the founder to confirm or change them."
        : "It's Friday: run the weekly retro. What shipped this week (missions, action items done), which predictions and decisions were resolved and what we learned, what slipped and why, and one thing to change next week. Be honest and brief.";
    await this.startPlan(identity, "direct", kind === "weekly_plan" ? "weekly plan" : "weekly retro", [{ agents: [identity.dmAgent ?? "nexus"], parallel: false, turn: "normal", instruction }]);
  }

  /** Re-arm the alarm (used by skills and jobs that schedule follow-ups). */
  async poke(): Promise<void> {
    await this.scheduleNext();
  }

  /** Watchers: let an agent (or a sequence of agents) speak now, or right after the current discussion. */
  async alert(identity: Identity, topic: string, steps: Step[]): Promise<void> {
    const known = (await this.identity()) ?? identity;
    if (!(await this.identity())) {
      await this.ctx.storage.put("identity", identity);
      await this.store.upsertChat(identity.convId, identity.chatId, identity.dmAgent);
    }
    if (await this.ctx.storage.get<ActivePlan>("plan")) {
      const queue = (await this.ctx.storage.get<QueuedAlert[]>("alerts")) ?? [];
      queue.push({ topic, steps });
      await this.ctx.storage.put("alerts", queue.slice(-10));
      await this.scheduleNext();
      return;
    }
    await this.startPlan(known, "direct", topic, steps);
  }

  /** WebSocket upgrade: live voice room (browser / Mini App) or a phone call (Twilio). */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const identity = await this.identity();
    if (!identity) return new Response("This room has no conversation yet. Send a message in the chat first.", { status: 404 });
    const kind = request.headers.get("x-socket-kind") === "phone" ? "phone" : "web";
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [kind]);
    server.serializeAttachment({ kind } satisfies SocketInfo);
    if (kind === "web") {
      server.send(
        JSON.stringify({
          type: "hello",
          streaming: true,
          agents: AGENT_IDS.filter((id) => !identity.dmAgent || id === identity.dmAgent).map((id) => ({
            id,
            name: AGENTS[id].name,
            emoji: AGENTS[id].emoji,
            role: AGENTS[id].role,
            state: AGENTS[id].tier === "core" || id === identity.dmAgent ? "listening" : "dormant",
          })),
        }),
      );
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const identity = await this.identity();
    if (!identity) return;
    const info = (ws.deserializeAttachment() ?? { kind: "web" }) as SocketInfo;
    if (info.kind === "phone") return this.phoneMessage(ws, info, identity, message);

    if (typeof message !== "string") {
      const bytes = new Uint8Array(message);
      const isWav = bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF";
      if (isWav) return this.utterance(identity, bytes, ws);
      await this.streamAudio(ws, identity, message, WEB_RATE);
      return;
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
      case "played":
        return this.playbackDone();
      case "say":
        if (data.text?.trim()) return this.handleLive(identity, data.text.trim());
        return;
      case "stream_stop":
        this.flux.get(ws)?.close();
        this.flux.delete(ws);
        return;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.flux.get(ws)?.close();
    this.flux.delete(ws);
    this.vads.delete(ws);
    this.fluxFailed.delete(ws);
    // Last listener left the call: stop talking into the void. The closing socket may
    // still be listed while this handler runs, so count only the others that are open.
    const others = this.ctx.getWebSockets().filter((s) => s !== ws && s.readyState === WebSocket.OPEN);
    if (others.length === 0) {
      const plan = await this.ctx.storage.get<ActivePlan>("plan");
      if (plan?.live) await this.interrupt("stopped");
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
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
    } else if (identity && !(await this.store.ops.isFrozen())) {
      const queue = (await this.ctx.storage.get<QueuedAlert[]>("alerts")) ?? [];
      const next = queue.shift();
      if (next) {
        await this.ctx.storage.put("alerts", queue);
        await this.startPlan(identity, "direct", next.topic, next.steps);
      } else {
        const [due] = await this.store.dueFollowups(identity.convId, now, 1);
        if (due) await this.startFollowup(due, identity);
      }
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
        return runSystemCommand(this.commandHost(identity), command.name, command.arg).catch((err) =>
          sendSystem(this.env, identity.chatId, `⚠️ /${command.name} failed: ${err instanceof Error ? err.message : String(err)}`, via),
        );
      case "brief_toggle":
        await this.store.setChatFlag(identity.convId, "brief_enabled", command.on);
        return sendSystem(this.env, identity.chatId, command.on ? "☀️ Nexus will post a brief every morning, plan the week on Mondays and run a retro on Fridays." : "Daily brief and weekly routine off.", via);
      case "stop": {
        const had = await this.interrupt("stopped");
        await this.scheduleNext();
        return sendSystem(this.env, identity.chatId, had ? "⏹ Discussion stopped." : "Nothing is running.", via);
      }
      case "discuss": {
        if (await this.store.ops.isFrozen()) {
          return sendSystem(this.env, identity.chatId, "🧊 The council is frozen. /unfreeze to talk again.", via);
        }
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

  private commandHost(identity: Identity): CommandHost {
    return {
      env: this.env,
      store: this.store,
      identity,
      sharedConvIds: sharedConvIds(this.env, identity.convId),
      startPlan: async (mode, topic, steps) => {
        // Like any founder message, a command that starts a discussion interrupts the current one.
        await this.interrupt("interrupted");
        await this.startPlan(identity, mode, topic, steps);
      },
      interrupt: (status) => this.interrupt(status),
      recentImage: async () => {
        const [fileId, at] = await Promise.all([this.ctx.storage.get<string>("lastImageFileId"), this.ctx.storage.get<number>("lastImageAt")]);
        return fileId && at && Date.now() - at < IMAGE_MEMORY_MS ? fileId : undefined;
      },
    };
  }

  private async handleLive(identity: Identity, text: string): Promise<void> {
    if (await this.store.ops.isFrozen()) return;
    const msg: IncomingMessage = { chatId: identity.chatId, convId: identity.convId, messageId: 0, fromId: 0, fromName: "Founder", text, viaVoice: true, dmAgent: identity.dmAgent };
    // Keep the Telegram chat as the single transcript of the call.
    void sendSystem(this.env, identity.chatId, `🎙️ ${text}`, identity.dmAgent).catch(() => {});
    await this.interrupt("interrupted");
    const command = identity.dmAgent
      ? ({ kind: "discuss", mode: "live", topic: "", agents: [identity.dmAgent], steps: [{ agents: [identity.dmAgent], parallel: false, turn: "normal" }] } as const)
      : routeLive(msg);
    if (command.kind !== "discuss") return;
    const discussionId = await this.store.createDiscussion(identity.convId, "live", "");
    await this.addTranscript(identity, discussionId, "human", text, "Founder (call)");
    await this.startPlan(identity, "live", "", command.steps.map((s) => ({ ...s, agents: [...s.agents] })), { discussionId, voiceReplies: false, live: true });
  }

  private async settleConflict(cb: CallbackAction, id: number, useNew: boolean): Promise<void> {
    const c = await this.store.ops.getConflict(id);
    if (!c || !(await this.store.ops.settleConflict(id, useNew ? "used_new" : "kept_old"))) {
      return answerCallback(this.env, cb.viaAgent, cb.callbackId, "Already settled.");
    }
    if (useNew) await this.store.ops.addFact(c.entity_id, c.attribute, c.new_value, `${c.source} (confirmed by founder)`);
    await answerCallback(this.env, cb.viaAgent, cb.callbackId, useNew ? "Updated" : "Kept");
    await editMessageHtml(this.env, cb.viaAgent, cb.chatId, cb.messageId, `🕸️ ${escapeHtml(c.attribute)}: ${useNew ? `now “${escapeHtml(c.new_value)}”` : "kept the old value"} ✓`);
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
    await this.startPlan(identity, "direct", `follow-up #${f.id}`, [{ agents: [agent], parallel: false, turn: "normal", instruction: relay + followupInstruction(f.kind, f.note) }]);
  }

  /** Executes the next step: one agent (sequential), a blind round (parallel), live bidding, or crux finding. */
  private async runStep(plan: ActivePlan, identity: Identity): Promise<void> {
    this.enforceBudget(plan);
    const step = plan.steps[0];
    if (!step) return this.finish(plan, identity);
    const transcript = await this.store.recentMessages(identity.convId, LIMITS.transcriptWindow);

    if (step.bid) return this.runBids(plan, step, transcript, identity);
    if (step.crux) return this.runCrux(plan, identity);

    const agents = step.parallel ? step.agents : step.agents.slice(0, 1);
    const image = plan.imageFileId ? await this.loadImage(plan.imageFileId, identity) : undefined;
    const speaking = plan.voiceReplies || plan.live;
    const turn = (agent: AgentId, instruction = step.instruction) =>
      runAgentTurn(
        { mode: plan.mode, turn: step.turn, topic: plan.topic, transcript, instruction, speaking },
        { ...this.skillContext(agent, identity, transcript, image), discussionId: plan.discussionId },
      );

    for (const a of agents) {
      this.setState(a, "thinking");
      void sendTyping(this.env, identity.dmAgent ?? a, identity.chatId, plan.voiceReplies ? "record_voice" : "typing");
    }
    const replies = await Promise.all(
      agents.map(async (agent) => {
        try {
          return { agent, text: await turn(agent), notice: null as string | null };
        } catch (err) {
          console.error(`${agent} turn failed`, err);
          const notice =
            err instanceof BudgetExceeded ? `💸 ${displayName(agent)} hit its daily token budget.` : err instanceof CouncilFrozen ? null : `⚠️ ${displayName(agent)} couldn't respond.`;
          return { agent, text: null, notice };
        }
      }),
    );

    // Groupthink guard: if the blind round came back nearly identical, the most typical
    // member argues the other side instead.
    if (step.parallel && step.turn === "blind") {
      const answered = replies.filter((r) => r.text);
      const check = await groupthink(this.env.AI, answered.map((r) => r.text!)).catch(() => null);
      if (check) {
        const target = answered[check.typical]!;
        const contrarian = await turn(target.agent, CONTRARIAN_INSTRUCTION).catch(() => null);
        if (contrarian) target.text = contrarian;
      }
    }

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
    await this.advance(plan, identity, replies.map((r) => r.text).filter(Boolean).pop() ?? "");
  }

  private async runBids(plan: ActivePlan, step: Step, transcript: TranscriptMessage[], identity: Identity): Promise<void> {
    step.agents.forEach((a) => this.setState(a, "thinking"));
    const bids = await collectBids(this.env.AI, this.store, step.agents, transcript, this.callOptions(identity), identity.convId);
    if (plan.generation !== (await this.generation())) return;
    const lastHuman = [...transcript].reverse().find((m) => m.speaker === "human")?.text ?? "";
    const winners = chooseSpeakers(bids, lastHuman);
    step.agents.filter((a) => !winners.includes(a)).forEach((a) => this.setState(a, "listening"));
    if (!winners.length) return this.finish(plan, identity);
    plan.steps[0] = { agents: winners, parallel: false, turn: "normal" };
    await this.ctx.storage.put({ plan, planDueAt: Date.now() });
  }

  private async runCrux(plan: ActivePlan, identity: Identity): Promise<void> {
    plan.steps.shift();
    const crux = await findCrux(this.env, this.store, identity, plan.discussionId).catch(() => null);
    if (plan.generation !== (await this.generation())) return;
    if (crux) {
      await this.post(plan, identity, "nexus", `🔎 **Crux:** ${crux.crux}${crux.empirical ? "\nSage is checking the evidence before the next round." : ""}`);
      if (crux.empirical && !identity.dmAgent) {
        plan.steps.unshift({
          agents: ["sage"],
          parallel: false,
          turn: "normal",
          instruction: `The council's disagreement comes down to this question: "${crux.crux}". Research it now (web.search, web.fetch), record what you verify with claims.record, and report the evidence in a few lines, citing sources. Don't take sides beyond what the evidence shows.`,
        });
      }
    }
    await this.advance(plan, identity, "");
  }

  private async advance(plan: ActivePlan, identity: Identity, lastText: string): Promise<void> {
    if (plan.generation !== (await this.generation())) return;
    this.enforceBudget(plan);
    if (!plan.steps.length) return this.finish(plan, identity);
    // Live: wait for the client to report the audio finished (with a timeout); otherwise a short pause.
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
      await Promise.all([this.speakToWeb(plan, identity, agent, text), this.speakToPhones(plan, identity, agent, text)]);
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

  private async speakToWeb(plan: ActivePlan, identity: Identity, agent: AgentId, text: string): Promise<void> {
    if (!this.ctx.getWebSockets("web").length) return;
    try {
      let seq = 0;
      for await (const chunk of speechStream(this.env.AI, agent, text, this.callOptions(identity))) {
        if (plan.generation !== (await this.generation())) return;
        this.broadcast({ type: "speak", agent, seq: seq++, text: chunk.text, audio: chunk.audioB64 });
      }
    } catch (err) {
      console.error("live speech failed", err);
    }
  }

  private async speakToPhones(plan: ActivePlan, identity: Identity, agent: AgentId, text: string): Promise<void> {
    const phones = this.ctx.getWebSockets("phone").filter((ws) => (ws.deserializeAttachment() as SocketInfo | null)?.verified);
    if (!phones.length) return;
    try {
      for await (const audio of phoneSpeechStream(this.env.AI, agent, text, this.callOptions(identity))) {
        if (plan.generation !== (await this.generation())) return;
        for (const ws of phones) {
          const sid = (ws.deserializeAttachment() as SocketInfo).streamSid;
          ws.send(JSON.stringify({ event: "media", streamSid: sid, media: { payload: bytesToBase64(audio) } }));
        }
      }
      for (const ws of phones) {
        const sid = (ws.deserializeAttachment() as SocketInfo).streamSid;
        ws.send(JSON.stringify({ event: "mark", streamSid: sid, mark: { name: agent } }));
      }
    } catch (err) {
      console.error("phone speech failed", err);
    }
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

  /** Condense a finished discussion into long-term memory and the knowledge graph. */
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

      const conflicts = await extractGraph(this.env, this.store, identity, `${summary}\n\n${text}`, `discussion #${discussionId}`);
      for (const c of conflicts.slice(0, 3)) {
        await sendSystemHtml(
          this.env,
          identity.chatId,
          `🕸️ Conflicting info about <b>${escapeHtml(c.entity)}</b> — ${escapeHtml(c.attribute)}:\nbefore: “${escapeHtml(c.oldValue)}”\nnow: “${escapeHtml(c.newValue)}”\nWhich is right?`,
          identity.dmAgent,
          {
            inline_keyboard: [
              [
                { text: "Use the new one", callback_data: `kg:${c.id}:new` },
                { text: "Keep the old one", callback_data: `kg:${c.id}:old` },
              ],
            ],
          },
        );
      }
    } catch (err) {
      console.warn("summary / graph extraction failed", err);
    }
  }

  /** Bump the generation and end the running plan. Returns true if something was running. */
  private async interrupt(status: "stopped" | "interrupted"): Promise<boolean> {
    await this.ctx.storage.put("generation", (await this.generation()) + 1);
    const plan = await this.ctx.storage.get<ActivePlan>("plan");
    if (!plan) return false;
    await this.store.endDiscussion(plan.discussionId, status, plan.posts);
    await this.ctx.storage.delete(["plan", "planDueAt"]);
    if (plan.live) {
      this.broadcast({ type: "interrupted" });
      for (const ws of this.ctx.getWebSockets("phone")) {
        const sid = (ws.deserializeAttachment() as SocketInfo | null)?.streamSid;
        if (sid) ws.send(JSON.stringify({ event: "clear", streamSid: sid }));
      }
    }
    return true;
  }

  private async playbackDone(): Promise<void> {
    const plan = await this.ctx.storage.get<ActivePlan>("plan");
    if (plan?.live) {
      await this.ctx.storage.put("planDueAt", Date.now());
      await this.scheduleNext();
    }
  }

  /** One alarm serves the plan, queued alerts and follow-ups: set it to whichever is due first. */
  private async scheduleNext(): Promise<void> {
    const identity = await this.identity();
    const plan = await this.ctx.storage.get<ActivePlan>("plan");
    const planDue = plan ? await this.ctx.storage.get<number>("planDueAt") : undefined;
    const alerts = (await this.ctx.storage.get<QueuedAlert[]>("alerts")) ?? [];
    const followupDue = identity ? await this.store.nextFollowupAt(identity.convId) : null;
    const candidates: number[] = [];
    if (planDue !== undefined) candidates.push(planDue);
    if (!plan && alerts.length) candidates.push(Date.now());
    if (!plan && followupDue !== null) candidates.push(followupDue);
    // While a plan runs, alerts and follow-ups wait; check again shortly after it ends.
    if (plan && planDue === undefined && (alerts.length || followupDue !== null)) candidates.push(Date.now() + 60_000);
    if (!candidates.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now(), Math.min(...candidates)));
  }

  // =========================================================================
  // Voice input
  // =========================================================================

  /** A whole utterance as WAV (browser VAD mode or phone fallback). */
  private async utterance(identity: Identity, wav: Uint8Array, ws?: WebSocket): Promise<void> {
    if (wav.byteLength < 2000 || wav.byteLength > 4 * 1024 * 1024) return;
    let text = "";
    try {
      text = await speechToText(this.env.AI, wav, this.callOptions(identity));
    } catch (err) {
      console.error("transcription failed", err);
      ws?.send(JSON.stringify({ type: "error", message: "Couldn't transcribe that." }));
      return;
    }
    if (text.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return;
    this.broadcast({ type: "heard", text });
    return this.handleLive(identity, text);
  }

  /** Streaming PCM into Flux, which reports turns itself. Returns false if Flux isn't available. */
  private async streamAudio(ws: WebSocket, identity: Identity, pcm: ArrayBuffer | Uint8Array, rate: number): Promise<boolean> {
    if (this.fluxFailed.has(ws)) return false;
    const existing = this.flux.get(ws);
    if (existing?.open) {
      existing.send(pcm);
      return true;
    }
    // Frames that arrive while the connection opens are dropped (a few ms of audio).
    if (this.fluxOpening.has(ws)) return true;
    this.fluxOpening.add(ws);
    const session = await FluxSession.open(this.env.AI, rate, (e) => {
      if (e.type === "start") {
        void this.ctx.storage.get<ActivePlan>("plan").then((plan) => (plan?.live ? this.interrupt("interrupted") : undefined));
      } else {
        this.broadcast({ type: "heard", text: e.transcript });
        void this.handleLive(identity, e.transcript);
      }
    });
    this.fluxOpening.delete(ws);
    if (!session) {
      this.fluxFailed.add(ws);
      const info = ws.deserializeAttachment() as SocketInfo | null;
      if (info?.kind === "web") ws.send(JSON.stringify({ type: "stream_unavailable" }));
      return false;
    }
    this.flux.set(ws, session);
    session.send(pcm);
    return true;
  }

  private async phoneMessage(ws: WebSocket, info: SocketInfo, identity: Identity, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let msg: { event?: string; start?: { streamSid?: string; customParameters?: Record<string, string> }; media?: { payload?: string }; mark?: { name?: string } };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    switch (msg.event) {
      case "start": {
        const token = msg.start?.customParameters?.token ?? "";
        const convId = await verifyRoomToken(this.env.TELEGRAM_WEBHOOK_SECRET, token);
        if (convId !== identity.convId) {
          ws.close(1008, "unauthorized");
          return;
        }
        ws.serializeAttachment({ kind: "phone", verified: true, streamSid: msg.start?.streamSid } satisfies SocketInfo);
        void sendSystem(this.env, identity.chatId, "📞 The founder joined by phone.", identity.dmAgent).catch(() => {});
        return;
      }
      case "media": {
        if (!info.verified || !msg.media?.payload) return;
        const bytes = Uint8Array.from(atob(msg.media.payload), (c) => c.charCodeAt(0));
        const pcm = mulawToPcm16(bytes);
        if (await this.streamAudio(ws, identity, new Uint8Array(pcm.buffer), PHONE_RATE)) return;
        // Flux unavailable: server-side VAD + Whisper.
        let vad = this.vads.get(ws);
        if (!vad) {
          vad = new EnergyVad(PHONE_RATE);
          this.vads.set(ws, vad);
        }
        const plan = await this.ctx.storage.get<ActivePlan>("plan");
        const event = vad.push(pcm, plan?.live ? 2.5 : 1);
        if (event?.type === "start" && plan?.live) await this.interrupt("interrupted");
        if (event?.type === "end") await this.utterance(identity, pcm16ToWav(event.audio, PHONE_RATE));
        return;
      }
      case "mark":
        return this.playbackDone();
      case "stop":
        this.flux.get(ws)?.close();
        this.flux.delete(ws);
        this.vads.delete(ws);
        return;
    }
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

  private callOptions(identity: Identity): CallOptions {
    return jobCallOptions(this.env, identity.convId);
  }

  private skillContext(agent: AgentId, identity: Identity, transcript: TranscriptMessage[], image?: string): SkillContext {
    return {
      env: this.env,
      store: this.store,
      convId: identity.convId,
      chatId: identity.chatId,
      agent,
      sharedConvIds: sharedConvIds(this.env, identity.convId),
      image,
      transcript,
      consultDepth: 0,
      callOptions: this.callOptions(identity),
      hooks: makeHooks(this.env, this.store, identity, () => this.scheduleNext()),
      loopback: this.ctx.exports,
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
    const id = await this.store.addMessage({ chatId: identity.convId, discussionId, speaker, speakerName: name, text, createdAt: Date.now() }, telegramId);
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
    for (const ws of this.ctx.getWebSockets("web")) {
      try {
        ws.send(data);
      } catch {
        // closed socket; the runtime cleans it up
      }
    }
  }

  private setState(agent: AgentId, state: AgentState): void {
    if (this.ctx.getWebSockets("web").length) this.broadcast({ type: "state", agent, state });
  }

  private async statusText(): Promise<string> {
    const plan = await this.ctx.storage.get<ActivePlan>("plan");
    const env = this.env;
    const frozen = await this.store.ops.isFrozen();
    const line = (id: AgentId) => {
      const a = AGENTS[id];
      const token = botToken(env, id) ? "" : " (no bot token: posts via host)";
      const state = a.tier === "core" ? "active" : "💤 dormant until needed";
      return `${a.emoji} ${a.name}: ${a.role}, ${state}${token}`;
    };
    const on = (v: unknown) => (v ? "✅" : "❌");
    const running = plan ? `Running: ${plan.mode} (discussion #${plan.discussionId}), ${plan.posts}/${LIMITS.maxPostsPerDiscussion} posts used.` : "Nothing running.";
    return [
      frozen ? "🧊 FROZEN (/unfreeze)\n" : "",
      "Core council:",
      ...AGENT_IDS.filter((id) => AGENTS[id].tier === "core").map(line),
      "",
      "Specialists:",
      ...AGENT_IDS.filter((id) => AGENTS[id].tier !== "core").map(line),
      "",
      `Skills: web search ${on(env.FIRECRAWL_API_KEY || env.BRAVE_API_KEY)} · GitHub ${on(env.GITHUB_TOKEN)} · sandbox ${on(env.Sandbox)} · browser ${on(env.BROWSER)} · memory search ${on(env.VECTORIZE)} · MCP ${on(env.MCP_SERVERS)} · custom tools ${on(env.LOADER)}`,
      `Jobs ${on(env.JOBS)} · AI Gateway ${on(env.AI_GATEWAY_ID)} · backups ${on(env.BACKUPS)} · calls ${on(env.PUBLIC_URL || env.MINIAPP_URL)} · phone ${on(env.TWILIO_AUTH_TOKEN)}`,
      "",
      running,
    ]
      .filter((l, i) => l !== "" || i > 0)
      .join("\n");
  }
}

