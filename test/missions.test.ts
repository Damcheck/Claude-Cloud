import { describe, expect, it } from "vitest";
import { missionState, readyTasks, validatePlan } from "../src/jobs/mission-plan";
import { parseMissionFlags } from "../src/jobs/start";

describe("mission planning", () => {
  it("keeps valid tasks, drops unknown agents, and fixes dependencies", () => {
    const tasks = validatePlan({
      tasks: [
        { key: "a", title: "Research", assignee: "sage", depends_on: [] },
        { key: "b", title: "Build", assignee: "cipher", depends_on: ["a", "zzz"] },
        { key: "c", title: "Look", assignee: "iris" }, // vision model can't do tasks
        { key: "d", title: "Ghost", assignee: "bob" },
      ],
    });
    expect(tasks.map((t) => t.key)).toEqual(["a", "b"]);
    expect(tasks[1]!.dependsOn).toEqual(["a"]);
  });

  it("drops tasks caught in dependency cycles", () => {
    const tasks = validatePlan([
      { key: "a", title: "A", assignee: "atlas", depends_on: ["b"] },
      { key: "b", title: "B", assignee: "nova", depends_on: ["a"] },
      { key: "c", title: "C", assignee: "sage", depends_on: [] },
    ]);
    expect(tasks.map((t) => t.key)).toEqual(["c"]);
  });

  it("dedupes keys against existing tasks", () => {
    const tasks = validatePlan([{ key: "t1", title: "More", assignee: "nexus" }], ["t1"]);
    expect(tasks[0]!.key).toBe("t1x");
  });

  it("finds ready tasks and the mission state", () => {
    const row = (key: string, status: string, deps: string[] = []) => ({ key, status: status as never, depends_on: JSON.stringify(deps) });
    expect(readyTasks([row("a", "done"), row("b", "pending", ["a"]), row("c", "pending", ["b"])])).toEqual(["b"]);
    expect(missionState([row("a", "done"), row("b", "failed")])).toBe("done");
    expect(missionState([row("a", "blocked"), row("b", "pending", ["a"])])).toBe("blocked");
    expect(missionState([row("a", "failed"), row("b", "pending", ["a"])])).toBe("stuck");
  });

  it("parses budget and deadline flags", () => {
    expect(parseMissionFlags("Find 20 merchants --budget 200k --days 2")).toEqual({ goal: "Find 20 merchants", budget: 200_000, days: 2 });
    expect(parseMissionFlags("Ship it").budget).toBe(300_000);
    expect(parseMissionFlags("x --budget 1m").budget).toBe(1_000_000);
  });
});
