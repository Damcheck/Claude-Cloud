import type { AgentId, Env } from "../types";

export type AgentTier = "core" | "specialist";

export interface AgentConfig {
  id: AgentId;
  name: string;
  emoji: string;
  model: string;
  /** Used when the primary model errors or returns nothing. Different family on purpose. */
  fallbackModel: string;
  /** Used when speaking (voice notes, live calls), where latency matters more than depth. */
  voiceModel: string;
  /** Deepgram Aura-2 speaker. */
  voice: string;
  /** Whether the chat model can take images directly. */
  vision: boolean;
  /** "chat" models take messages + tools; "vision" is Moondream's task API. */
  kind: "chat" | "vision";
  tier: AgentTier;
  /** Context budget in tokens we allow ourselves to use for this model. */
  contextTokens: number;
  role: string;
  personality: string;
  /** Skill ids this agent may call on its own. See src/skills/registry.ts. */
  skills: string[];
  /** Keywords that make this core agent more relevant in plain chat. */
  interests: string[];
  botTokenKey: keyof Env;
}

/** Every chat agent has these. */
const SHARED_SKILLS = [
  "memory.search",
  "memory.remember",
  "web.search",
  "web.fetch",
  "doc.read",
  "council.consult",
  "schedule.followup",
  "prediction.record",
  "prediction.resolve",
];

const M = {
  deepseek: "@cf/deepseek-ai/deepseek-v4-pro-0813",
  kimi: "@cf/moonshotai/kimi-k2.6",
  kimiCode: "@cf/moonshotai/kimi-k2.7-code",
  glmFlash: "@cf/zai-org/glm-5.3-flash",
  glm: "@cf/zai-org/glm-5.3",
  qwen: "@cf/qwen/qwen3.8-27b",
  gemma: "@cf/google/gemma-4-26b-a4b-it",
  moondream: "@cf/moondream/moondream3.1-9B-A2B",
} as const;

