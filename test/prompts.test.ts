import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserPrompt, PASS_TOKEN } from "../src/agents/prompts";
import { toolName, toolsFor } from "../src/skills/registry";

const base = {
  agent: "sage" as const,
  mode: "council" as const,
  turn: "blind" as const,
  topic: "pricing",
  transcript: [
    { chatId: 1, discussionId: 1, speaker: "human" as const, speakerName: "Dam", text: "thoughts?", createdAt: 0 },
    { chatId: 1, discussionId: 1, speaker: "sage" as const, speakerName: "Sage", text: "earlier point", createdAt: 1 },
  ],
  groupFacts: ["Project: Open Bloom Terminal"],
  privateMemories: ["I warned about churn"],
  skillSummaries: [],
};

describe("prompts", () => {
  it("includes identity, the pass rule, and both memory levels", () => {
    const s = buildSystemPrompt(base);
    expect(s).toContain("You are Sage");
    expect(s).toContain(PASS_TOKEN);
    expect(s).toContain("Open Bloom Terminal");
    expect(s).toContain("I warned about churn");
  });

  it("marks the agent's own past messages and states the round", () => {
    const u = buildUserPrompt(base);
    expect(u).toContain("Sage (you): earlier point");
    expect(u).toContain("round 1");
  });
});

describe("skills", () => {
  it("exposes only permitted skills with function-safe names", () => {
    const names = toolsFor("sage").map((t) => t.function.name);
    expect(names).toEqual(["memory_search", "memory_remember", "web_fetch"]);
    expect(toolsFor("iris").map((t) => t.function.name)).toEqual(["vision_inspect"]);
    expect(toolName("group.record_fact")).toBe("group_record_fact");
  });
});
