import type { MemoryStore } from "../memory/store";
import type { AgentId } from "../types";
import { AGENTS, type AgentConfig } from "./registry";

/**
 * Agents can change at runtime: model scouting swaps a model, self-improvement swaps a
 * personality (both only after the founder approves). Cached briefly per isolate.
 */
let cache: { at: number; map: Map<string, { model: string | null; personality: string | null }> } | null = null;
const TTL_MS = 60_000;

export function clearOverrideCache(): void {
  cache = null;
}

export async function effectiveAgent(store: MemoryStore, id: AgentId): Promise<AgentConfig> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    try {
      cache = { at: Date.now(), map: await store.ops.overrides() };
    } catch {
      cache = { at: Date.now(), map: new Map() };
    }
  }
  const o = cache.map.get(id);
  const base = AGENTS[id];
  if (!o) return base;
  return { ...base, model: o.model ?? base.model, personality: o.personality ?? base.personality };
}
