import type { MemoryStore } from "../memory/store";
import type { AgentId, Env, Identity } from "../types";
import type { JobParams } from "./types";

export const DEFAULT_MISSION_BUDGET = 300_000;
export const DEFAULT_MISSION_DAYS = 3;

/** Omit that keeps a union discriminated. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewJob = DistributiveOmit<Exclude<JobParams, { kind: "mission" }>, "jobId">;

/** Start a background job (research, design loop, eval, reflection, scouting). Returns the job id. */
export async function startJob(env: Env, store: MemoryStore, params: NewJob): Promise<number> {
  if (!env.JOBS) throw new Error("Background jobs need the JOBS Workflow binding.");
  const convId = params.identity?.convId ?? 0;
  const jobId = await store.ops.createJob(convId, params.kind, params);
  await env.JOBS.create({ id: `job-${jobId}-${Date.now()}`, params: { ...params, jobId } as JobParams });
  return jobId;
}

/** Parse "--budget 200k --days 2" style flags out of a mission goal. */
export function parseMissionFlags(text: string): { goal: string; budget: number; days: number } {
  let budget = DEFAULT_MISSION_BUDGET;
  let days = DEFAULT_MISSION_DAYS;
  const goal = text
    .replace(/--budget\s+(\d+(?:\.\d+)?)([km]?)/i, (_, n: string, unit: string) => {
      const mult = unit.toLowerCase() === "m" ? 1e6 : unit.toLowerCase() === "k" ? 1e3 : 1;
      budget = Math.max(10_000, Math.min(5_000_000, Math.round(Number(n) * mult)));
      return "";
    })
    .replace(/--days\s+(\d+(?:\.\d+)?)/i, (_, n: string) => {
      days = Math.max(0.05, Math.min(30, Number(n)));
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { goal, budget, days };
}

export async function startMission(
  env: Env,
  store: MemoryStore,
  identity: Identity,
  goal: string,
  opts: { budget?: number; days?: number; proposedBy?: AgentId } = {},
): Promise<number> {
  if (!env.JOBS) throw new Error("Missions need the JOBS Workflow binding.");
  const id = await store.ops.createMission({
    convId: identity.convId,
    chatId: identity.chatId,
    dmAgent: identity.dmAgent,
    goal,
    tokenBudget: opts.budget ?? DEFAULT_MISSION_BUDGET,
    deadlineAt: Date.now() + (opts.days ?? DEFAULT_MISSION_DAYS) * 86400_000,
  });
  const instance = await env.JOBS.create({ id: `mission-${id}-${Date.now()}`, params: { kind: "mission", missionId: id, identity } });
  await store.ops.updateMission(id, { instance_id: instance.id });
  return id;
}
