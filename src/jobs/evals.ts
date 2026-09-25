import { AGENTS } from "../agents/registry";
import { runAgentTurn } from "../agents/runner";
import { askJson } from "../ai/json";
import { SYSTEM_MODELS } from "../config";
import { SCENARIOS, checkScenario, judgePrompt, scenarioTranscript, scoreScenario, type JudgeScores, type ScenarioResult } from "../evals/suite";
import type { MemoryStore } from "../memory/store";
import type { AgentId, Env } from "../types";
import { EVAL_CONV, callOptions, jobContext } from "./common";

const NAMES = Object.fromEntries(Object.values(AGENTS).map((a) => [a.id, a.name]));

export interface EvalOutcome {
  agent: AgentId;
  model: string;
  score: number;
  results: ScenarioResult[];
}

/**
 * Run the behavioural suite for one agent, optionally with a different model or personality.
 * Runs in the eval conversation (dry-run: skills never change anything).
 */
export async function runEvalSuite(
  env: Env,
  store: MemoryStore,
  agent: AgentId,
  opts: { model?: string; personality?: string; quick?: boolean } = {},
): Promise<EvalOutcome> {
  await store.ops.setSetting(`dry_run:${EVAL_CONV}`, "1");
  const scenarios = SCENARIOS.filter((s) => !opts.quick || s.quick).filter((s) => !s.lines.some(([speaker]) => speaker === agent));
  const ctx = jobContext(env, store, { convId: EVAL_CONV, chatId: EVAL_CONV }, agent, { tag: "eval" });
  const model = opts.model ?? AGENTS[agent].model;
  const results: ScenarioResult[] = [];

  for (const s of scenarios) {
    const transcript = scenarioTranscript(s, NAMES);
    let reply: string | null = null;
    try {
      reply = await runAgentTurn(
        { mode: s.mode, turn: s.turn, topic: s.topic, transcript, instruction: s.instruction, modelOverride: opts.model, personalityOverride: opts.personality },
        ctx,
      );
    } catch (err) {
      console.warn(`eval ${agent}/${s.id} failed`, err);
      results.push({ id: s.id, passed: false, words: 0, checks: 0, judge: null, score: 0 });
      continue;
    }
    const check = checkScenario(s, reply);
    let judge: JudgeScores | null = null;
    if (reply) {
      const text = transcript.map((m) => `${m.speakerName}: ${m.text}`).join("\n");
      const r = await askJson<JudgeScores>(env.AI, SYSTEM_MODELS.fast, [{ role: "user", content: judgePrompt(s, text, reply) }], {
        maxTokens: 120,
        ...callOptions(env, EVAL_CONV),
      }).catch(() => ({ value: null, promptTokens: 0, completionTokens: 0 }));
      await store.recordUsage(EVAL_CONV, "nexus", SYSTEM_MODELS.fast, r.promptTokens, r.completionTokens, "eval");
      judge = r.value;
    }
    results.push({ id: s.id, ...check, judge, score: scoreScenario(s, check, judge) });
  }

  const score = results.length ? results.reduce((a, r) => a + r.score, 0) / results.length : 0;
  await store.ops.saveEval(agent, model, opts.personality ?? null, score, results);
  return { agent, model, score, results };
}

export function formatEval(o: EvalOutcome): string {
  const cells = o.results.map((r) => `${r.id} ${Math.round(r.score * 100)}`).join(" · ");
  return `${AGENTS[o.agent].emoji} ${AGENTS[o.agent].name} (${o.model.split("/").pop()}): ${Math.round(o.score * 100)}/100\n   ${cells}`;
}
