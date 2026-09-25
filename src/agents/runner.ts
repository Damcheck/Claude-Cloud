import { runChat, runVision, type CallOptions, type ChatMessage, type ChatResult, type ContentPart } from "../ai/workers-ai";
import { LIMITS } from "../config";
import { cleanReply } from "../council/text";
import { skillsFor, toolName, toolsFor } from "../skills/registry";
import { needsApproval, type Skill, type SkillContext } from "../skills/types";
import type { Mode, TranscriptMessage } from "../types";
import { agentContext } from "./context";
import { buildSystemPrompt, buildUserPrompt, type TurnKind } from "./prompts";
import { AGENTS } from "./registry";

export interface TurnRequest {
  mode: Mode;
  turn: TurnKind;
  topic: string;
  transcript: TranscriptMessage[];
  /** Replaces the mode/round instruction. */
  instruction?: string;
  /** The reply will be spoken: faster model, shorter, spoken style. */
  speaking?: boolean;
}

export class BudgetExceeded extends Error {
  constructor(agent: string) {
    super(`${agent} reached its daily token budget`);
  }
}

/** Collects token usage per model across one turn. */
class UsageMeter {
  private byModel = new Map<string, { p: number; c: number }>();
  add(model: string, r: ChatResult) {
    const u = this.byModel.get(model) ?? { p: 0, c: 0 };
    u.p += r.usage.promptTokens;
    u.c += r.usage.completionTokens;
    this.byModel.set(model, u);
  }
  async flush(ctx: SkillContext) {
    for (const [model, u] of this.byModel) await ctx.store.recordUsage(ctx.convId, ctx.agent, model, u.p, u.c);
  }
}

export async function checkBudget(ctx: SkillContext): Promise<void> {
  const budget = Number(ctx.env.DAILY_TOKEN_BUDGET_PER_AGENT) || 0;
  if (budget > 0 && (await ctx.store.tokensToday(ctx.agent)) >= budget) throw new BudgetExceeded(AGENTS[ctx.agent].name);
}

/** Runs one agent's turn. Returns the text to post, or null if the agent passed. */
export async function runAgentTurn(req: TurnRequest, ctx: SkillContext): Promise<string | null> {
  await checkBudget(ctx);
  const agent = AGENTS[ctx.agent];
  if (agent.kind === "vision") return runVisionTurn(req, ctx);

  const live = req.mode === "live";
  const [groupFacts, privateMemories, trackRecord, powers] = await Promise.all([
    ctx.store.groupFacts(ctx.sharedConvIds),
    ctx.store.agentMemories(ctx.agent),
    ctx.store.trackRecord(ctx.agent),
    agentContext(ctx.agent, ctx.env, ctx.store, ctx.convId, ctx.sharedConvIds, req.transcript),
  ]);

  // Models without vision get Iris's description of the image instead of the pixels.
  let imageNote = "";
  if (ctx.image && !agent.vision) {
    try {
      const described = await runVision(ctx.env.AI, AGENTS.iris.model, { task: "caption", image: ctx.image, maxTokens: 400 }, ctx.callOptions);
      imageNote = `The founder's image, as described by Iris: ${described}`;
    } catch (err) {
      console.warn("image description failed", err);
    }
  }

  // Live calls favour latency: no skills. Voice notes keep them.
  const skills = live ? [] : skillsFor(ctx.agent, ctx.env, { consultDepth: ctx.consultDepth });
  const promptInput = {
    agent: ctx.agent,
    mode: req.mode,
    turn: req.turn,
    topic: req.topic,
    transcript: req.transcript,
    groupFacts,
    privateMemories,
    skillSummaries: skills.map((s) => `${s.id}: ${s.description}`),
    instruction: req.instruction,
    speaking: req.speaking,
    trackRecord: trackRecord.right + trackRecord.wrong + trackRecord.open > 0 ? trackRecord : undefined,
    extraContext: [powers, imageNote].filter(Boolean).join("\n\n"),
  };
  const userText = buildUserPrompt(promptInput);
  const userContent: string | ContentPart[] =
    ctx.image && agent.vision ? [{ type: "text", text: userText }, { type: "image_url", image_url: { url: ctx.image } }] : userText;
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(promptInput) },
    { role: "user", content: userContent },
  ];

  const meter = new UsageMeter();
  const callOptions: CallOptions = { ...ctx.callOptions, metadata: { ...ctx.callOptions.metadata, agent: ctx.agent } };
  const maxTokens = req.speaking ? LIMITS.maxVoiceOutputTokens : LIMITS.maxOutputTokens;
  let model = req.speaking ? agent.voiceModel : agent.model;
  let usedFallback = false;

  /** One model call; switches to the backup model (once) on error or an empty answer. */
  const call = async (withTools: boolean): Promise<ChatResult> => {
    const tools = withTools ? toolsFor(ctx.agent, ctx.env, { consultDepth: ctx.consultDepth }) : undefined;
    try {
      const r = await runChat(ctx.env.AI, model, messages, { tools, maxTokens, ...callOptions });
      meter.add(model, r);
      if (r.text.trim() || r.toolCalls.length || usedFallback) return r;
      console.warn(`${agent.name}: empty answer from ${model}, trying backup`);
    } catch (err) {
      if (usedFallback) throw err;
      console.warn(`${agent.name}: ${model} failed, trying backup ${agent.fallbackModel}`, err);
    }
    usedFallback = true;
    model = agent.fallbackModel;
    const r = await runChat(ctx.env.AI, model, messages, { tools, maxTokens, ...callOptions });
    meter.add(model, r);
    return r;
  };

  try {
    const maxCalls = agent.tier === "specialist" ? LIMITS.maxToolCallsPerTurnSpecialist : LIMITS.maxToolCallsPerTurn;
    let toolCallsUsed = 0;
    let toolsEnabled = skills.length > 0;

    // Bounded tool loop: at most maxCalls skill calls, then one final answer without tools.
    for (let i = 0; i <= maxCalls; i++) {
      const offerTools = toolsEnabled && toolCallsUsed < maxCalls;
      let result: ChatResult;
      try {
        result = await call(offerTools);
      } catch (err) {
        if (!offerTools) throw err;
        // Some deployments reject the tools parameter; continue this agent without skills.
        console.warn(`${agent.name}: request with tools failed, retrying without`, err);
        toolsEnabled = false;
        continue;
      }
      if (!result.toolCalls.length || !offerTools) return cleanReply(ctx.agent, result.text);

      messages.push({ role: "assistant", content: result.text ?? "", tool_calls: result.toolCalls });
      for (const tc of result.toolCalls) {
        toolCallsUsed++;
        const output = await executeToolCall(skills, tc.function.name, tc.function.arguments, ctx);
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: output });
      }
    }
    return cleanReply(ctx.agent, (await call(false)).text);
  } finally {
    await meter.flush(ctx).catch((err) => console.warn("usage record failed", err));
  }
}

