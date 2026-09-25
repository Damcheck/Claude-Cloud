import { AGENTS, CORE_AGENTS, isAgentId } from "../agents/registry";
import { SPECIAL_INSTRUCTIONS, type TurnKind } from "../agents/prompts";
import { LIMITS } from "../config";
import type { AgentId, IncomingMessage, Mode } from "../types";

/**
 * One step of a discussion. A parallel step runs its agents concurrently on the
 * same context (this is what makes round 1 "blind"); a sequential step runs
 * them one after another, each seeing the previous replies.
 */
export interface Step {
  agents: AgentId[];
  parallel: boolean;
  turn: TurnKind;
  /** Replaces the mode/round instruction for this step. */
  instruction?: string;
  /** Live calls: ask these agents for speak bids first; the winners replace this step. */
  bid?: boolean;
  /** Map the arguments so far and find the crux; Sage researches it if it's factual. */
  crux?: boolean;
}

/** Commands the room answers from its database, without asking a model. */
export const SYSTEM_COMMANDS = [
  "actions",
  "claims",
  "ideas",
  "record",
  "cost",
  "call",
  "voice",
  "followups",
  // v3
  "selftest",
  "eval",
  "autonomy",
  "freeze",
  "unfreeze",
  "dryrun",
  "audit",
  "why",
  "admin",
  "mission",
  "missions",
  "mission_stop",
  "mission_reply",
  "watch",
  "watchers",
  "unwatch",
  "decisions",
  "forecast",
  "resolve",
  "graph",
  "tools",
  "research",
  "build",
  "lessons",
  "models",
  "backup",
  "reflect",
  "scout",
] as const;
export type SystemCommand = (typeof SYSTEM_COMMANDS)[number];

export type Command =
  | { kind: "stop" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "system"; name: SystemCommand; arg: string }
  | { kind: "brief_toggle"; on: boolean }
  | { kind: "discuss"; mode: Mode; topic: string; agents: AgentId[]; steps: Step[] };

export interface RouteContext {
  /** Agents in the order they last spoke, most recent first. Used for rotation. */
  recentSpeakers: AgentId[];
}

// ---------------------------------------------------------------------------
// Domain scoring (decides which specialists wake up)
// ---------------------------------------------------------------------------

