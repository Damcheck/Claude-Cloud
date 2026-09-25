import type { WorkflowStep } from "cloudflare:workers";
import { AGENTS, AGENT_IDS } from "../agents/registry";
import { runAgentTurn } from "../agents/runner";
import { askJson } from "../ai/json";
import { postAs, postSystem } from "../council/post";
import { MemoryStore } from "../memory/store";
import type { MissionTaskRow } from "../memory/ops";
import type { Env, Identity } from "../types";
import { callOptions, jobContext } from "./common";
import { missionState, readyTasks, taskResultSummary, validatePlan } from "./mission-plan";

const MAX_CYCLES = 60;
const MAX_EVALUATIONS = 2;
const PARALLEL_TASKS = 3;

type CycleResult = { state: "continue" | "wait" | "blocked" | "done" | "stop"; note?: string };

const members = AGENT_IDS.filter((id) => AGENTS[id].kind === "chat")
  .map((id) => `${id}: ${AGENTS[id].role} (skills: ${AGENTS[id].skills.join(", ")})`)
  .join("\n");

function planPrompt(goal: string, deadline: string, budget: number, done?: string, gaps?: string): string {
  return `You are Nexus, planning a mission for the AI council. Break the goal into concrete tasks for the members.

Goal: ${goal}
Deadline: ${deadline}. Token budget: ${budget.toLocaleString()}.
Members and their skills:
${members}
${done ? `\nAlready done:\n${done}\n\nGaps still to close:\n${gaps}\nPlan only the extra tasks needed (at most 3).` : "\nPlan 3-10 tasks. Each must be doable by one member in one working session with their skills."}

Reply with only JSON:
{"success_criteria": "how we'll know it's done", "tasks": [{"key": "t1", "title": "...", "detail": "what exactly to do and what to deliver", "assignee": "sage", "depends_on": []}]}`;
}

export async function runMission(env: Env, step: WorkflowStep, missionId: number, identity: Identity, loopback: unknown): Promise<void> {
  const store = new MemoryStore(env.DB, env.AI, env.VECTORIZE);
  const tag = `mission:${missionId}`;

  await step.do("plan", { retries: { limit: 2, delay: "20 seconds", backoff: "linear" }, timeout: "10 minutes" }, async () => {
    const mission = await store.ops.getMission(missionId);
    if (!mission) throw new Error(`mission ${missionId} missing`);
    if ((await store.ops.tasks(missionId)).length) return "already planned";
    const r = await askJson<{ success_criteria?: string; tasks?: unknown }>(
      env.AI,
      AGENTS.nexus.model,
      [{ role: "user", content: planPrompt(mission.goal, new Date(mission.deadline_at).toISOString().slice(0, 16), mission.token_budget) }],
      { maxTokens: 1800, ...callOptions(env, identity.convId) },
    );
    await store.recordUsage(identity.convId, "nexus", AGENTS.nexus.model, r.promptTokens, r.completionTokens, tag);
    const tasks = validatePlan(r.value);
    if (!tasks.length) throw new Error("planner returned no valid tasks");
    await store.ops.addTasks(missionId, tasks);
    await store.ops.updateMission(missionId, { status: "running", success_criteria: String(r.value?.success_criteria ?? "").slice(0, 1000) });
    const lines = tasks.map((t) => `• ${AGENTS[t.assignee].emoji} ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`).join("\n");
    await postAs(env, store, identity, "nexus", `🎯 **Mission #${missionId}**: ${mission.goal}\n\n**Done when:** ${r.value?.success_criteria ?? "the goal is met"}\n\n**Plan**\n${lines}`);
    return `planned ${tasks.length}`;
  });

  let evaluations = 0;
  for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
    const result = await step.do(`cycle-${cycle}`, { retries: { limit: 1, delay: "1 minute" }, timeout: "20 minutes" }, () =>
      runCycle(env, store, missionId, identity, tag, loopback),
    );
    if (result.state === "stop") break;

    if (result.state === "done") {
      if (evaluations >= MAX_EVALUATIONS) break;
      evaluations++;
      const added = await step.do(`evaluate-${cycle}`, { timeout: "10 minutes" }, () => evaluate(env, store, missionId, identity, tag));
      if (added === 0) break;
      continue;
    }

    if (result.state === "blocked") {
      const event = await step
        .waitForEvent<{ text: string }>(`founder-input-${cycle}`, { type: "founder_input", timeout: "24 hours" })
        .catch(() => null);
      if (!event) {
        await step.do(`timeout-${cycle}`, async () => {
          await store.ops.updateMission(missionId, { status: "failed", result: "Blocked for 24h waiting on the founder." });
          await postSystem(env, identity, `⏸ Mission #${missionId} stopped: it was blocked for 24 hours waiting on you.`);
          return "failed";
        });
        return;
      }
      await step.do(`apply-input-${cycle}`, async () => {
        for (const t of await store.ops.tasks(missionId)) {
          if (t.status === "blocked") await store.ops.updateTask(t.id, "pending", `${t.result ?? ""}\nFounder replied: ${event.payload.text}`.trim());
        }
        await store.ops.updateMission(missionId, { status: "running" });
        return "applied";
      });
      continue;
    }

    await step.sleep(`pause-${cycle}`, result.state === "wait" ? "5 minutes" : "15 seconds");
  }

  await step.do("finish", { timeout: "10 minutes" }, () => finish(env, store, missionId, identity, tag));
}

