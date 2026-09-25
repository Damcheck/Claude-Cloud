import { effectiveAgent } from "../agents/overrides";
import { AGENTS, CORE_AGENTS } from "../agents/registry";
import { askJson } from "../ai/json";
import { callOptions } from "../jobs/common";
import type { MemoryStore } from "../memory/store";
import type { AgentId, Env, Identity } from "../types";
import { postAs } from "./post";

/**
 * Calibrated forecasting. Each core member gives a probability; the council's number is a
 * weighted, extremized average where weights come from each member's Brier score
 * (in this domain when it has enough history).
 */

export interface Resolved {
  p: number;
  o: number;
  domain: string;
}

export function brier(preds: Pick<Resolved, "p" | "o">[]): number | null {
  if (!preds.length) return null;
  return preds.reduce((acc, x) => acc + (x.p - x.o) ** 2, 0) / preds.length;
}

/** Weight from track record: unknown members get the default; good forecasters count more. */
export function weightFor(preds: Resolved[], domain: string, minHistory = 3): number {
  const inDomain = preds.filter((x) => x.domain === domain);
  const use = inDomain.length >= minHistory ? inDomain : preds;
  if (use.length < minHistory) return 1;
  return 0.3 / ((brier(use) ?? 0.25) + 0.05); // Brier 0.25 (coin flip) → 1.0
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function aggregate(forecasts: { p: number; w: number }[], extremize = 1.3): number {
  const valid = forecasts.filter((f) => Number.isFinite(f.p) && f.w > 0);
  if (!valid.length) return 0.5;
  const clamp = (p: number) => Math.min(0.98, Math.max(0.02, p));
  const total = valid.reduce((a, f) => a + f.w, 0);
  const mean = valid.reduce((a, f) => a + f.w * logit(clamp(f.p)), 0) / total;
  return clamp(sigmoid(mean * extremize));
}

interface AgentForecast {
  probability?: number;
  reasoning?: string;
  check_in_days?: number;
  domain?: string;
}

export async function runForecast(env: Env, store: MemoryStore, identity: Identity, question: string): Promise<void> {
  const members = identity.dmAgent ? [identity.dmAgent] : CORE_AGENTS;
  const results = await Promise.all(
    members.map(async (agent) => {
      const a = await effectiveAgent(store, agent);
      const r = await askJson<AgentForecast>(
        env.AI,
        a.model,
        [
          { role: "system", content: `You are ${a.name}, ${a.role} in an AI council. ${a.personality}` },
          {
            role: "user",
            content: `Forecast this question independently: "${question}"\nGive the probability it resolves YES, one sentence of reasoning, when it can be checked, and a one-word domain (e.g. market, tech, timeline, product, finance).\nReply with only JSON: {"probability": 0.0-1.0, "reasoning": "...", "check_in_days": n, "domain": "..."}`,
          },
        ],
        { maxTokens: 300, ...callOptions(env, identity.convId) },
      ).catch(() => ({ value: null, promptTokens: 0, completionTokens: 0 }));
      await store.recordUsage(identity.convId, agent, a.model, r.promptTokens, r.completionTokens);
      return { agent, f: r.value };
    }),
  );

  const valid = results.filter((r): r is { agent: AgentId; f: AgentForecast } => !!r.f && Number.isFinite(Number(r.f.probability)));
  if (!valid.length) {
    await postAs(env, store, identity, identity.dmAgent ?? "nexus", "Couldn't get forecasts from the members this time.");
    return;
  }
  const domain = mode(valid.map((v) => String(v.f.domain ?? "general").toLowerCase()));
  const days = median(valid.map((v) => Number(v.f.check_in_days) || 30));
  const weighted = await Promise.all(
    valid.map(async (v) => ({ ...v, p: Math.min(1, Math.max(0, Number(v.f.probability))), w: weightFor(await store.ops.resolvedPredictions(v.agent), domain) })),
  );
  const council = aggregate(weighted.map((x) => ({ p: x.p, w: x.w })));
  const group = await store.ops.nextForecastGroup();
  const checkAt = Date.now() + Math.min(365, Math.max(1, days)) * 86400_000;
  for (const x of weighted) {
    await store.ops.addForecast({ convId: identity.convId, agent: x.agent, claim: question, probability: x.p, checkAt, domain, group });
  }
  await store.ops.addForecast({ convId: identity.convId, agent: "council", claim: question, probability: council, checkAt, domain, group });

  const rows = weighted
    .sort((a, b) => b.p - a.p)
    .map((x) => `${AGENTS[x.agent].emoji} ${AGENTS[x.agent].name}: **${Math.round(x.p * 100)}%** (weight ${x.w.toFixed(2)}) — ${String(x.f.reasoning ?? "").slice(0, 200)}`)
    .join("\n");
  await postAs(
    env,
    store,
    identity,
    identity.dmAgent ?? "nexus",
    `🎲 **Forecast #${group}**: ${question}\n\n${rows}\n\n**Council: ${Math.round(council * 100)}%** (${domain}, check ${new Date(checkAt).toISOString().slice(0, 10)})\nResolve with \`/resolve ${group} yes\` or \`/resolve ${group} no\`.`,
  );
}

export async function calibrationReport(store: MemoryStore): Promise<string> {
  const lines: string[] = [];
  for (const agent of [...CORE_AGENTS, "cipher", "forge", "council"] as (AgentId | "council")[]) {
    const preds = await store.ops.resolvedPredictions(agent);
    if (!preds.length) continue;
    const overall = brier(preds)!;
    const domains = [...new Set(preds.map((p) => p.domain))]
      .map((d) => {
        const inD = preds.filter((p) => p.domain === d);
        return inD.length >= 2 ? `${d} ${brier(inD)!.toFixed(2)}` : null;
      })
      .filter(Boolean)
      .join(", ");
    const name = agent === "council" ? "🏛️ Council" : `${AGENTS[agent].emoji} ${AGENTS[agent].name}`;
    lines.push(`${name}: Brier ${overall.toFixed(3)} over ${preds.length}${domains ? ` (${domains})` : ""}`);
  }
  return lines.length ? `Calibration (Brier: 0 perfect, 0.25 coin flip):\n${lines.join("\n")}` : "";
}

function mode(xs: string[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "general";
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 30;
}
