import { AGENTS, isAgentId } from "../agents/registry";
import type { MissionTaskRow } from "../memory/ops";
import type { AgentId } from "../types";

export interface PlannedTask {
  key: string;
  title: string;
  detail: string;
  assignee: AgentId;
  dependsOn: string[];
}

export const MAX_TASKS = 12;

/**
 * Turn a model's plan into valid tasks: known chat agents only, unique keys, dependencies
 * that exist, and no cycles (a task whose dependencies can never finish is dropped).
 */
export function validatePlan(raw: unknown, existingKeys: string[] = []): PlannedTask[] {
  const list = (raw as { tasks?: unknown })?.tasks ?? raw;
  if (!Array.isArray(list)) return [];
  const tasks: PlannedTask[] = [];
  const keys = new Set(existingKeys);
  for (const item of list.slice(0, MAX_TASKS) as Record<string, unknown>[]) {
    const assignee = String(item?.assignee ?? "").toLowerCase();
    if (!isAgentId(assignee) || AGENTS[assignee].kind !== "chat") continue;
    let key = String(item?.key ?? `t${tasks.length + 1}`).replace(/[^\w-]/g, "").slice(0, 20) || `t${tasks.length + 1}`;
    while (keys.has(key)) key += "x";
    keys.add(key);
    tasks.push({
      key,
      title: String(item?.title ?? "").slice(0, 200) || key,
      detail: String(item?.detail ?? "").slice(0, 1500),
      assignee,
      dependsOn: (Array.isArray(item?.depends_on) ? item.depends_on : Array.isArray(item?.dependsOn) ? item.dependsOn : []).map(String),
    });
  }
  // Keep only dependencies on known tasks, then drop anything caught in a cycle.
  for (const t of tasks) t.dependsOn = t.dependsOn.filter((d) => keys.has(d) && d !== t.key);
  const resolvable = new Set(existingKeys);
  let progress = true;
  while (progress) {
    progress = false;
    for (const t of tasks) {
      if (!resolvable.has(t.key) && t.dependsOn.every((d) => resolvable.has(d))) {
        resolvable.add(t.key);
        progress = true;
      }
    }
  }
  return tasks.filter((t) => resolvable.has(t.key));
}

export type MissionState = "run" | "done" | "blocked" | "stuck";

/** Tasks that can start now: pending, with every dependency done. */
export function readyTasks(tasks: Pick<MissionTaskRow, "key" | "status" | "depends_on">[]): string[] {
  const done = new Set(tasks.filter((t) => t.status === "done").map((t) => t.key));
  return tasks.filter((t) => t.status === "pending" && (JSON.parse(t.depends_on) as string[]).every((d) => done.has(d))).map((t) => t.key);
}

export function missionState(tasks: Pick<MissionTaskRow, "key" | "status" | "depends_on">[]): MissionState {
  if (readyTasks(tasks).length) return "run";
  if (tasks.every((t) => t.status === "done" || t.status === "failed")) return "done";
  if (tasks.some((t) => t.status === "blocked")) return "blocked";
  return "stuck"; // pending tasks whose dependencies failed
}

export function taskResultSummary(tasks: Pick<MissionTaskRow, "key" | "title" | "assignee" | "status" | "result">[], maxEach = 600): string {
  return tasks
    .map((t) => `[${t.key}] ${t.title} (${t.assignee}, ${t.status})${t.result ? `: ${t.result.slice(0, maxEach)}` : ""}`)
    .join("\n");
}
