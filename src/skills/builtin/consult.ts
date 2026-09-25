import { buildSystemPrompt } from "../../agents/prompts";
import { AGENTS, isAgentId } from "../../agents/registry";
import { runChat } from "../../ai/workers-ai";
import { stripReasoning } from "../../council/text";
import type { Skill } from "../types";
import { str } from "../types";

/**
 * Ask another member a question privately before you answer. Their reply comes back to
 * you only; nothing is posted. One level deep: a consulted member cannot consult again.
 */
export const councilConsult: Skill = {
  id: "council.consult",
  description:
    "Privately ask another council member (e.g. Forge about architecture, Sage to check a fact, Cipher how hard something is to build) before you answer. Their reply is only visible to you.",
  parameters: {
    type: "object",
    properties: {
      member: { type: "string", description: "atlas, nova, sage, nexus, axiom, cipher or forge" },
      question: { type: "string" },
    },
    required: ["member", "question"],
  },
  risk: "read",
  async run(args, ctx) {
    if (ctx.consultDepth > 0) return "You are already answering a private consultation; answer yourself.";
    const member = str(args.member).toLowerCase().trim();
    if (!isAgentId(member) || member === ctx.agent || AGENTS[member].kind !== "chat") return "Choose another chat member to consult.";
    const target = AGENTS[member];
    const system = buildSystemPrompt({
      agent: member,
      mode: "direct",
      turn: "normal",
      topic: "",
      transcript: [],
      groupFacts: [],
      privateMemories: await ctx.store.agentMemories(member, 10),
      skillSummaries: [],
    });
    const recent = ctx.transcript
      .slice(-12)
      .map((m) => `${m.speakerName}: ${m.text}`)
      .join("\n\n");
    const user = `Recent group conversation:\n<transcript>\n${recent}\n</transcript>\n\n${AGENTS[ctx.agent].name} is asking you privately (the group won't see this): ${str(args.question)}\n\nAnswer ${AGENTS[ctx.agent].name} directly in a few sentences.`;
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ];
    let result;
    try {
      result = await runChat(ctx.env.AI, target.model, messages, { maxTokens: 450, ...ctx.callOptions, metadata: { agent: member, via: ctx.agent } });
    } catch {
      result = await runChat(ctx.env.AI, target.fallbackModel, messages, { maxTokens: 450, ...ctx.callOptions, metadata: { agent: member, via: ctx.agent } });
    }
    await ctx.store.recordUsage(ctx.convId, member, target.model, result.usage.promptTokens, result.usage.completionTokens);
    return `${target.name} (privately): ${stripReasoning(result.text) || "(no answer)"}`;
  },
};
