import { askJson } from "../ai/json";
import { SYSTEM_MODELS } from "../config";
import type { MemoryStore } from "../memory/store";
import type { Env, Identity } from "../types";
import { callOptions } from "../jobs/common";

/**
 * After the blind round, map who claims what and find the crux: the single question that,
 * if answered, would settle the main disagreement. If it's a factual question, Sage goes
 * and researches it before the debate continues.
 */

export interface ArgumentMap {
  positions: { member: string; position: string }[];
  disagreements: { between: string[]; about: string; crux: string; empirical: boolean }[];
}

export function pickCrux(map: ArgumentMap | null): { crux: string; empirical: boolean } | null {
  const d = map?.disagreements?.find((x) => x?.crux?.trim());
  return d ? { crux: d.crux.trim(), empirical: d.empirical === true } : null;
}

export async function findCrux(env: Env, store: MemoryStore, identity: Identity, discussionId: number): Promise<{ crux: string; empirical: boolean } | null> {
  const msgs = await store.discussionMessages(discussionId);
  if (msgs.filter((m) => m.speaker !== "human").length < 2) return null;
  const text = msgs.map((m) => `${m.speakerName}: ${m.text}`).join("\n\n").slice(0, 20_000);
  const r = await askJson<ArgumentMap>(
    env.AI,
    SYSTEM_MODELS.fast,
    [
      {
        role: "user",
        content: `Map this AI council discussion.\n\n${text}\n\nFor each member give their position in one line. Then list the real disagreements: who disagrees, about what, and the crux (the single question whose answer would settle it). Mark empirical=true if the crux can be answered with research or data (not just values or taste).\nReply with only JSON: {"positions":[{"member":"...","position":"..."}],"disagreements":[{"between":["..."],"about":"...","crux":"...?","empirical":true}]}`,
      },
    ],
    { maxTokens: 700, ...callOptions(env, identity.convId) },
  );
  await store.recordUsage(identity.convId, "nexus", SYSTEM_MODELS.fast, r.promptTokens, r.completionTokens);
  if (r.value) await store.ops.saveArgumentMap(discussionId, identity.convId, r.value);
  return pickCrux(r.value);
}