async function runCycle(env: Env, store: MemoryStore, missionId: number, identity: Identity, tag: string, loopback: unknown): Promise<CycleResult> {
  const mission = await store.ops.getMission(missionId);
  if (!mission || ["stopped", "failed", "done"].includes(mission.status)) return { state: "stop" };
  if (await store.ops.isFrozen()) return { state: "wait", note: "frozen" };
  if (Date.now() > mission.deadline_at) {
    await store.ops.updateMission(missionId, { status: "failed", result: "Deadline passed." });
    await postSystem(env, identity, `⌛ Mission #${missionId} hit its deadline.`);
    return { state: "stop" };
  }
  const used = await store.ops.tokensForTag(tag);
  if (used >= mission.token_budget) {
    await store.ops.updateMission(missionId, { status: "failed", result: `Token budget exhausted (${used.toLocaleString()}).` });
    await postSystem(env, identity, `💸 Mission #${missionId} used its whole budget (${used.toLocaleString()} tokens) and stopped.`);
    return { state: "stop" };
  }

  const tasks = await store.ops.tasks(missionId);
  const state = missionState(tasks);
  if (state === "done") return { state: "done" };
  if (state === "blocked") {
    if (mission.status !== "blocked") {
      await store.ops.updateMission(missionId, { status: "blocked" });
      const blocked = tasks.filter((t) => t.status === "blocked").map((t) => `• ${t.title}: ${t.result ?? ""}`).join("\n");
      await postAs(env, store, identity, "nexus", `⏸ **Mission #${missionId} needs you**\n${blocked}\n\nReply with \`/mission_reply ${missionId} <your answer>\`.`);
    }
    return { state: "blocked" };
  }
  if (state === "stuck") {
    for (const t of tasks.filter((x) => x.status === "pending")) await store.ops.updateTask(t.id, "failed", "A task it depended on failed.");
    return { state: "continue" };
  }

  const ready = readyTasks(tasks)
    .map((k) => tasks.find((t) => t.key === k)!)
    .slice(0, PARALLEL_TASKS);
  const transcript = await store.recentMessages(identity.convId, 20);
  await Promise.all(ready.map((task) => runTask(env, store, mission.goal, missionId, task, tasks, identity, tag, loopback, transcript)));
  return { state: "continue" };
}

