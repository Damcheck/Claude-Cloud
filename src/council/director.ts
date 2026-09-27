import { AGENTS, isAgentId } from "../agents/registry";
import { runChat, type CallOptions } from "../ai/workers-ai";
import { SYSTEM_MODELS } from "../config";
import type { MemoryStore } from "../memory/store";
import type { AgentId, IncomingMessage, ReasoningMode, TranscriptMessage } from "../types";
import { wakeSpecialists, type Command, type Step } from "./router";

export type NaturalIntent = "social" | "answer" | "solve" | "debate" | "brainstorm" | "critic" | "research" | "build" | "coordinate" | "all";

export interface Direction {
  intent: NaturalIntent;
  agents: AgentId[];
  reason: string;
  reasoning: ReasoningMode;
}

const INTENTS = new Set<NaturalIntent>(["social", "answer", "solve", "debate", "brainstorm", "critic", "research", "build", "coordinate", "all"]);

const CAPABILITY_FOLLOW_UP = /\b(?:who\s+(?:is|will|can|wants?|cares?|is\s+(?:in\s+)?caring|is\s+going)\s+(?:to\s+)?(?:do|handle|take|build|work\s+on)|who'?s\s+(?:doing|handling|taking|building)|which\s+(?:agent|member|one)\s+(?:can|should|will))\b/i;
const SECURITY_BUILD = /\b(?:cyber\s*security|penetration\s*test(?:ing)?|pen\s*test(?:ing)?|attack(?:ing)?\s+(?:tool|site|lab)|security\s+(?:tool|lab|test(?:ing)?))\b/i;
const SIMPLE_SOCIAL = /^\s*(?:(?:hello|hi|hey|yo)(?:\s+(?:everyone|everybody|all|guys|people|council|una))?|good\s+(?:morning|afternoon|evening)|how\s+(?:are|far)\s+(?:you|una)(?:\s+(?:all|everyone))?|(?:thanks?|thank\s+you)(?:\s+(?:all|everyone|everybody))?|(?:bye|goodbye|bye[ -]?bye|see\s+you)(?:\s+(?:all|everyone|everybody))?)[\s!.?]*$/i;

export function isSimpleSocialMessage(text: string): boolean {
  return SIMPLE_SOCIAL.test(text);
}

/** High-confidence colloquial intents should not be left to a small routing model. */
export function inferDeterministicDirection(
  text: string,
  transcript: readonly TranscriptMessage[],
  available: readonly AgentId[],
): Direction | null {
  const priorHuman = [...transcript].reverse().find((message) => message.speaker === "human")?.text ?? "";
  const inheritsPriorTask = CAPABILITY_FOLLOW_UP.test(text);
  const context = inheritsPriorTask ? `${priorHuman}\n${text}` : text;
  if (!SECURITY_BUILD.test(context)) return null;
  const allowed = new Set(available);
  const specialists = wakeSpecialists({ text: context }).filter((id) => allowed.has(id));
  const preferred = ["cipher", "forge", "sage", "nexus"].filter((id): id is AgentId => isAgentId(id) && allowed.has(id));
  const agents = [...new Set([...specialists, ...preferred])].slice(0, Math.min(4, available.length));
  return {
    intent: "build",
    agents,
    reason: inheritsPriorTask
      ? `capability follow-up about the previous cybersecurity task: ${priorHuman.slice(0, 100)}`
      : "cybersecurity tooling request; propose an isolated authorized lab, not third-party targeting",
    reasoning: "deep",
  };
}

export function parseDirection(raw: string, available: readonly AgentId[]): Direction | null {
  const json = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const value = JSON.parse(json) as { intent?: unknown; agents?: unknown; reason?: unknown; reasoning?: unknown };
    const intent = String(value.intent ?? "") as NaturalIntent;
    if (!INTENTS.has(intent)) return null;
    const allowed = new Set(available);
    const agents = Array.isArray(value.agents)
      ? [...new Set(value.agents.map(String).filter((id): id is AgentId => isAgentId(id) && allowed.has(id)))].slice(0, 4)
      : [];
    const requested = String(value.reasoning ?? "normal");
    const reasoning: ReasoningMode = requested === "fast" || requested === "deep" ? requested : "normal";
    return { intent, agents, reason: String(value.reason ?? "").slice(0, 180), reasoning };
  } catch {
    return null;
  }
}

function step(
  agents: AgentId[],
  parallel: boolean,
  instruction: string,
  turn: Step["turn"] = "normal",
  maxTokens = 90,
  primaryModel = true,
  reasoning: ReasoningMode = "normal",
  tools = true,
): Step {
  return { agents, parallel, turn, instruction, fast: true, maxTokens, primaryModel, reasoning, tools };
}

