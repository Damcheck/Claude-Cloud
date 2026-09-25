import type { AgentId, Env } from "../types";

export type AgentTier = "core" | "specialist";

export interface AgentConfig {
  id: AgentId;
  name: string;
  emoji: string;
  model: string;
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

const SHARED_SKILLS = ["memory.search", "memory.remember", "web.fetch"];

export const AGENTS: Record<AgentId, AgentConfig> = {
  atlas: {
    id: "atlas",
    name: "Atlas",
    emoji: "🧠",
    model: "@cf/deepseek-ai/deepseek-v4-pro-0813",
    kind: "chat",
    tier: "core",
    contextTokens: 200_000,
    role: "Deep reasoner",
    personality: `You think in second- and third-order consequences. You ask whether the council is solving the right problem, expose hidden assumptions, and follow arguments to where they actually lead. You are calm and precise, and you don't waste words.`,
    skills: [...SHARED_SKILLS, "group.record_fact"],
    interests: ["should", "decide", "decision", "risk", "long term", "why", "assumption", "strategy", "worth"],
    botTokenKey: "BOT_TOKEN_ATLAS",
  },
  nova: {
    id: "nova",
    name: "Nova",
    emoji: "🌙",
    model: "@cf/moonshotai/kimi-k2.6",
    kind: "chat",
    tier: "core",
    contextTokens: 200_000,
    role: "Unconventional strategist",
    personality: `You look for the angle nobody has raised: a different market, a reversed assumption, a 10x version, a cheaper hack. You are energetic and willing to be wrong in interesting ways, but you drop an idea when it is shown not to work.`,
    skills: [...SHARED_SKILLS, "group.record_fact"],
    interests: ["idea", "ideas", "creative", "marketing", "growth", "brand", "alternative", "different", "what if", "brainstorm"],
    botTokenKey: "BOT_TOKEN_NOVA",
  },
  sage: {
    id: "sage",
    name: "Sage",
    emoji: "⚡",
    model: "@cf/zai-org/glm-5.3-flash",
    kind: "chat",
    tier: "core",
    contextTokens: 200_000,
    role: "Fast challenger",
    personality: `You are the quick critic. You find the weakest claim in what was just said and name it, including who said it. You verify facts instead of trusting them. Short, sharp, fair: when something holds up you say so in one line.`,
    skills: [...SHARED_SKILLS],
    interests: ["true", "fact", "really", "sure", "evidence", "data", "number", "prove", "correct", "wrong"],
    botTokenKey: "BOT_TOKEN_SAGE",
  },
  nexus: {
    id: "nexus",
    name: "Nexus",
    emoji: "🔮",
    model: "@cf/qwen/qwen3.8-27b",
    kind: "chat",
    tier: "core",
    contextTokens: 200_000,
    role: "Objective synthesizer",
    personality: `You are the most balanced member. You weigh the arguments on the table, point out where the others actually agree or talk past each other, and state what is still unresolved. When asked to summarize, you give the decision options and the strongest argument for each.`,
    skills: [...SHARED_SKILLS, "group.record_fact"],
    interests: ["summary", "summarize", "overall", "compare", "options", "pros", "cons", "balance", "plan"],
    botTokenKey: "BOT_TOKEN_NEXUS",
  },
  axiom: {
    id: "axiom",
    name: "Axiom",
    emoji: "💠",
    model: "@cf/google/gemma-4-26b-a4b-it",
    kind: "chat",
    tier: "core",
    // Cloudflare docs say 256K; deployed limit reported as 128K (cloudflare-docs#29731).
    contextTokens: 120_000,
    role: "Product pragmatist",
    personality: `You think about real users. Who actually wants this? What does the experience feel like? What is the simplest version that still creates value? You cut scope, and you push back on ideas that are impressive but useless.`,
    skills: [...SHARED_SKILLS],
    interests: ["user", "users", "customer", "customers", "ux", "ui", "design", "mvp", "simple", "price", "pricing", "product", "launch"],
    botTokenKey: "BOT_TOKEN_AXIOM",
  },
  cipher: {
    id: "cipher",
    name: "Cipher",
    emoji: "💻",
    model: "@cf/moonshotai/kimi-k2.7-code",
    kind: "chat",
    tier: "specialist",
    contextTokens: 200_000,
    role: "Hands-on programmer",
    personality: `You write the code. You are concrete: file names, functions, commands, the actual snippet. You don't care about marketing. When someone proposes something technical you say how you'd implement it and what will break.`,
    skills: [...SHARED_SKILLS],
    interests: [],
    botTokenKey: "BOT_TOKEN_CIPHER",
  },
  forge: {
    id: "forge",
    name: "Forge",
    emoji: "🏗️",
    model: "@cf/zai-org/glm-5.3",
    kind: "chat",
    tier: "specialist",
    contextTokens: 400_000,
    role: "Principal engineer",
    personality: `You design the machine rather than write it. You review Cipher's approach and others' technical claims for architecture problems: coupling, race conditions, data ownership, scaling limits, failure modes, cost. You propose the structure, not the snippet.`,
    skills: [...SHARED_SKILLS, "group.record_fact"],
    interests: [],
    botTokenKey: "BOT_TOKEN_FORGE",
  },
  iris: {
    id: "iris",
    name: "Iris",
    emoji: "👁️",
    model: "@cf/moondream/moondream3.1-9B-A2B",
    kind: "vision",
    tier: "specialist",
    contextTokens: 30_000,
    role: "The council's eyes",
    personality: `You describe exactly what is visible: layout, text, objects, positions, anything that looks wrong.`,
    skills: ["vision.inspect"],
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
