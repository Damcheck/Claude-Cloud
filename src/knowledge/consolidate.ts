import { AGENTS, AGENT_IDS } from "../agents/registry";
import { askJson } from "../ai/json";
import type { MemoryStore } from "../memory/store";
import type { Env } from "../types";

const MAX_ACTIVE = 40;
const TARGET = 20;

/**
 * Nightly: when an agent's private memory grows past 40 notes, merge it into at most 20
 * non-redundant ones. Old notes are archived, not deleted.
 */
export async function consolidateMemories(env: Env, store: MemoryStore, homeConvId: number): Promise<string[]> {
  const done: string[] = [];
  for (const agent of AGENT_IDS.filter((a) => AGENTS[a].kind === "chat")) {
    const notes = await store.ops.activeMemories(agent);
    if (notes.length <= MAX_ACTIVE) continue;
    const a = AGENTS[agent];
    const r = await askJson<{ notes?: string[] }>(
      env.AI,
      a.voiceModel,
      [
        {
          role: "user",
          content: `You are ${a.name}. These are your private notes, oldest first:\n${notes.map((n) => `- ${n.memory}`).join("\n")}\n\nMerge them into at most ${TARGET} notes: remove duplicates and outdated items (newer notes win), keep specifics (names, numbers, dates, the founder's preferences). Reply with only JSON: {"notes": ["..."]}`,
        },
      ],
      { maxTokens: 1500 },
    );
    await store.recordUsage(homeConvId, agent, a.voiceModel, r.promptTokens, r.completionTokens, "consolidate");
    const merged = (r.value?.notes ?? []).map(String).filter((n) => n.trim()).slice(0, TARGET);
    if (merged.length < 5) continue; // don't risk losing memory on a bad answer
    await store.ops.archiveMemories(notes.map((n) => n.id));
    for (const note of merged) await store.addAgentMemory(homeConvId, agent, note.slice(0, 500));
    done.push(`${a.name}: ${notes.length} → ${merged.length}`);
  }
  return done;
}
