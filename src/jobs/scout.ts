import type { WorkflowStep } from "cloudflare:workers";
import { effectiveAgent } from "../agents/overrides";
import { AGENTS, AGENT_IDS } from "../agents/registry";
import { postAs, remoteHooks } from "../council/post";
import { MemoryStore } from "../memory/store";
import type { AgentId, Env, Identity } from "../types";
import { runEvalSuite } from "./evals";

const MAX_CANDIDATES = 2;
const MIN_GAIN = 0.1;

/** Chat models from the Workers AI catalog. */
export function textModelIds(models: { name: string; task?: { name?: string } }[]): string[] {
  return models
    .filter((m) => /^@cf\//.test(m.name) && /text generation/i.test(m.task?.name ?? ""))
    .map((m) => m.name);
}

/**
 * Weekly: look for new text models on Workers AI, test each as a candidate replacement
 * for every chat agent on the quick eval suite, and propose swaps that clearly win.
 */
export async function runScout(env: Env, step: WorkflowStep, jobId: number, identity: Identity): Promise<string> {
  const store = new MemoryStore(env.DB, env.AI, env.VECTORIZE);

  const candidates = await step.do("catalog", async () => {
    const pages: { name: string; task?: { name?: string } }[] = [];
    for (let page = 1; page <= 5; page++) {
      const batch = (await env.AI.models({ task: "Text Generation", per_page: 100, page })) as unknown as { name: string; task?: { name?: string } }[];
      pages.push(...batch);
      if (batch.length < 100) break;
    }
    const ids = textModelIds(pages);
    const firstRun = (await store.ops.getSetting("scout_seeded")) !== "1";
    const fresh = await store.ops.markModelsSeen(ids);
    if (firstRun) {
      await store.ops.setSetting("scout_seeded", "1");
      return [] as string[];
    }
    const current = new Set(Object.values(AGENTS).flatMap((a) => [a.model, a.fallbackModel, a.voiceModel]));
    return fresh.filter((id) => !current.has(id)).slice(0, MAX_CANDIDATES);
  });

  if (!candidates.length) {
    await step.do("none", () => postAs(env, store, identity, "nexus", "🛰️ Model scouting: no new text models on Workers AI this week.").then(() => "ok"));
    return "none";
  }

  const lines: string[] = [];
  for (const model of candidates) {
    for (const agent of AGENT_IDS.filter((a) => AGENTS[a].kind === "chat") as AgentId[]) {
      const result = await step.do(`score-${model}-${agent}`, { timeout: "15 minutes", retries: { limit: 1, delay: "1 minute" } }, async () => {
        const a = await effectiveAgent(store, agent);
        const baseline = (await store.ops.latestEval(agent, a.model))?.score ?? (await runEvalSuite(env, store, agent, { quick: true })).score;
        const cand = (await runEvalSuite(env, store, agent, { model, quick: true })).score;
        return { baseline, cand, current: a.model };
      });
      if (result.cand >= result.baseline + MIN_GAIN) {
        await step.do(`propose-${model}-${agent}`, async () => {
          const summary = `switch ${AGENTS[agent].name} from ${result.current} to ${model} (quick eval ${Math.round(result.cand * 100)} vs ${Math.round(result.baseline * 100)})`;
          const approvalId = await store.createApproval({ convId: identity.convId, chatId: identity.chatId, agent, skill: "model.swap", args: { agent, model }, summary });
          await remoteHooks(env, store, identity).requestApproval(approvalId, agent, summary);
          return "proposed";
        });
        lines.push(`✅ ${AGENTS[agent].emoji} ${AGENTS[agent].name}: ${model} beats current (${Math.round(result.cand * 100)} vs ${Math.round(result.baseline * 100)}) — swap proposed`);
      } else {
        lines.push(`▫️ ${AGENTS[agent].emoji} ${AGENTS[agent].name}: ${Math.round(result.cand * 100)} vs ${Math.round(result.baseline * 100)}`);
      }
    }
  }
  await step.do("report", () => postAs(env, store, identity, "nexus", `🛰️ **Model scouting**: tested ${candidates.join(", ")}\n\n${lines.join("\n")}`).then(() => "ok"));
  return lines.join("\n");
}
