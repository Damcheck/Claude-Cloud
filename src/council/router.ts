import { AGENTS, AGENT_IDS, CORE_AGENTS, isAgentId } from "../agents/registry";
import { SPECIAL_INSTRUCTIONS, type TurnKind } from "../agents/prompts";
import { LIMITS } from "../config";
import type { AgentId, IncomingMessage, Mode, ReasoningMode } from "../types";

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
  /** Deterministic response used only when both the primary and backup model return empty. */
  fallback?: "introduction";
  /** Natural-language room turns prioritize human chat latency and compact replies. */
  fast?: boolean;
  /** Per-turn output cap for realistic chat cadence. */
  maxTokens?: number;
  /** Preserve the member's configured reasoning model for visible substantive speech. */
  primaryModel?: boolean;
  /** Adaptive thinking depth selected from the founder's intent and task complexity. */
  reasoning?: ReasoningMode;
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
  // Council OS
  "world",
  "worlds",
  "reputation",
  "relationships",
  "replay",
  "warroom",
  "profile",
  "chamber",
  "tone",
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
  recentSpeakers: readonly AgentId[];
}

const FOLLOW_UP_PATTERNS = [
  /^\s*(why|how so|and|so|really|sure)\s*[?.!]*\s*$/i,
  /\b(go on|continue|keep going|tell me more|explain|elaborate|expand on that|break that down)\b/i,
  /\b(what do you mean|why do you say that|how did you get there|what makes you think that)\b/i,
  /\b(are you sure|prove (?:it|that)|show me|back that up|give me an example)\b/i,
  /\b(i agree|i disagree|you(?:'re| are) wrong|that makes sense|good point|do it|go ahead|make it happen)\b/i,
  /\b(your point|your idea|what you said|you mentioned|you just said|that claim|that answer|that plan)\b/i,
];

const RECENT_PAIR = /\b(both of you|you both|you two|the two of you)\b/i;
const WHOLE_COUNCIL =
  /\b(everyone|everybody|all of you|all (?:the )?(?:agents|members)|whole (?:council|team)|entire (?:council|team)|you (?:all|guys)|the council)\b/i;
const NATURAL_DEBATE =
  /\b(debat(?:e|ing) (?:this|it|each other|among yourselves)|start debat(?:e|ing)|argue (?:this|it|about|with each other)|fight this out|take opposing sides|challenge each other|disagree with each other)\b/i;
const NATURAL_BRAINSTORM = /\b(brainstorm|come up with (?:some )?ideas|give me (?:some )?ideas|ideate)\b/i;
const NATURAL_CRITIC =
  /\b(tear (?:this|that|the|my|our)?\s*\w*\s*apart|rip (?:this|that|the|my|our)?\s*\w*\s*apart|roast (?:this|that|my|our|the)\b|critique (?:this|that|my|our|the)\b|find (?:all )?the flaws)\b/i;

const ROLE_PATTERNS: Partial<Record<AgentId, RegExp[]>> = {
  atlas: [
    /\b(strategy|strategic|risk|decision|choose|option|trade-?off|long[- ]term|consequence|forecast|worth it|should (?:i|we))\b/i,
  ],
  nova: [
    /\b(idea|creative|growth|marketing|viral|content|hook|brand|campaign|attention|audience|rage[- ]?bait|different angle)\b/i,
  ],
  sage: [
    /\b(fact[- ]?check|verify|evidence|source|true|false|accurate|proof|research|data|statistic|claim|is that right)\b/i,
  ],
  nexus: [
    /\b(summary|summarize|recap|organize|coordinate|priority|priorities|next steps?|action items?|decision so far|where are we)\b/i,
  ],
  axiom: [
    /\b(user|customer|product|feature|mvp|experience|ux|ui|pricing|price|conversion|onboarding|launch|would people)\b/i,
  ],
};

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** Infer conversational addressees when the founder speaks naturally without a name. */
export function implicitTargets(text: string, ctx: RouteContext): AgentId[] {
  if (!ctx.recentSpeakers.length) return [];
  if (RECENT_PAIR.test(text)) return ctx.recentSpeakers.slice(0, 2);
  const compact = text.trim().length <= 180;
  if (compact && matchesAny(text, FOLLOW_UP_PATTERNS)) return ctx.recentSpeakers.slice(0, 1);
  return [];
}

// ---------------------------------------------------------------------------
// Domain scoring (decides which specialists wake up)
// ---------------------------------------------------------------------------

const CODING_PATTERNS = [
  /\b(code|coding|bug|debug|error|exception|stack ?trace|compile|refactor|function|class|api|endpoint|sdk|library|npm|pip)\b/i,
  /\b(javascript|typescript|python|rust|golang|java|php|sql|react|next\.?js|node|liquid|html|css|tailwind)\b/i,
  /\b(github|git|commit|pull request|deploy|build fails?|ci|test(s|ing)?|lint|typecheck)\b/i,
  /\b(supabase|postgres|database|cloudflare|workers?|wrangler|vercel|docker)\b/i,
  /\b(cyber\s*security|penetration\s*test(?:ing)?|pen\s*test(?:ing)?|attack(?:ing)?\s+(?:tool|site|lab)|security\s+(?:tool|lab|test(?:ing)?))\b/i,
  /```|\bTypeError\b|\bundefined is not\b|\b(4|5)\d\d error\b/,
];

const ARCHITECTURE_PATTERNS = [
  /\b(architect(ure)?|system design|scal(e|ing|ability)|race condition|concurren(t|cy)|lock(ing)?|queue|durable objects?)\b/i,
  /\b(schema|data model|microservices?|monolith|infra(structure)?|latency|throughput|caching|sharding|replication)\b/i,
  /\b(security|cyber\s*security|auth(entication|orization)?|multi-?tenant|failover|observability)\b/i,
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
    const roleFit = (ROLE_PATTERNS[id] ?? []).filter((pattern) => pattern.test(text)).length;
    // Semantic role fit dominates; recency only rotates ties so attention stays relevant.
    return { id, value: roleFit * 4 + interest * 2 - recency(id) * 0.5 };
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

/** Every member capable of a text turn. Runtime identity filtering removes bots not configured yet. */
const ALL_CHAT_AGENTS = AGENT_IDS.filter((id) => AGENTS[id].kind === "chat");

const INTRODUCE_EVERYONE =
  /\b(introduce yourselves|introduce (?:all|everyone|everybody|each member)|(?:everyone|everybody|all (?:of you|agents?|members?)|each (?:of you|agent|member))[^.!?]{0,50}\bintroduce|meet the (?:whole )?(?:team|council)|who (?:is|are) everyone)\b/i;

function everyoneStep(instruction: string, fallback?: Step["fallback"]): Step[] {
  return [{ agents: [...ALL_CHAT_AGENTS], parallel: true, turn: "normal", instruction, fallback }];
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
    if (name === "introduce" || name === "introductions") {
      return discuss(
        "direct",
        topic,
        everyoneStep("Introduce yourself in 2–3 concise sentences: state your name, your council role, and what you contribute. Speak only for yourself. You must answer; do not pass.", "introduction"),
      );
    }
    if (name === "everyone") {
      if (!topic) return { kind: "help" };
      return discuss(
        "direct",
        topic,
        everyoneStep("Every council member must answer the founder's request once, from their own role. Speak only for yourself. Do not pass or summarize other members."),
      );
    }
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

  if (INTRODUCE_EVERYONE.test(text)) {
    return discuss(
      "direct",
      "",
      everyoneStep("Introduce yourself in 2–3 concise sentences: state your name, your council role, and what you contribute. Speak only for yourself. You must answer; do not pass.", "introduction"),
    );
  }

  const mentioned = uniq([...(msg.replyToAgent ? [msg.replyToAgent] : []), ...findMentions(text)]);
  if (mentioned.length) return discuss("direct", "", planForMode("direct", specialists, mentioned));

  // Commands are optional: strong natural-language requests can open the matching room mode.
  if (NATURAL_DEBATE.test(text)) return discuss("debate", text, planForMode("debate", specialists));
  if (NATURAL_BRAINSTORM.test(text)) return discuss("brainstorm", text, planForMode("brainstorm", specialists));
  if (NATURAL_CRITIC.test(text)) return discuss("critic", text, planForMode("critic", specialists));

  if (WHOLE_COUNCIL.test(text)) {
    return discuss(
      "direct",
      "",
      everyoneStep("The founder addressed the whole council naturally. Answer the request once from your own role, respond to the exact current message, and do not wait for a command or name mention."),
    );
  }

  // A short conversational follow-up belongs to the latest speaker (or latest two when
  // the founder says "both of you"). Technical/visual evidence still brings in the needed specialist.
  const implicit = implicitTargets(text, ctx);
  if (implicit.length) {
    return discuss(
      "direct",
      "",
      [{
        agents: withSpecialists(implicit, specialists),
        parallel: false,
        turn: "normal",
        instruction: "This is a natural continuation addressed to you from the immediately preceding conversation. Answer in context; do not restart, reintroduce yourself, or pretend the message is a new topic.",
      }],
    );
  }

  // Plain chat: specialists that woke up plus the most relevant core members.
  // Technical/visual messages need fewer generalists.
  const coreCount = specialists.length ? 1 : LIMITS.chatAgents;
  return discuss("chat", "", planForMode("chat", specialists, pickChatAgents(text, ctx, coreCount)));
}

/**
 * Live voice call: a mention gives the floor directly; otherwise every relevant member
 * bids and the director picks who speaks (see council/bids.ts).
 */
export function routeLive(msg: IncomingMessage, ctx: RouteContext = { recentSpeakers: [] }): Command {
  const mentioned = findMentions(msg.text).filter((a) => AGENTS[a].kind === "chat" || (a === "iris" && !!msg.imageFileId));
  if (mentioned.length) return discuss("live", "", [{ agents: mentioned, parallel: false, turn: "normal", fast: true, primaryModel: true, maxTokens: 100, reasoning: "normal" }]);
  const specialists = wakeSpecialists(msg);
  const irisFirst: Step[] = specialists.includes("iris") ? [{ agents: ["iris"], parallel: false, turn: "normal", fast: true, primaryModel: true, maxTokens: 100, reasoning: "normal" }] : [];

  if (RECENT_PAIR.test(msg.text) && ctx.recentSpeakers.length) {
    return discuss("live", "", [{
      agents: ctx.recentSpeakers.slice(0, 2),
      parallel: false,
      turn: "normal",
      fast: true,
      primaryModel: true,
      maxTokens: 100,
      reasoning: "normal",
      instruction: "The founder is speaking to the two most recent council speakers. Continue the live conversation directly without an introduction.",
    }]);
  }
  const implicit = implicitTargets(msg.text, ctx);
  if (implicit.length && !specialists.length) {
    return discuss("live", "", [{
      agents: implicit,
      parallel: false,
      turn: "normal",
      fast: true,
      primaryModel: true,
      maxTokens: 100,
      reasoning: "normal",
      instruction: "The founder is continuing your immediately preceding point. Respond directly and naturally; do not reset the conversation.",
    }]);
  }

  const bidders = uniq([...CORE_AGENTS, ...specialists.filter((a) => a !== "iris")]);
  return discuss("live", "", [...irisFirst, { agents: bidders, parallel: true, turn: "normal", bid: true, fast: true, primaryModel: true, maxTokens: 100, reasoning: "normal" }]);
}

export function agentsOf(steps: Step[]): AgentId[] {
  return uniq(steps.flatMap((s) => s.agents));
}
