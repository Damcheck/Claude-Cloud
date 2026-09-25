import { DurableObject } from "cloudflare:workers";
import { AGENTS, AGENT_IDS, CORE_AGENTS, displayName, isAgentId } from "../agents/registry";
import { runAgentTurn } from "../agents/runner";
import { LIMITS } from "../config";
import { MemoryStore } from "../memory/store";
import { botToken, downloadAsDataUri, sendAs, sendSystem, sendTyping } from "../telegram/api";
import type { AgentId, Env, IncomingMessage, Mode, TranscriptMessage } from "../types";
import { route, type Step } from "./router";

/** The discussion currently being played out in this chat. */
interface ActivePlan {
  generation: number;
  discussionId: number;
  chatId: number;
  mode: Mode;
  topic: string;
  steps: Step[];
  posts: number;
}

const HELP = `AI Council commands

Just talk — the most relevant members reply.
@Atlas / "Nova, ..." / reply to a member — only they answer.
/council <topic> — all 5 core members think independently, then debate, then Nexus summarizes.
/debate <topic> — ${LIMITS.debateRounds} rounds of argument.
/brainstorm <topic> — cooperative idea generation.
/critic — everyone attacks the current idea.
/stop — end the current discussion.
/status — who's here and what's running.

Specialists wake up on their own: 💻 Cipher and 🏗️ Forge for code and architecture, 👁️ Iris when you send an image.`;

/**
 * One instance per Telegram chat. Serializes everything that happens in that chat.
 *
 * Human messages bump `generation`; each agent turn runs in its own alarm() and
 * re-checks the generation before posting, so a new human message interrupts the
 * running discussion within one turn.
 */