async function runTask(
  env: Env,
  store: MemoryStore,
  goal: string,
  missionId: number,
  task: MissionTaskRow,
  all: MissionTaskRow[],
  identity: Identity,
  tag: string,
  loopback: unknown,
  transcript: Awaited<ReturnType<MemoryStore["recentMessages"]>>,
): Promise<void> {
  const deps = (JSON.parse(task.depends_on) as string[]).map((k) => all.find((t) => t.key === k)).filter(Boolean) as MissionTaskRow[];
  const instruction = `You're working on mission #${missionId}: "${goal}".
Your task [${task.key}]: ${task.title}
${task.detail}
${deps.length ? `Results you can build on:\n${taskResultSummary(deps, 1500)}` : ""}
${task.result ? `Earlier attempt / founder input:\n${task.result}` : ""}
Do the task now using your skills. Then report the result concisely; it's posted to the chat and passed to the next tasks.
If you truly can't proceed without the founder, reply starting with "BLOCKED:" and the exact question.`;
  try {
    const ctx = jobContext(env, store, identity, task.assignee, { transcript, tag, missionId, loopback });
    const reply = await runAgentTurn({ mode: "direct", turn: "normal", topic: goal, transcript, instruction }, ctx);
    const text = reply ?? "(nothing to add)";
    if (/^\s*BLOCKED:/i.test(text)) {
      await store.ops.updateTask(task.id, "blocked", text.replace(/^\s*BLOCKED:\s*/i, "").slice(0, 2000), true);
      return;
    }
    await store.ops.updateTask(task.id, "done", text.slice(0, 6000), true);
    await postAs(env, store, identity, task.assignee, `🎯 Mission #${missionId} · **${task.title}**\n\n${text}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failed = task.attempts + 1 >= 2;
    await store.ops.updateTask(task.id, failed ? "failed" : "pending", `Error: ${msg}`, true);
    if (failed) await postSystem(env, identity, `⚠️ Mission #${missionId}: "${task.title}" failed (${msg.slice(0, 200)}).`);
  }
}

/** Nexus checks the results against the success criteria and adds tasks for any gaps. */
async function evaluate(env: Env, store: MemoryStore, missionId: number, identity: Identity, tag: string): Promise<number> {
  const mission = (await store.ops.getMission(missionId))!;
  const tasks = await store.ops.tasks(missionId);
  const judge = await askJson<{ met?: boolean; gaps?: string }>(
    env.AI,
    AGENTS.nexus.model,
    [
      {
        role: "user",
        content: `Mission goal: ${mission.goal}\nSuccess criteria: ${mission.success_criteria}\n\nTask results:\n${taskResultSummary(tasks, 1200)}\n\nIs the goal met? Reply with only JSON: {"met": true|false, "gaps": "what is still missing, if anything"}`,
      },
    ],
    { maxTokens: 400, ...callOptions(env, identity.convId) },
  );
  await store.recordUsage(identity.convId, "nexus", AGENTS.nexus.model, judge.promptTokens, judge.completionTokens, tag);
  if (!judge.value || judge.value.met !== false || !judge.value.gaps) return 0;

  const r = await askJson<{ tasks?: unknown }>(
    env.AI,
    AGENTS.nexus.model,
    [{ role: "user", content: planPrompt(mission.goal, new Date(mission.deadline_at).toISOString().slice(0, 16), mission.token_budget, taskResultSummary(tasks, 400), judge.value.gaps) }],
    { maxTokens: 1000, ...callOptions(env, identity.convId) },
  );
  await store.recordUsage(identity.convId, "nexus", AGENTS.nexus.model, r.promptTokens, r.completionTokens, tag);
  const extra = validatePlan(r.value, tasks.map((t) => t.key)).slice(0, 3);
  if (!extra.length) return 0;
  await store.ops.addTasks(missionId, extra);
  await postAs(env, store, identity, "nexus", `🔁 Mission #${missionId} isn't done yet: ${judge.value.gaps}\nAdded: ${extra.map((t) => `${AGENTS[t.assignee].emoji} ${t.title}`).join(", ")}`);
  return extra.length;
}

async function finish(env: Env, store: MemoryStore, missionId: number, identity: Identity, tag: string): Promise<string> {
  const mission = (await store.ops.getMission(missionId))!;
  const tasks = await store.ops.tasks(missionId);
  const used = await store.ops.tokensForTag(tag);
  const ctx = jobContext(env, store, identity, "nexus", { tag });
  const report = await runAgentTurn(
    {
      mode: "direct",
      turn: "normal",
      topic: mission.goal,
      transcript: [],
      instruction: `Write the final report for mission #${missionId}: "${mission.goal}".
Success criteria: ${mission.success_criteria}
Task results:
${taskResultSummary(tasks, 1000)}
Say plainly whether the goal was met, the key results, what didn't work, and 2-3 lessons for next time. Save the lessons with memory.remember and any decisions with group.record_fact.`,
    },
    ctx,
  ).catch(() => null);
  const failed = tasks.some((t) => t.status === "failed");
  const status = mission.status === "failed" || mission.status === "stopped" ? mission.status : failed ? "failed" : "done";
  const text = report ?? `Mission finished with ${tasks.filter((t) => t.status === "done").length}/${tasks.length} tasks done.`;
  await store.ops.updateMission(missionId, { status, result: text.slice(0, 4000) });
  await postAs(env, store, identity, "nexus", `🏁 **Mission #${missionId} ${status === "done" ? "complete" : status}** (${used.toLocaleString()} tokens)\n\n${text}`);
  await store.index(identity.convId, `mission:${missionId}`, `Mission #${missionId} "${mission.goal}" ${status}: ${text}`, { kind: "mission" });
  return status;
}
