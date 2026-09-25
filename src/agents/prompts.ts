import type { TrackRecord } from "../memory/store";
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
- Write like a person in a group chat: 1–5 short paragraphs, no headings, no sign-off, don't prefix your own name. Markdown (bold, lists, code blocks, links) is rendered.
- Use your skills (tools) on your own whenever they would make your answer more accurate. Never invent facts, links or numbers.`;

const SPEAKING_RULES = `You are SPEAKING, not writing: your reply is turned into your voice. Talk naturally in 1–3 short sentences, like on a call. No lists, no headings, no code, no URLs, no emoji. If code or a link is needed, say you'll put it in the chat.`;

const MODE_INSTRUCTIONS: Record<Mode, string> = {
  chat: "Respond to the latest message if you have something useful to add.",
  direct: "The founder addressed you directly. Answer them; don't pass unless the message clearly isn't for you.",
  council: "This is a council session. Give your own independent analysis of the topic.",
  debate: "This is a debate. Take a clear position and defend it. Attack the weakest argument made by another member.",
  brainstorm: "This is a brainstorm. Cooperate: build on others' ideas and add new ones. Don't criticise yet.",
  critic: "Critic mode. Attack the idea under discussion: find the reasons it fails. Be specific.",
  live: "You're in a live voice call with the founder and the other members. You were given the floor: respond to what was just said.",
};

const ROUND_INSTRUCTIONS = {
  blind: "This is round 1. You have NOT seen the other members' answers yet. Give your own view.",
  followUp:
    "You can now see the other members' answers. React to them: agree, disagree, challenge, change your mind, or add something new. Refer to members by name. Pass if you have nothing new.",
  summary:
    "Close this discussion for the founder: where the council agrees, where it disagrees and why, and the decision options with the strongest argument for each. Be brief. Do not pass. Record any decision the founder made with group.record_fact and any agreed next step with actions.add.",
};

export type TurnKind = keyof typeof ROUND_INSTRUCTIONS | "normal";

/** Task-specific instructions for commands that don't fit a mode (pre-mortem, personas…). */
export const SPECIAL_INSTRUCTIONS = {
  premortem:
    "Run a pre-mortem on the plan below. Assume it is one year later and the plan failed badly. List the 3–5 most likely reasons it failed, ranked by likelihood × impact, and for each one the earliest warning sign and the cheapest mitigation. Then give your overall verdict. Record your single most important forecast with prediction.record.",
  premortemChallenge:
    "Atlas just ran a pre-mortem. Check its weakest failure reasons and any factual claims (search if needed, record checked claims with claims.record). Add a failure mode Atlas missed, if any.",
  personas:
    "Role-play 3 specific, realistic customer personas reacting to the idea below (name, situation, what they'd pay, what would stop them buying). Be honest: at least one of them should not want it. Then say what this means for the product.",
  minutes:
    "Write the minutes of the council's most recent discussion: decisions made, open disagreements, and next steps with owners. Record each decision with group.record_fact and each next step with actions.add (include a due date when one was mentioned).",
  brief:
    "Write the founder's daily brief: open action items and anything overdue, follow-ups and predictions coming due, the most recent decisions, and one question they should answer today. Keep it short and concrete. If there is genuinely nothing to report, reply exactly [PASS].",
  decision:
    "Build a decision matrix for the question below: the realistic options, 4–6 weighted criteria, a score per option, and your recommendation with the one assumption that would flip it. Use a Markdown table.",
} as const;

export interface PromptInput {
  agent: AgentId;
  mode: Mode;
  turn: TurnKind;
  topic: string;
  transcript: TranscriptMessage[];
  groupFacts: string[];
  privateMemories: string[];
  skillSummaries: string[];
  /** Replaces the mode/round instruction (follow-ups, special commands). */
  instruction?: string;
  /** The reply will be spoken (voice note or live call). */
  speaking?: boolean;
  trackRecord?: TrackRecord;
  /** Retrieved older memory, the agent's own powers context, image descriptions… */
  extraContext?: string;
}

export function formatTrackRecord(r: TrackRecord): string {
  const resolved = r.right + r.wrong;
  const rate = resolved ? ` (${Math.round((r.right / resolved) * 100)}% right)` : "";
  return `${r.right} right, ${r.wrong} wrong, ${r.unclear} unclear, ${r.open} open${rate}`;
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
  if (input.speaking) parts.push(SPEAKING_RULES);
  if (input.skillSummaries.length) {
    parts.push(`Your skills:\n${input.skillSummaries.map((s) => `- ${s}`).join("\n")}`);
  }
  if (input.trackRecord) {
    parts.push(`Your prediction track record so far: ${formatTrackRecord(input.trackRecord)}. Calibrate your confidence accordingly.`);
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
  const base = MODE_INSTRUCTIONS[input.mode];
  const instruction = input.instruction
    ? input.instruction
    : input.turn === "normal"
      ? base
      : `${base} ${ROUND_INSTRUCTIONS[input.turn]}`;

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