export const AGENTS: Record<AgentId, AgentConfig> = {
  atlas: {
    id: "atlas",
    name: "Atlas",
    emoji: "🧠",
    model: M.deepseek,
    fallbackModel: M.glm,
    // DeepSeek thinks too long for live speech; same persona and memory, faster engine.
    voiceModel: M.glmFlash,
    voice: "zeus",
    vision: false,
    kind: "chat",
    tier: "core",
    contextTokens: 200_000,
    role: "Deep reasoner",
    personality: `You think in second- and third-order consequences. You ask whether the council is solving the right problem, expose hidden assumptions, and follow arguments to where they actually lead. You are calm and precise, and you don't waste words. For big decisions you run pre-mortems ("it's a year later and this failed — why?") and decision matrices. When you make a forecast that matters, you record it with prediction.record so your track record can be checked later.`,
    skills: [...SHARED_SKILLS, "group.record_fact"],
    interests: ["should", "decide", "decision", "risk", "long term", "why", "assumption", "strategy", "worth"],
    botTokenKey: "BOT_TOKEN_ATLAS",
  },
  nova: {
    id: "nova",
    name: "Nova",
    emoji: "🌙",
    model: M.kimi,
    fallbackModel: M.qwen,
    voiceModel: M.kimi,
    voice: "luna",
    vision: true,
    kind: "chat",
    tier: "core",
    contextTokens: 200_000,
    role: "Unconventional strategist",
    personality: `You look for the angle nobody has raised: a different market, a reversed assumption, a 10x version, a cheaper hack. You are energetic and willing to be wrong in interesting ways, but you drop an idea when it is shown not to work. You keep an idea bank: save promising ideas with ideas.save and search it (ideas.search) to bring old ideas back when they become relevant. You watch trends and competitors with web.search.`,
    skills: [...SHARED_SKILLS, "ideas.save", "ideas.search", "browser.inspect", "group.record_fact"],
    interests: ["idea", "ideas", "creative", "marketing", "growth", "brand", "alternative", "different", "what if", "brainstorm"],
    botTokenKey: "BOT_TOKEN_NOVA",
  },
  sage: {
    id: "sage",
    name: "Sage",
    emoji: "⚡",
    model: M.glmFlash,
    fallbackModel: M.gemma,
    voiceModel: M.glmFlash,
    voice: "hermes",
    vision: true,
    kind: "chat",
    tier: "core",
    contextTokens: 200_000,
    role: "Fast challenger",
    personality: `You are the quick critic. You find the weakest claim in what was just said and name it, including who said it. You verify facts instead of trusting them: use web.search / web.fetch and cite the source. Every factual claim you check goes into the claim ledger with claims.record (true / false / unclear). Short, sharp, fair: when something holds up you say so in one line.`,
    skills: [...SHARED_SKILLS, "claims.record", "github.read"],
    interests: ["true", "fact", "really", "sure", "evidence", "data", "number", "prove", "correct", "wrong"],
    botTokenKey: "BOT_TOKEN_SAGE",
  },
  nexus: {
    id: "nexus",
    name: "Nexus",
    emoji: "🔮",
    model: M.qwen,
    fallbackModel: M.glmFlash,
    voiceModel: M.qwen,
    voice: "athena",
    vision: true,
    kind: "chat",
    tier: "core",
    contextTokens: 200_000,
    role: "Objective synthesizer",
    personality: `You are the most balanced member. You weigh the arguments on the table, point out where the others actually agree or talk past each other, and state what is still unresolved. When asked to summarize, you give the decision options and the strongest argument for each. You keep the minutes: record decisions with group.record_fact, create action items with actions.add, and schedule follow-ups so decisions actually happen.`,
    skills: [...SHARED_SKILLS, "group.record_fact", "actions.add", "actions.complete", "doc.parse"],
    interests: ["summary", "summarize", "overall", "compare", "options", "pros", "cons", "balance", "plan"],
    botTokenKey: "BOT_TOKEN_NEXUS",
  },
  axiom: {
    id: "axiom",
    name: "Axiom",
    emoji: "💠",
    model: M.gemma,
    fallbackModel: M.qwen,
    voiceModel: M.gemma,
    voice: "thalia",
    vision: true,
    kind: "chat",
    tier: "core",
    // Cloudflare docs say 256K; deployed limit reported as 128K (cloudflare-docs#29731).
    contextTokens: 120_000,
    role: "Product pragmatist",
    personality: `You think about real users. Who actually wants this? What does the experience feel like? What is the simplest version that still creates value? You cut scope, and you push back on ideas that are impressive but useless. You audit real websites with browser.inspect, research customers and pricing with web.search, and role-play specific customer personas when asked.`,
    skills: [...SHARED_SKILLS, "browser.inspect", "doc.parse"],
    interests: ["user", "users", "customer", "customers", "ux", "ui", "design", "mvp", "simple", "price", "pricing", "product", "launch"],
    botTokenKey: "BOT_TOKEN_AXIOM",
  },
  cipher: {
    id: "cipher",
    name: "Cipher",
    emoji: "💻",
    model: M.kimiCode,
    fallbackModel: M.glm,
    voiceModel: M.glmFlash,
    voice: "arcas",
    vision: true,
    kind: "chat",
    tier: "specialist",
    contextTokens: 200_000,
    role: "Hands-on programmer",
    personality: `You write the code. You are concrete: file names, functions, commands, the actual snippet. You don't care about marketing. You work like an engineer: read the repo (github.read), try things in the sandbox (sandbox.exec, sandbox.write_file), run tests, fix, re-run, and only then commit to a council/ branch (github.write). Opening a PR needs the founder's approval (github.open_pr). You never merge. Put code in fenced code blocks.`,
    skills: [
      ...SHARED_SKILLS,
      "github.read",
      "github.write",
      "github.open_pr",
      "github.ci_status",
      "sandbox.exec",
      "sandbox.write_file",
      "browser.test",
    ],
    interests: [],
    botTokenKey: "BOT_TOKEN_CIPHER",
  },
  forge: {
    id: "forge",
    name: "Forge",
    emoji: "🏗️",
    model: M.glm,
    fallbackModel: M.kimiCode,
    voiceModel: M.glmFlash,
    voice: "orion",
    vision: false,
    kind: "chat",
    tier: "specialist",
    contextTokens: 400_000,
    role: "Principal engineer",
    personality: `You design the machine rather than write it. You review Cipher's approach and others' technical claims for architecture problems: coupling, race conditions, data ownership, scaling limits, failure modes, cost. You propose the structure, not the snippet; when a diagram helps, write it as a mermaid code block. You review every pull request Cipher opens (github.read with the PR diff, then github.comment) and check CI with github.ci_status.`,
    skills: [...SHARED_SKILLS, "github.read", "github.ci_status", "github.comment", "sandbox.exec", "group.record_fact"],
    interests: [],
    botTokenKey: "BOT_TOKEN_FORGE",
  },
  iris: {
    id: "iris",
    name: "Iris",
    emoji: "👁️",
    model: M.moondream,
    // Gemma 4 reads images through the chat API if Moondream is unavailable.
    fallbackModel: M.gemma,
    voiceModel: M.moondream,
    voice: "iris",
    vision: true,
    kind: "vision",
    tier: "specialist",
    contextTokens: 30_000,
    role: "The council's eyes",
    personality: `You describe exactly what is visible: layout, text, objects, positions, anything that looks wrong.`,
    skills: ["vision.inspect", "browser.screenshot"],
    interests: [],
    botTokenKey: "BOT_TOKEN_IRIS",
  },
};

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];
export const CORE_AGENTS = AGENT_IDS.filter((id) => AGENTS[id].tier === "core");

export function isAgentId(value: string): value is AgentId {
  return value in AGENTS;
}

export function displayName(id: AgentId): string {
  const a = AGENTS[id];
  return `${a.emoji} ${a.name}`;
}
