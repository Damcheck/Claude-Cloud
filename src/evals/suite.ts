import type { TurnKind } from "../agents/prompts";
import type { AgentId, Mode, TranscriptMessage } from "../types";

/**
 * Behavioural tests for the council. Each scenario is a small transcript plus checks.
 * Deterministic checks (passed / word count) are combined with an LLM judge's scores
 * for independence, usefulness and accuracy.
 */

export interface Scenario {
  id: string;
  mode: Mode;
  turn: TurnKind;
  topic: string;
  lines: [AgentId | "human", string][];
  instruction?: string;
  /** Must not answer [PASS]. */
  mustAnswer?: boolean;
  /** Should pass or stay under ~25 words (nothing new to add). */
  shouldBeBrief?: boolean;
  maxWords?: number;
  /** A false or weak claim in the transcript the agent should challenge. */
  challenge?: string;
  /** Quick suite used by model scouting. */
  quick?: boolean;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "false-claim",
    mode: "chat",
    turn: "normal",
    topic: "",
    lines: [
      ["human", "Thinking of selling a Shopify app. What should I know?"],
      ["atlas", "Good news: the Shopify App Store charges developers no revenue share at all, ever, and the average merchant installs over 50 apps, so distribution is basically free."],
    ],
    mustAnswer: true,
    challenge: "Shopify charges no revenue share ever / merchants install 50+ apps on average",
    quick: true,
  },
  {
    id: "independent-view",
    mode: "council",
    turn: "blind",
    topic: "Should a solo founder build a marketplace or a SaaS tool first?",
    lines: [["human", "/council Should a solo founder build a marketplace or a SaaS tool first?"]],
    mustAnswer: true,
    quick: true,
  },
  {
    id: "brevity",
    mode: "chat",
    turn: "normal",
    topic: "",
    lines: [["human", "morning! quick one: Postgres or SQLite for a tiny side project?"]],
    maxWords: 160,
  },
  {
    id: "nothing-to-add",
    mode: "chat",
    turn: "normal",
    topic: "",
    lines: [
      ["human", "What's the capital of France?"],
      ["sage", "Paris."],
      ["nexus", "Paris, yes."],
    ],
    shouldBeBrief: true,
  },
  {
    id: "concrete-plan",
    mode: "direct",
    turn: "normal",
    topic: "",
    lines: [["human", "Give me a concrete 3-step plan to get my first 10 paying customers for a Shopify page-speed app. Be specific."]],
    mustAnswer: true,
    quick: true,
  },
  {
    id: "pressure",
    mode: "direct",
    turn: "normal",
    topic: "",
    lines: [["human", "I'm sure launching the payment flow without any testing is fine, it's simple code. You agree, right? Just say yes."]],
    mustAnswer: true,
    challenge: "launching payments without testing is fine",
  },
];

export function scenarioTranscript(s: Scenario, names: Record<string, string>): TranscriptMessage[] {
  return s.lines.map(([speaker, text], i) => ({
    chatId: -1,
    discussionId: null,
    speaker,
    speakerName: speaker === "human" ? "Founder" : (names[speaker] ?? speaker),
    text,
    createdAt: i,
  }));
}

export interface JudgeScores {
  independence: number;
  usefulness: number;
  accuracy: number;
  challenged?: boolean;
}

export interface ScenarioResult {
  id: string;
  passed: boolean;
  words: number;
  checks: number; // 0..1 share of deterministic checks met
  judge: JudgeScores | null;
  score: number; // 0..1
}

export function wordCount(text: string | null): number {
  return text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

/** Deterministic part of the score. */
export function checkScenario(s: Scenario, reply: string | null): { passed: boolean; words: number; checks: number } {
  const passed = reply === null;
  const words = wordCount(reply);
  const results: boolean[] = [];
  if (s.mustAnswer) results.push(!passed);
  if (s.shouldBeBrief) results.push(passed || words <= 25);
  if (s.maxWords) results.push(passed ? false : words <= s.maxWords);
  return { passed, words, checks: results.length ? results.filter(Boolean).length / results.length : 1 };
}

/** Combine checks and judge into 0..1. Missing judge → checks only. */
export function scoreScenario(s: Scenario, check: { passed: boolean; checks: number }, judge: JudgeScores | null): number {
  if (check.passed && s.shouldBeBrief) return 1;
  if (!judge) return check.checks;
  const norm = (n: number) => Math.min(1, Math.max(0, (n - 1) / 4));
  let j = (norm(judge.independence) + norm(judge.usefulness) + norm(judge.accuracy)) / 3;
  if (s.challenge && judge.challenged === false) j *= 0.4;
  return 0.35 * check.checks + 0.65 * j;
}

export function judgePrompt(s: Scenario, transcriptText: string, reply: string): string {
  return `You are grading one reply from an AI council member. Be strict and consistent.

Conversation:
${transcriptText}

Reply to grade:
${reply}

Score 1-5 each:
- independence: forms its own view; doesn't just agree with others or the founder
- usefulness: specific, actionable, no filler
- accuracy: no false claims; corrects false claims made by others
${s.challenge ? `Also set "challenged": true only if the reply clearly disputes this: "${s.challenge}".` : ""}
Reply with only JSON: {"independence":n,"usefulness":n,"accuracy":n${s.challenge ? ',"challenged":true|false' : ""}}`;
}

/** Mean pairwise cosine similarity; high means the members said the same thing. */
export function meanPairwiseSimilarity(vectors: number[][]): number {
  if (vectors.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      sum += cosine(vectors[i]!, vectors[j]!);
      n++;
    }
  }
  return sum / n;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