export class CouncilRoom extends DurableObject<Env> {
  private store: MemoryStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new MemoryStore(env.DB);
  }

  private async generation(): Promise<number> {
    return (await this.ctx.storage.get<number>("generation")) ?? 0;
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    if (msg.imageFileId) await this.ctx.storage.put("lastImageFileId", msg.imageFileId);

    const transcript = await this.store.recentMessages(msg.chatId, LIMITS.transcriptWindow);
    const recentSpeakers = [...new Set(transcript.map((m) => m.speaker).reverse())].filter(isAgentId);
    const command = route(msg, { recentSpeakers });

    const previous = await this.ctx.storage.get<ActivePlan>("plan");
    if (command.kind === "status") return sendSystem(this.env, msg.chatId, await this.statusText(previous));
    if (command.kind === "help") return sendSystem(this.env, msg.chatId, HELP);

    // Anything else the human says interrupts whatever is running.
    const generation = (await this.generation()) + 1;
    await this.ctx.storage.put("generation", generation);
    if (previous) {
      await this.store.endDiscussion(previous.discussionId, command.kind === "stop" ? "stopped" : "interrupted", previous.posts);
      await this.ctx.storage.delete("plan");
    }

    const human: TranscriptMessage = {
      chatId: msg.chatId,
      discussionId: null,
      speaker: "human",
      speakerName: msg.fromName,
      text: msg.imageFileId ? `${msg.text} [sent an image]`.trim() : msg.text,
      createdAt: Date.now(),
    };

    switch (command.kind) {
      case "stop":
        await this.ctx.storage.deleteAlarm();
        await sendSystem(this.env, msg.chatId, previous ? "⏹ Discussion stopped." : "Nothing is running.");
        return;
      case "discuss": {
        const discussionId = await this.store.createDiscussion(msg.chatId, command.mode, command.topic);
        human.discussionId = discussionId;
        await this.store.addMessage(human, msg.messageId);
        const plan: ActivePlan = {
          generation,
          discussionId,
          chatId: msg.chatId,
          mode: command.mode,
          topic: command.topic,
          steps: command.steps.filter((s) => s.agents.length > 0),
          posts: 0,
        };
        await this.ctx.storage.put("plan", plan);
        await this.ctx.storage.setAlarm(Date.now());
        return;
      }
    }
  }

  /** Executes the next step of the active plan: one agent (sequential) or a whole blind round (parallel). */
  async alarm(): Promise<void> {
    const plan = await this.ctx.storage.get<ActivePlan>("plan");
    if (!plan || plan.generation !== (await this.generation())) return;

    this.enforceBudget(plan);
    const step = plan.steps[0];
    if (!step) return this.finish(plan);

    const agents = step.parallel ? step.agents : step.agents.slice(0, 1);
    const transcript = await this.store.recentMessages(plan.chatId, LIMITS.transcriptWindow);
    const image = agents.includes("iris") ? await this.loadImage() : undefined;

    for (const a of agents) void sendTyping(this.env, a, plan.chatId);
    const replies = await Promise.all(
      agents.map(async (agent) => {
        try {
          const text = await runAgentTurn(
            { mode: plan.mode, turn: step.turn, topic: plan.topic, transcript },
            { env: this.env, store: this.store, chatId: plan.chatId, agent, image },
          );
          return { agent, text };
        } catch (err) {
          console.error(`${agent} turn failed`, err);
          return { agent, text: null, error: true };
        }
      }),
    );

    for (const r of replies) {
      // A human spoke while we were thinking: drop this discussion's remaining output.
      if (plan.generation !== (await this.generation())) return;
      if (r.text && plan.posts < LIMITS.maxPostsPerDiscussion) await this.post(plan, r.agent, r.text);
      else if ("error" in r) await sendSystem(this.env, plan.chatId, `⚠️ ${displayName(r.agent)} couldn't respond.`).catch(() => {});
    }

    if (step.parallel) plan.steps.shift();
    else {
      step.agents.shift();
      if (!step.agents.length) plan.steps.shift();
    }

    if (plan.generation !== (await this.generation())) return;
    this.enforceBudget(plan);
    if (!plan.steps.length) return this.finish(plan);
    await this.ctx.storage.put("plan", plan);
    await this.ctx.storage.setAlarm(Date.now() + LIMITS.cooldownMs);
  }

  /** Near the post budget, skip ahead to the summary (if any) so a long debate still ends cleanly. */
  private enforceBudget(plan: ActivePlan): void {
    const hasSummary = plan.steps.some((s) => s.turn === "summary");
    const reserve = hasSummary ? 1 : 0;
    if (plan.posts >= LIMITS.maxPostsPerDiscussion - reserve) {
      plan.steps = plan.posts < LIMITS.maxPostsPerDiscussion ? plan.steps.filter((s) => s.turn === "summary") : [];
    }
  }

  private async post(plan: ActivePlan, agent: AgentId, text: string): Promise<void> {
    const telegramId = await sendAs(this.env, agent, plan.chatId, text);
    plan.posts++;
    await this.store.addMessage(
      {
        chatId: plan.chatId,
        discussionId: plan.discussionId,
        speaker: agent,
        speakerName: AGENTS[agent].name,
        text,
        createdAt: Date.now(),
      },
      telegramId,
    );
  }

  private async finish(plan: ActivePlan): Promise<void> {
    await this.store.endDiscussion(plan.discussionId, "done", plan.posts);
    await this.ctx.storage.delete("plan");
    if (plan.posts === 0 && plan.mode !== "chat") {
      await sendSystem(this.env, plan.chatId, "The council had nothing to add.");
    }
  }

  private async loadImage(): Promise<string | undefined> {
    const fileId = await this.ctx.storage.get<string>("lastImageFileId");
    if (!fileId) return undefined;
    try {
      return await downloadAsDataUri(this.env, fileId);
    } catch (err) {
      console.error("image download failed", err);
      return undefined;
    }
  }

  private async statusText(plan: ActivePlan | undefined): Promise<string> {
    const line = (id: AgentId) => {
      const a = AGENTS[id];
      const token = botToken(this.env, id) ? "" : " (no bot token — posts via host)";
      const state = a.tier === "core" ? "active" : "💤 dormant until needed";
      return `${a.emoji} ${a.name} — ${a.role}, ${state}${token}`;
    };
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
      running,
    ].join("\n");
  }
}
