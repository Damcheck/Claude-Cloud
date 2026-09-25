import { runChat, runVision, type ChatMessage } from "../ai/workers-ai";
import { LIMITS } from "../config";
import { cleanReply } from "../council/text";
import { findSkillByToolName, skillsFor, toolsFor } from "../skills/registry";
import type { SkillContext } from "../skills/types";
import type { Mode, TranscriptMessage } from "../types";
import { buildSystemPrompt, buildUserPrompt, type TurnKind } from "./prompts";
import { AGENTS } from "./registry";

export interface TurnRequest {
  mode: Mode;
  turn: TurnKind;
  topic: string;
  transcript: TranscriptMessage[];
}

/** Runs one agent's turn. Returns the text to post, or null if the agent passed. */
export async function runAgentTurn(req: TurnRequest, ctx: SkillContext): Promise<string | null> {
  const agent = AGENTS[ctx.agent];
  if (agent.kind === "vision") return runVisionTurn(req, ctx);

  const [groupFacts, privateMemories] = await Promise.all([
    ctx.store.groupFacts(ctx.chatId),
    ctx.store.agentMemories(ctx.chatId, ctx.agent),
  ]);
  const promptInput = {
    agent: ctx.agent,
    mode: req.mode,
    turn: req.turn,
    topic: req.topic,
    transcript: req.transcript,
    groupFacts,
    privateMemories,
    skillSummaries: skillsFor(ctx.agent).map((s) => `${s.id}: ${s.description}`),
  };
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(promptInput) },
    { role: "user", content: buildUserPrompt(promptInput) },
  ];

  let tools = toolsFor(ctx.agent);
  let toolCallsUsed = 0;

  // Bounded tool loop: at most maxToolCallsPerTurn calls, then one final answer without tools.
  for (let i = 0; i <= LIMITS.maxToolCallsPerTurn; i++) {
    const offerTools = tools.length > 0 && toolCallsUsed < LIMITS.maxToolCallsPerTurn;
    let result;
    try {
      result = await runChat(ctx.env.AI, agent.model, messages, {
        tools: offerTools ? tools : undefined,
        maxTokens: LIMITS.maxOutputTokens,
      });
    } catch (err) {
      if (!offerTools) throw err;
      // Some deployments reject the tools parameter; continue this agent without skills.
      console.warn(`${agent.name}: tool call request failed, retrying without tools`, err);
      tools = [];
      continue;
    }

    if (!result.toolCalls.length || !offerTools) return cleanReply(ctx.agent, result.text);

    messages.push({ role: "assistant", content: result.text ?? "", tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      toolCallsUsed++;
      const output = await executeToolCall(call.function.name, call.function.arguments, ctx);
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: output });
    }
  }

  const final = await runChat(ctx.env.AI, agent.model, messages, { maxTokens: LIMITS.maxOutputTokens });
  return cleanReply(ctx.agent, final.text);
}

async function executeToolCall(name: string, rawArgs: string, ctx: SkillContext): Promise<string> {
  const skill = findSkillByToolName(ctx.agent, name);
  if (!skill) return `Unknown or not permitted skill: ${name}`;
  if (skill.requiresApproval) return `Skill ${skill.id} needs the founder's approval before it can run. Ask for it.`;
  let args: Record<string, unknown>;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return "Arguments were not valid JSON.";
  }
  try {
    const out = await skill.run(args, ctx);
    return out.slice(0, LIMITS.maxSkillResultChars);
  } catch (err) {
    return `Skill ${skill.id} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Iris: Moondream looks at the image with the founder's latest words as the question. */
async function runVisionTurn(req: TurnRequest, ctx: SkillContext): Promise<string | null> {
  if (!ctx.image) return null;
  const lastHuman = [...req.transcript].reverse().find((m) => m.speaker === "human");
  const question = lastHuman?.text.trim();
  const prompt = question
    ? `The user asks: "${question}". Describe exactly what is visible that is relevant: text, layout, objects, positions, and anything that looks wrong or unusual.`
    : "Describe this image in detail: text, layout, objects and positions, and anything that looks wrong or unusual.";
  const text = await runVision(ctx.env.AI, AGENTS.iris.model, { task: "query", image: ctx.image, prompt, maxTokens: 600 });
  return cleanReply("iris", text);
}