/** Convert a semantic direction into a bounded discussion plan. */
export function directedCommand(direction: Direction, available: readonly AgentId[], live: boolean): Command {
  const allowed = new Set(available);
  const availableIds = available.filter((id) => AGENTS[id].kind === "chat");
  const selected = direction.agents.filter((id) => allowed.has(id));
  const nexus = allowed.has("nexus") ? (["nexus"] as AgentId[]) : [];
  const chosen = selected.length ? selected : nexus.length ? nexus : availableIds.slice(0, 1);
  const explicitAll = availableIds.length > 0 && availableIds.every((id) => selected.includes(id));
  const goal = `Interpret the founder's ordinary language by meaning, not grammar. The conversation director classified this as ${direction.intent}${direction.reason ? ` (${direction.reason})` : ""}. Respond to the actual request and recent context; never wait for a slash command or a name mention.`;

  if (direction.intent === "social") {
    const speakers = explicitAll ? chosen : chosen.slice(0, 2);
    const social = "Answer only the founder's newest casual line, literally and naturally, in 2–10 words. If they ask how you are, answer how you are and optionally ask back. Do not revive older topics or imitate another member's response. Never say ‘finally’, ‘some peace’, ‘some calm’, ‘about time’, or any variation of those phrases. Do not ask a business question.";
    return { kind: "discuss", mode: live ? "live" : "chat", topic: "", agents: speakers, steps: speakers.map((agent) => step([agent], false, social, "normal", 35, true, "fast", false)) };
  }

  if (live) {
    const speakers = direction.intent === "all" || explicitAll ? availableIds : chosen.slice(0, direction.intent === "debate" ? 4 : 3);
    return { kind: "discuss", mode: "live", topic: "", agents: speakers, steps: speakers.map((agent) => step([agent], false, `${goal} Speak naturally, react to earlier speakers, and complete one useful thought.`, "normal", 100, true, direction.reasoning, false)) };
  }

  if (direction.intent === "all") {
    return { kind: "discuss", mode: "direct", topic: "", agents: availableIds, steps: [step(availableIds, true, `${goal} Every available member must answer once from their own role.`, "blind", 75, true, direction.reasoning)] };
  }
  if (direction.intent === "debate") {
    const speakers = chosen.slice(0, explicitAll ? availableIds.length : 4);
    const steps = [
      step(speakers, true, `${goal} Take a definite independent position in one compact point.`, "blind", 90, true, direction.reasoning),
      ...speakers.map((agent) => step([agent], false, `${goal} Challenge one specific opposing point by name; do not recap the discussion.`, "followUp", 75, true, direction.reasoning)),
      ...(nexus.length ? [step(nexus, false, `${goal} Preserve the real disagreement and give the founder the decision crux briefly.`, "summary", 120, true, direction.reasoning)] : []),
    ];
    return { kind: "discuss", mode: "debate", topic: "", agents: [...new Set(steps.flatMap((s) => s.agents))], steps };
  }
  if (["solve", "brainstorm", "critic", "research", "build"].includes(direction.intent)) {
    const experts = chosen.slice(0, explicitAll ? availableIds.length : 4);
    const firstInstruction: Record<string, string> = {
      solve: "Diagnose the real problem, propose a concrete solution, and state the next action.",
      brainstorm: "Generate a distinct, useful option; build on good ideas without repeating them.",
      critic: "Stress-test the proposal, identify the most dangerous failure, and give a repair.",
      research: "Separate facts from assumptions and verify material claims with tools when useful.",
      build: "Turn the request into an implementable design or patch with acceptance criteria.",
    };
    const steps = [step(experts, true, `${goal} ${firstInstruction[direction.intent]}`, "blind", 110, true, direction.reasoning)];
    if (experts.length > 1) {
      steps.push(step([experts[0]!], false, `${goal} Read the other members' answers. Respond to the strongest one by name: challenge its weak assumption or build on it with a sharper move. Do not recap.`, "followUp", 75, true, direction.reasoning));
    }
    if (nexus.length && (experts.length > 1 || direction.intent === "solve")) steps.push(step(nexus, false, `${goal} Synthesize the strongest solution into clear next steps without repeating the whole discussion.`, "summary", 140, true, direction.reasoning));
    return { kind: "discuss", mode: direction.intent === "brainstorm" ? "brainstorm" : direction.intent === "critic" ? "critic" : "council", topic: "", agents: [...new Set(steps.flatMap((s) => s.agents))], steps };
  }

  const targetCount = explicitAll ? availableIds.length : Math.min(3, availableIds.length);
  const speakers = [...new Set([...chosen, ...availableIds.filter((id) => !chosen.includes(id))])].slice(0, targetCount);
  const steps = speakers.map((agent, index) =>
    step(
      [agent],
      false,
      index === 0
        ? `${goal} Take a clear position; do not hide behind generic caveats.`
        : `${goal} The previous member just answered. React to that exact point like a real group member: challenge it, sharpen it, or disagree by name. Do not give a second disconnected essay.`,
      index === 0 ? "normal" : "followUp",
      index === 0 ? 80 : 70,
      true,
      direction.reasoning,
    ),
  );
  // With only two participants, let the opener answer the objection. Three or more
  // already creates a natural multi-person exchange without making every message noisy.
  if (speakers.length === 2) {
    steps.push(
      step(
        [speakers[0]!],
        false,
        `${goal} The other member just reacted to you. Answer their exact objection or extension in one sharp message. Concede if they beat your point; otherwise push back. Do not wait for the founder and do not restart the topic.`,
        "followUp",
        60,
        true,
        direction.reasoning,
      ),
    );
  }
  return { kind: "discuss", mode: "chat", topic: "", agents: speakers, steps };
}

