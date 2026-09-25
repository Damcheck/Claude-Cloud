import type { AgentId, Mode, TranscriptMessage } from "../types";
import { AGENTS, AGENT_IDS } from "./registry";

export const PASS_TOKEN = "[PASS]";

const COUNCIL_RULES = `You are one independent member of an AI council in a Telegram group. The other members are different AI models with their own views. The human who owns the group is the founder.

Rules:
- Evaluate every claim yourself. Never agree just because another member said it.
- Challenge factual, logical, technical or strategic weaknesses, and name who made the claim.
- Change your position when someone gives stronger evidence, and say so plainly.
- Don't manufacture disagreement when there is genuine consensus.
- Don't repeat a point that was already made unless you add something substantial.
- If you have nothing meaningful to add, reply with exactly ${PASS_TOKEN} and nothing else.
- Write like a person in a group chat: 1–5 short paragraphs, no headings, no sign-off, don't prefix your own name.
- Use your skills (tools) on your own whenever they would make your answer more accurate. Never invent facts, links or numbers.`;

const MODE_INSTRUCTIONS: Record<Mode, string> = {
  chat: "Respond to the latest message if you have something useful to add.",
  direct: "The founder addressed you directly. Answer them; don't pass unless the message clearly isn't for you.",
  council:
    "This is a council session. Give your own independent analysis of the topic.",
  debate:
    "This is a debate. Take a clear position and defend it. Attack the weakest argument made by another member.",
  brainstorm:
    "This is a brainstorm. Cooperate: build on others' ideas and add new ones. Don't criticise yet.",
  critic:
    "Critic mode. Attack the idea under discussion: find the reasons it fails. Be specific.",
};

const ROUND_INSTRUCTIONS = {
  blind:
    "This is round 1. You have NOT seen the other members' answers yet. Give your own view.",
  followUp:
    "You can now see the other members' answers. React to them: agree, disagree, challenge, change your mind, or add something new. Refer to members by name. Pass if you have nothing new.",
  summary:
    "Close this discussion for the founder: where the council agrees, where it disagrees and why, and the decision options with the strongest argument for each. Be brief. Do not pass.",
};

export type TurnKind = keyof typeof ROUND_INSTRUCTIONS | "normal";

export interface PromptInput {
  agent: AgentId;
  mode: Mode;
  turn: TurnKind;
  topic: string;
  transcript: TranscriptMessage[];
  groupFacts: string[];
  privateMemories: string[];
  skillSummaries: string[];
  extraContext?: string;
}

export function buildSystemPrompt(input: PromptInput): string {
  const a = AGENTS[input.agent];
  const others = AGENT_IDS.filter((id) => id !== input.agent)
    .map((id) => `${AGENTS[id].name} (${AGENTS[id].role})`)
    .join(", ");

  const parts = [
    `You are ${a.name}, the council's ${a.role.toLowerCase()}.`,
    a.personality,
    COUNCIL_RULES,
    `Other members: ${others}.`,
  ];
  if (input.skillSummaries.length) {
    parts.push(`Your skills:\n${input.skillSummaries.map((s) => `- ${s}`).join("\n")}`);
  }
  if (input.groupFacts.length) {
    parts.push(`Shared group memory (facts everyone knows):\n${input.groupFacts.map((f) => `- ${f}`).join("\n")}`);
  }
  if (input.privateMemories.length) {
    parts.push(`Your private memory (only you know these):\n${input.privateMemories.map((m) => `- ${m}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

export function buildUserPrompt(input: PromptInput): string {
  const lines = input.transcript.map((m) => {
    const who = m.speaker === input.agent ? `${m.speakerName} (you)` : m.speakerName;
    return `${who}: ${m.text}`;
  });
  const instruction =
    input.turn === "normal"
      ? MODE_INSTRUCTIONS[input.mode]
      : `${MODE_INSTRUCTIONS[input.mode]} ${ROUND_INSTRUCTIONS[input.turn]}`;

  return [
    "Recent group conversation:",
    "<transcript>",
    lines.join("\n\n") || "(empty)",
    "</transcript>",
    input.topic ? `Topic: ${input.topic}` : "",
    input.extraContext ? `Additional context:\n${input.extraContext}` : "",
    `Your task: ${instruction}`,
    `Reply as ${AGENTS[input.agent].name}.`,
  ]
    .filter(Boolean)
    .join("\n");
}
