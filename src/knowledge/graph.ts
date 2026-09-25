import { askJson } from "../ai/json";
import { SYSTEM_MODELS } from "../config";
import { callOptions } from "../jobs/common";
import type { MemoryStore } from "../memory/store";
import type { Env, Identity } from "../types";

/**
 * Structured memory: entities (projects, people, companies, products, tools, decisions),
 * their current facts, and relations. New facts that contradict current ones become
 * conflicts for the founder to settle instead of silently overwriting.
 */

export interface Extraction {
  entities?: { name: string; type: string; summary?: string }[];
  facts?: { entity: string; attribute: string; value: string }[];
  relations?: { subject: string; predicate: string; object: string }[];
}

export interface NewConflict {
  id: number;
  entity: string;
  attribute: string;
  oldValue: string;
  newValue: string;
}

export function normalizeValue(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Same meaning if equal after normalization or one contains the other. */
export function sameValue(a: string, b: string): boolean {
  const x = normalizeValue(a);
  const y = normalizeValue(b);
  return x === y || (x.length > 3 && y.length > 3 && (x.includes(y) || y.includes(x)));
}

export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 80);
}

export async function extractGraph(env: Env, store: MemoryStore, identity: Identity, text: string, source: string): Promise<NewConflict[]> {
  const r = await askJson<Extraction>(
    env.AI,
    SYSTEM_MODELS.fast,
    [
      {
        role: "user",
        content: `Extract structured knowledge from this AI council discussion about the founder's work.\n\n${text.slice(0, 16_000)}\n\nOnly things stated as true or decided (not proposals). Entity types: project, person, company, product, tool, market, decision. Facts are current attributes (e.g. "database" = "Supabase", "price" = "$29/mo", "status" = "launched").\nReply with only JSON: {"entities":[{"name":"...","type":"...","summary":"..."}],"facts":[{"entity":"...","attribute":"...","value":"..."}],"relations":[{"subject":"...","predicate":"uses|competes_with|owns|part_of|built_with|targets","object":"..."}]}`,
      },
    ],
    { maxTokens: 900, ...callOptions(env, identity.convId) },
  );
  await store.recordUsage(identity.convId, "nexus", SYSTEM_MODELS.fast, r.promptTokens, r.completionTokens);
  const x = r.value;
  if (!x) return [];

  const ids = new Map<string, number>();
  const idFor = async (name: string, type = "thing", summary = "") => {
    const key = cleanName(name);
    if (!key) return null;
    const cached = ids.get(key.toLowerCase());
    if (cached) return cached;
    const id = await store.ops.upsertEntity(identity.convId, key, type.toLowerCase().slice(0, 20), summary.slice(0, 300));
    ids.set(key.toLowerCase(), id);
    return id;
  };

  for (const e of (x.entities ?? []).slice(0, 12)) await idFor(e.name, e.type, e.summary ?? "");
  const conflicts: NewConflict[] = [];
  for (const f of (x.facts ?? []).slice(0, 15)) {
    const entityId = await idFor(f.entity);
    if (!entityId || !f.attribute || !f.value) continue;
    const attribute = f.attribute.toLowerCase().slice(0, 60);
    const value = String(f.value).slice(0, 300);
    const current = await store.ops.currentFact(entityId, attribute);
    if (!current) {
      await store.ops.addFact(entityId, attribute, value, source);
    } else if (!sameValue(current.value, value)) {
      const id = await store.ops.addConflict({ convId: identity.convId, entityId, attribute, oldFactId: current.id, newValue: value, source });
      conflicts.push({ id, entity: cleanName(f.entity), attribute, oldValue: current.value, newValue: value });
    }
  }
  for (const rel of (x.relations ?? []).slice(0, 12)) {
    const s = await idFor(rel.subject);
    const o = await idFor(rel.object);
    if (s && o && s !== o) await store.ops.addRelation(identity.convId, s, rel.predicate.toLowerCase().slice(0, 30), o);
  }
  return conflicts;
}
