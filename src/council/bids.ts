import { buildSystemPrompt } from "../agents/prompts";
import { AGENTS } from "../agents/registry";
import { runChat, type CallOptions } from "../ai/workers-ai";
import { LIMITS, SYSTEM_MODELS } from "../config";
import type { MemoryStore } from "../memory/store";
import type { AgentId, TranscriptMessage } from "../types";

/**
 * Live calls don't go round the table. Every candidate privately says whether it wants
 * to speak and how important its point is; the director gives the floor to the best bids.
 */

export interface Bid {
  agent: AgentId;
  wantToSpeak: boolean;
  importance: number;
  reason: string;
}

export function parseBid(agent: AgentId, raw: string): Bid {
  const none: Bid = { agent, wantToSpeak: false, importance: 0, reason: "" };
  const json = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").match(/\{[\s\S]*\}/)?.[0];
  if (!json) return none;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const importance = Math.min(1, Math.max(0, Number(o.importance) || 0));
    const want = o.want_to_speak === true || o.want_to_speak === "true";
    return { agent, wantToSpeak: want, importance, reason: String(o.reason ?? "").slice(0, 200) };
  } catch {
    return none;
  }
}

/**
 * Highest bids first, only those who want to speak and clear the bar. If nobody does but
 * the founder asked a question, the most relevant member answers anyway: silence after a
 * direct question feels broken.
 */
export function chooseSpeakers(bids: Bid[], utterance: string, max: number = LIMITS.liveMaxSpeakers, min: number = LIMITS.liveMinImportance): AgentId[] {
  const ranked = [...bids].sort((a, b) => b.importance - a.importance);
  const chosen = ranked.filter((b) => b.wantToSpeak && b.importance >= min).slice(0, max);
  // Silence feels broken in a call. Any meaningful founder utterance gets at least one
  // speaker even if every bid was malformed, timid, or below the normal threshold.
  if (!chosen.length && utterance.replace(/[^\p{L}\p{N}]/gu, "").length >= 2 && ranked[0]) {
    return [ranked[0].agent];
  }
  return chosen.map((b) => b.agent);
}

const BID_INSTRUCTION = `You're in a live voice call with the founder and the other council members. Listen to the exact wording and the recent turn sequence, then decide whether YOU should speak next.
The founder usually speaks naturally without commands or names. Infer attention like a human: a short "why?", "go on", "prove that", "what do you mean?", "do it", or second-person reference normally belongs to the most recent speaker; "both of you" belongs to the last two; "everyone/the council" opens the floor; a role-specific request belongs to the relevant expert.
Bid very strongly if the founder implicitly addressed you, asked for your specialty, or continued your last point. Speak if you have something new and useful; stay quiet if the remark clearly belongs to somebody else.
Bid strongly when another member just made a consequential claim you can specifically challenge, correct or extend. Do not bid merely to agree.
Reply with ONLY this JSON and nothing else:
{"want_to_speak": true|false, "importance": 0.0-1.0, "reason": "a few words"}`;

export async function collectBids(
  ai: Ai,
  store: MemoryStore,
  agents: AgentId[],
  transcript: TranscriptMessage[],
  callOptions: CallOptions,
  convId: number,
): Promise<Bid[]> {
  const recent = transcript
    .slice(-10)
    .map((m) => `${m.speakerName}: ${m.text}`)
    .join("\n");
  return Promise.all(
    agents.map(async (agent): Promise<Bid> => {
      const a = AGENTS[agent];
      try {
        const system = buildSystemPrompt({
          agent,
          mode: "live",
          turn: "normal",
          topic: "",
          transcript: [],
          groupFacts: [],
          privateMemories: [],
          skillSummaries: [],
        });
        const r = await runChat(
          ai,
          SYSTEM_MODELS.fast,
          [
            { role: "system", content: system },
            { role: "user", content: `Call so far:\n${recent}\n\n${BID_INSTRUCTION}` },
          ],
          { maxTokens: 80, ...callOptions, timeoutMs: 3_000, metadata: { ...callOptions.metadata, agent, purpose: "bid" } },
        );
        await store.recordUsage(convId, agent, SYSTEM_MODELS.fast, r.usage.promptTokens, r.usage.completionTokens);
        return parseBid(agent, r.text);
      } catch (err) {
        console.warn(`${a.name} bid failed`, err);
        return { agent, wantToSpeak: false, importance: 0, reason: "" };
      }
    }),
  );
}
