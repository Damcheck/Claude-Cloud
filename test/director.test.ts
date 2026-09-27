import { describe, expect, it } from "vitest";
import { directedCommand, inferDeterministicDirection, isSimpleSocialMessage, parseDirection } from "../src/council/director";
import type { TranscriptMessage } from "../src/types";
import type { AgentId } from "../src/types";

const available: AgentId[] = ["atlas", "nova", "sage", "nexus", "axiom", "cipher"];

describe("semantic conversation director", () => {
  it("inherits a cybersecurity task through a colloquial capability follow-up", () => {
    const transcript: TranscriptMessage[] = [
      {
        chatId: -100,
        discussionId: 1,
        speaker: "human",
        speakerName: "Founder",
        text: "Set up some little site attacking tools let try some cybersecurity out",
        createdAt: Date.now(),
      },
    ];
    const direction = inferDeterministicDirection("Who is in caring to do that", transcript, [...available, "forge"]);
    expect(direction).toMatchObject({ intent: "build", reasoning: "deep" });
    expect(direction?.agents).toEqual(expect.arrayContaining(["cipher", "forge"]));
    expect(direction?.reason).toContain("previous cybersecurity task");
  });

  it("parses noisy model JSON and rejects unavailable members", () => {
    expect(parseDirection('thinking... {"intent":"solve","agents":["atlas","forge","axiom"],"reason":"needs options"}', available)).toEqual({
      intent: "solve",
      agents: ["atlas", "axiom"],
      reason: "needs options",
      reasoning: "normal",
    });
  });

  it("turns a natural solution request into expert answers plus synthesis", () => {
    const command = directedCommand({ intent: "solve", agents: ["atlas", "axiom", "sage"], reason: "founder needs a fix", reasoning: "deep" }, available, false);
    if (command.kind !== "discuss") throw new Error("expected discussion");
    expect(command.steps[0]).toMatchObject({ agents: ["atlas", "axiom", "sage"], parallel: true, turn: "blind" });
    expect(command.steps.at(-1)?.agents).toEqual(["nexus"]);
  });

  it("selects speakers directly in calls instead of requiring commands", () => {
    const command = directedCommand({ intent: "debate", agents: ["atlas", "nova", "sage"], reason: "opposing views", reasoning: "deep" }, available, true);
    if (command.kind !== "discuss") throw new Error("expected discussion");
    expect(command.mode).toBe("live");
    expect(command.steps.map((step) => step.agents[0])).toEqual(["atlas", "nova", "sage"]);
  });

  it("keeps social greetings tiny and detached from old work", () => {
    const command = directedCommand({ intent: "social", agents: ["nova", "nexus"], reason: "greeting", reasoning: "fast" }, available, false);
    if (command.kind !== "discuss") throw new Error("expected discussion");
    expect(command.agents).toEqual(["nova", "nexus"]);
    expect(command.steps.every((step) => step.maxTokens === 35)).toBe(true);
    expect(command.steps[0]?.instruction).toContain("Do not revive older topics");
    expect(command.steps[0]?.instruction).toContain("Never say ‘finally’");
    expect(command.steps.every((step) => step.primaryModel)).toBe(true);
    expect(command.steps.every((step) => step.reasoning === "fast")).toBe(true);
  });

  it("distinguishes greetings from substantive conversational questions", () => {
    expect(isSimpleSocialMessage("Hello everyone")).toBe(true);
    expect(isSimpleSocialMessage("Bye bye everyone")).toBe(true);
    expect(isSimpleSocialMessage("What do all of you have to say about masturbation?")).toBe(false);
  });

  it("lets every member answer when all are explicitly addressed socially", () => {
    const command = directedCommand({ intent: "social", agents: available, reason: "everyone must say goodbye", reasoning: "fast" }, available, true);
    if (command.kind !== "discuss") throw new Error("expected discussion");
    expect(command.steps.map((item) => item.agents[0])).toEqual(available);
  });

  it("preserves an explicitly requested deep reasoning mode", () => {
    expect(parseDirection('{"intent":"research","agents":["sage"],"reason":"needs verification","reasoning":"deep"}', available)?.reasoning).toBe("deep");
  });

  it("uses three distinct members for an ordinary group discussion", () => {
    const command = directedCommand({ intent: "answer", agents: ["atlas", "nova", "sage"], reason: "ordinary discussion", reasoning: "normal" }, available, false);
    if (command.kind !== "discuss") throw new Error("expected discussion");
    expect(command.agents).toEqual(["atlas", "nova", "sage"]);
    expect(command.steps.map((step) => step.agents[0])).toEqual(["atlas", "nova", "sage"]);
  });

  it("does not cap an explicit whole-council debate at four members", () => {
    const command = directedCommand({ intent: "debate", agents: available, reason: "everyone was addressed", reasoning: "deep" }, available, false);
    if (command.kind !== "discuss") throw new Error("expected discussion");
    expect(command.steps[0]?.agents).toEqual(available);
  });
});