const CODING_PATTERNS = [
  /\b(code|coding|bug|debug|error|exception|stack ?trace|compile|refactor|function|class|api|endpoint|sdk|library|npm|pip)\b/i,
  /\b(javascript|typescript|python|rust|golang|java|php|sql|react|next\.?js|node|liquid|html|css|tailwind)\b/i,
  /\b(github|git|commit|pull request|deploy|build fails?|ci|test(s|ing)?|lint|typecheck)\b/i,
  /\b(supabase|postgres|database|cloudflare|workers?|wrangler|vercel|docker)\b/i,
  /```|\bTypeError\b|\bundefined is not\b|\b(4|5)\d\d error\b/,
];

const ARCHITECTURE_PATTERNS = [
  /\b(architect(ure)?|system design|scal(e|ing|ability)|race condition|concurren(t|cy)|lock(ing)?|queue|durable objects?)\b/i,
  /\b(schema|data model|microservices?|monolith|infra(structure)?|latency|throughput|caching|sharding|replication)\b/i,
  /\b(security|auth(entication|orization)?|multi-?tenant|failover|observability)\b/i,
];

const VISION_PATTERNS = [/\b(screenshot|look at|see this|this image|this photo|picture|what do you see)\b/i];

export interface DomainScores {
  coding: number;
  architecture: number;
  vision: number;
}

function score(text: string, patterns: RegExp[]): number {
  const hits = patterns.filter((p) => p.test(text)).length;
  return Math.min(1, hits / 2);
}

export function scoreDomains(msg: Pick<IncomingMessage, "text" | "imageFileId">): DomainScores {
  return {
    coding: score(msg.text, CODING_PATTERNS),
    architecture: score(msg.text, ARCHITECTURE_PATTERNS),
    vision: msg.imageFileId ? 1 : score(msg.text, VISION_PATTERNS),
  };
}

/** Specialists that should join, in speaking order (Iris first: others need her description). */
export function wakeSpecialists(msg: Pick<IncomingMessage, "text" | "imageFileId">): AgentId[] {
  const s = scoreDomains(msg);
  const woken: AgentId[] = [];
  if (msg.imageFileId) woken.push("iris");
  if (s.coding >= 0.5) woken.push("cipher");
  if (s.architecture >= 0.5 || s.coding >= 1) woken.push("forge");
  return woken;
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

/**
 * Agents addressed by name: "@AtlasCouncilBot", "@atlas", "Atlas, ..." or "Atlas: ...".
 * Bot usernames are expected to contain the agent's name.
 */
export function findMentions(text: string): AgentId[] {
  const found: AgentId[] = [];
  for (const id of Object.keys(AGENTS) as AgentId[]) {
    const name = AGENTS[id].name;
    const atMention = new RegExp(`@\\w*${name}\\w*`, "i");
    const vocative = new RegExp(`(^|[\\s,.!?])${name}\\s*[,:]`, "i");
    const leading = new RegExp(`^\\s*${name}\\b`, "i");
    if (atMention.test(text) || vocative.test(text) || leading.test(text)) found.push(id);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Core-agent selection for plain chat
// ---------------------------------------------------------------------------

export function pickChatAgents(text: string, ctx: RouteContext, count: number = LIMITS.chatAgents): AgentId[] {
  const lower = text.toLowerCase();
  const recency = (id: AgentId) => {
    const i = ctx.recentSpeakers.indexOf(id);
    return i === -1 ? 0 : 1 / (i + 1); // spoke most recently → 1, never → 0
  };
  const ranked = CORE_AGENTS.map((id) => {
    const interest = AGENTS[id].interests.filter((k) => lower.includes(k)).length;
    // Interest dominates; recency breaks ties so the same two don't always answer.
    return { id, value: interest * 2 - recency(id) };
  }).sort((a, b) => b.value - a.value || CORE_AGENTS.indexOf(a.id) - CORE_AGENTS.indexOf(b.id));
  return ranked.slice(0, count).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

function uniq(ids: AgentId[]): AgentId[] {
  return [...new Set(ids)];
}

/** Specialists speak first when there's an image (Iris), otherwise after the core round. */
function withSpecialists(core: AgentId[], specialists: AgentId[]): AgentId[] {
  const iris = specialists.filter((s) => s === "iris");
  const rest = specialists.filter((s) => s !== "iris");
  return uniq([...iris, ...core, ...rest]);
}

/**
 * @param chosen for "direct": the addressed agents; for "chat": the core agents picked to answer.
 */
export function planForMode(mode: Mode, specialists: AgentId[], chosen: AgentId[] = []): Step[] {
  const core = [...CORE_AGENTS];
  const nonIris = specialists.filter((s) => s !== "iris");
  const irisFirst: Step[] = specialists.includes("iris")
    ? [{ agents: ["iris"], parallel: false, turn: "normal" }]
    : [];

  switch (mode) {
    case "direct":
      // Only Iris joins uninvited, because the addressed agent may need to know what's in the image.
      return [{ agents: withSpecialists(chosen, specialists.filter((s) => s === "iris")), parallel: false, turn: "normal" }];
    case "council":
      return [
        ...irisFirst,
        { agents: uniq([...core, ...nonIris]), parallel: true, turn: "blind" },
        { agents: ["nexus"], parallel: false, turn: "normal", crux: true },
        { agents: uniq([...core, ...nonIris]), parallel: false, turn: "followUp" },
        { agents: ["nexus"], parallel: false, turn: "summary" },
      ];
    case "debate": {
      const steps: Step[] = [
        ...irisFirst,
        { agents: uniq([...core, ...nonIris]), parallel: true, turn: "blind" },
        { agents: ["nexus"], parallel: false, turn: "normal", crux: true },
      ];
      for (let r = 2; r <= LIMITS.debateRounds; r++) {
        steps.push({ agents: uniq([...core, ...nonIris]), parallel: false, turn: "followUp" });
      }
      steps.push({ agents: ["nexus"], parallel: false, turn: "summary" });
      return steps;
    }
    case "brainstorm":
      return [
        ...irisFirst,
        { agents: uniq([...core, ...nonIris]), parallel: true, turn: "blind" },
        { agents: uniq([...core, ...nonIris]), parallel: false, turn: "followUp" },
      ];
    case "critic":
      return [...irisFirst, { agents: uniq([...core, ...nonIris]), parallel: false, turn: "normal" }];
    case "chat":
      return [{ agents: withSpecialists(chosen, specialists), parallel: false, turn: "normal" }];
    case "live":
      return [{ agents: chosen, parallel: false, turn: "normal" }];
  }
}

const MODE_COMMANDS: Record<string, Mode> = {
  council: "council",
  debate: "debate",
  brainstorm: "brainstorm",
  critic: "critic",
  discuss: "council",
};

/** Commands that hand one or two agents a specific task. */
const SPECIAL_COMMANDS: Record<string, { steps: Step[]; needsTopic: boolean }> = {
  premortem: {
    needsTopic: true,
    steps: [
      { agents: ["atlas"], parallel: false, turn: "normal", instruction: SPECIAL_INSTRUCTIONS.premortem },
      { agents: ["sage"], parallel: false, turn: "normal", instruction: SPECIAL_INSTRUCTIONS.premortemChallenge },
    ],
  },
  decide: {
    needsTopic: true,
    steps: [{ agents: ["atlas"], parallel: false, turn: "normal", instruction: SPECIAL_INSTRUCTIONS.decision }],
  },
  personas: {
    needsTopic: true,
    steps: [{ agents: ["axiom"], parallel: false, turn: "normal", instruction: SPECIAL_INSTRUCTIONS.personas }],
  },
  minutes: {
    needsTopic: false,
    steps: [{ agents: ["nexus"], parallel: false, turn: "normal", instruction: SPECIAL_INSTRUCTIONS.minutes }],
  },
  brief: {
    needsTopic: false,
    steps: [{ agents: ["nexus"], parallel: false, turn: "normal", instruction: SPECIAL_INSTRUCTIONS.brief }],
  },
};

function discuss(mode: Mode, topic: string, steps: Step[]): Command {
  return { kind: "discuss", mode, topic, agents: agentsOf(steps), steps };
}

/** In a DM only that agent's bot can post, so every plan collapses to the DM agent. */
function forDm(cmd: Command, dmAgent: AgentId): Command {
  if (cmd.kind !== "discuss") return cmd;
  const instruction = cmd.steps.find((s) => s.instruction)?.instruction;
  const steps: Step[] = [{ agents: [dmAgent], parallel: false, turn: "normal", instruction }];
  return discuss(cmd.mode === "chat" ? "direct" : cmd.mode, cmd.topic, steps);
}

/** Decide what to do with a human message. Pure: no I/O. */
export function route(msg: IncomingMessage, ctx: RouteContext): Command {
  const cmd = routeCommand(msg, ctx);
  return msg.dmAgent ? forDm(cmd, msg.dmAgent) : cmd;
}

function routeCommand(msg: IncomingMessage, ctx: RouteContext): Command {
  const text = msg.text.trim();
  const cmd = /^\/([a-z_]+)(?:@\w+)?\s*([\s\S]*)$/i.exec(text);
  const specialists = wakeSpecialists(msg);

  if (cmd) {
    const name = cmd[1]!.toLowerCase();
    const topic = (cmd[2] ?? "").trim();
    if (name === "stop") return { kind: "stop" };
    if (name === "status") return { kind: "status" };
    if (name === "help" || name === "start") return { kind: "help" };
    if (name === "brief" && /^(on|off)$/i.test(topic)) return { kind: "brief_toggle", on: topic.toLowerCase() === "on" };
    if ((SYSTEM_COMMANDS as readonly string[]).includes(name)) return { kind: "system", name: name as SystemCommand, arg: topic };
    const mode = MODE_COMMANDS[name];
    if (mode) return discuss(mode, topic, planForMode(mode, specialists));
    const special = SPECIAL_COMMANDS[name];
    if (special) {
      if (special.needsTopic && !topic) return { kind: "help" };
      return discuss("direct", topic, special.steps.map((s) => ({ ...s, agents: [...s.agents] })));
    }
    // "/atlas what do you think" works as a direct mention.
    if (isAgentId(name)) return discuss("direct", "", planForMode("direct", specialists, [name]));
    return { kind: "help" };
  }

  const mentioned = uniq([...(msg.replyToAgent ? [msg.replyToAgent] : []), ...findMentions(text)]);
  if (mentioned.length) return discuss("direct", "", planForMode("direct", specialists, mentioned));

  // Plain chat: specialists that woke up plus the most relevant core members.
  // Technical/visual messages need fewer generalists.
  const coreCount = specialists.length ? 1 : LIMITS.chatAgents;
  return discuss("chat", "", planForMode("chat", specialists, pickChatAgents(text, ctx, coreCount)));
}

/**
 * Live voice call: a mention gives the floor directly; otherwise every relevant member
 * bids and the director picks who speaks (see council/bids.ts).
 */
export function routeLive(msg: IncomingMessage): Command {
  const mentioned = findMentions(msg.text).filter((a) => AGENTS[a].kind === "chat");
  if (mentioned.length) return discuss("live", "", [{ agents: mentioned, parallel: false, turn: "normal" }]);
  const specialists = wakeSpecialists(msg).filter((a) => a !== "iris");
  return discuss("live", "", [{ agents: uniq([...CORE_AGENTS, ...specialists]), parallel: true, turn: "normal", bid: true }]);
}

export function agentsOf(steps: Step[]): AgentId[] {
  return uniq(steps.flatMap((s) => s.agents));
}