export function parseArgs(raw: string): Record<string, unknown> | null {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function executeToolCall(skills: Skill[], name: string, rawArgs: string, ctx: SkillContext): Promise<string> {
  const skill = skills.find((s) => toolName(s.id) === name);
  if (!skill) return `Unknown or not permitted skill: ${name}`;
  const args = parseArgs(rawArgs);
  if (!args) return "Arguments were not valid JSON.";
  if (needsApproval(skill, args)) {
    if (!ctx.hooks) return `Skill ${skill.id} needs the founder's approval, which isn't possible here.`;
    const summary = skill.describeCall?.(args) ?? `use ${skill.id}`;
    const id = await ctx.store.createApproval({ convId: ctx.convId, chatId: ctx.chatId, agent: ctx.agent, skill: skill.id, args, summary });
    await ctx.hooks.requestApproval(id, ctx.agent, summary);
    return `Approval request #${id} sent to the founder with ✅/❌ buttons. It runs automatically if they approve. Tell them briefly what you're asking for and why.`;
  }
  try {
    const out = await skill.run(args, ctx);
    return out.slice(0, LIMITS.maxSkillResultChars);
  } catch (err) {
    return `Skill ${skill.id} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Execute an approved skill call outside a model turn. */
export async function executeApproved(skill: Skill, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
  return (await skill.run(args, ctx)).slice(0, LIMITS.maxSkillResultChars);
}

/**
 * Iris: Moondream looks at the image with the founder's latest words as the question.
 * With no image but a link in the message, she screenshots the page instead.
 * If Moondream fails, Gemma 4 reads the image through the chat API.
 */
async function runVisionTurn(req: TurnRequest, ctx: SkillContext): Promise<string | null> {
  const lastHuman = [...req.transcript].reverse().find((m) => m.speaker === "human");
  const question = lastHuman?.text.replace(/\[sent an image\]/g, "").trim();

  if (!ctx.image) {
    const url = question?.match(/https?:\/\/\S+/)?.[0];
    const screenshot = skillsFor("iris", ctx.env).find((s) => s.id === "browser.screenshot");
    if (url && screenshot) return cleanReply("iris", await screenshot.run({ url }, ctx));
    return null;
  }

  const prompt = question
    ? `The user asks: "${question}". Describe exactly what is visible that is relevant: text, layout, objects, positions, and anything that looks wrong or unusual.`
    : "Describe this image in detail: text, layout, objects and positions, and anything that looks wrong or unusual.";
  const opts = { ...ctx.callOptions, metadata: { ...ctx.callOptions.metadata, agent: "iris" } };
  try {
    return cleanReply("iris", await runVision(ctx.env.AI, AGENTS.iris.model, { task: "query", image: ctx.image, prompt, maxTokens: 600 }, opts));
  } catch (err) {
    console.warn("Moondream failed, falling back to chat vision", err);
    const r = await runChat(
      ctx.env.AI,
      AGENTS.iris.fallbackModel,
      [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: ctx.image } }] }],
      { maxTokens: 600, ...opts },
    );
    await ctx.store.recordUsage(ctx.convId, "iris", AGENTS.iris.fallbackModel, r.usage.promptTokens, r.usage.completionTokens);
    return cleanReply("iris", r.text);
  }
}