export async function directNaturalMessage(args: {
  ai: Ai;
  store: MemoryStore;
  msg: IncomingMessage;
  transcript: TranscriptMessage[];
  available: AgentId[];
  live: boolean;
  options: CallOptions;
}): Promise<Command | null> {
  if (!args.available.length) return null;
  const deterministic = inferDeterministicDirection(args.msg.text, args.transcript, args.available);
  if (deterministic) return directedCommand(deterministic, args.available, args.live);
  if (isSimpleSocialMessage(args.msg.text)) {
    const recent = [...new Set(args.transcript.filter((m) => isAgentId(m.speaker)).map((m) => m.speaker as AgentId).reverse())];
    const rotating = [...args.available].sort((a, b) => {
      const ai = recent.indexOf(a), bi = recent.indexOf(b);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    }).reverse();
    return directedCommand({ intent: "social", agents: rotating.slice(0, 2), reason: "casual greeting", reasoning: "fast" }, args.available, args.live);
  }
  const roster = args.available.map((id) => `${id}: ${AGENTS[id].role}`).join("; ");
  const recent = args.transcript.slice(-12).map((m) => `${m.speakerName}: ${m.text}`).join("\n");
  const result = await runChat(
    args.ai,
    SYSTEM_MODELS.fast,
    [
      {
        role: "system",
        content: `You direct an AI council conversation. Understand informal English, Nigerian English/Pidgin, typos, fragments, implied requests and conversational context. Decide the interaction the founder actually wants, which members should answer, and the minimum reasoning depth needed. Do not answer the founder yourself.\n\nIntents: social (greetings, jokes, casual reactions), answer (ordinary reply), solve (diagnose and produce a solution), debate (members should argue opposing positions), brainstorm, critic, research, build (technical implementation), coordinate (plans/status/next steps), all (the founder clearly wants every member).\n\nReasoning: fast for casual/simple/familiar questions; normal for ordinary analysis and conversation; deep only for complex strategy, difficult debugging, research synthesis, high-stakes choices, multi-step logic, forecasts or serious debate.\n\nRoster: ${roster}\n\nChoose 1-2 agents for a casual social exchange, 3 for ordinary discussion, and 3-4 for solving, research, building or debate. Rotate participation: prefer relevant members who have not just dominated the recent transcript. Use all only when the founder clearly says everyone, all of you, the whole council, or equivalent. Reply only as JSON: {"intent":"solve","agents":["atlas","axiom","sage"],"reason":"short reason","reasoning":"normal"}`,
      },
      { role: "user", content: `Recent conversation:\n${recent || "(none)"}\n\nFounder's newest message:\n${args.msg.text}` },
    ],
    { ...args.options, maxTokens: 120, timeoutMs: args.live ? 2_000 : 3_500, metadata: { ...args.options.metadata, purpose: "conversation_director" } },
  );
  await args.store.recordUsage(args.msg.convId, "nexus", SYSTEM_MODELS.fast, result.usage.promptTokens, result.usage.completionTokens);
  const direction = parseDirection(result.text, args.available);
  if (direction) {
    // A small routing model occasionally calls any conversational sentence "social".
    // Only accept that label for an actual greeting/thanks/goodbye; substantive
    // questions must reach the council as answers.
    if (direction.intent === "social" && !isSimpleSocialMessage(args.msg.text)) {
      direction.intent = "answer";
      direction.reasoning = "normal";
      direction.reason = `substantive message misclassified as social${direction.reason ? `; ${direction.reason}` : ""}`.slice(0, 180);
    }
    const wantsAll = /\b(all of you|everyone|everybody|whole council|entire council|remaining (?:of you|members?|agents?))\b/i.test(args.msg.text);
    if (wantsAll) {
      direction.agents = [...args.available];
    } else if (direction.intent !== "social") {
      const desired = ["solve", "debate", "brainstorm", "critic", "research", "build"].includes(direction.intent) ? 4 : 3;
      const recency = [...new Set(args.transcript.filter((m) => isAgentId(m.speaker)).map((m) => m.speaker as AgentId).reverse())];
      const fresh = args.available
        .filter((id) => !direction.agents.includes(id))
        .sort((a, b) => {
          const ai = recency.indexOf(a), bi = recency.indexOf(b);
          return (bi === -1 ? 999 : bi) - (ai === -1 ? 999 : ai);
        });
      direction.agents = [...new Set([...direction.agents, ...fresh])].slice(0, Math.min(desired, args.available.length));
    }
    if (["build", "solve", "research"].includes(direction.intent)) {
      const specialists = wakeSpecialists(args.msg).filter((id) => args.available.includes(id));
      direction.agents = [...new Set([...specialists, ...direction.agents])].slice(0, Math.min(4, args.available.length));
    }
  }
  return direction ? directedCommand(direction, args.available, args.live) : null;
}
