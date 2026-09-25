import { describe, expect, it, vi } from "vitest";
import { AGENTS } from "../src/agents/registry";
import { BudgetExceeded, runAgentTurn } from "../src/agents/runner";
import type { SkillContext } from "../src/skills/types";
import type { Env } from "../src/types";

/** Scripted AI binding: each call pops the next response for that model (or throws). */
function fakeAi(script: Record<string, (unknown | Error)[]>) {
  const calls: { model: string; input: any }[] = [];
  const ai = {
    run: vi.fn(async (model: string, input: any) => {
      calls.push({ model, input });
      const next = script[model]?.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error(`no scripted response for ${model}`);
      return next;
    }),
  };
  return { ai, calls };
}

function fakeStore(overrides: Record<string, unknown> = {}) {
  return {
    hasVectors: false,
    tokensToday: async () => 0,
    groupFacts: async () => ["Project: AI Council"],
    agentMemories: async () => [],
    trackRecord: async () => ({ right: 0, wrong: 0, unclear: 0, open: 0 }),
    openPredictions: async () => [],
    recentClaims: async () => [],
    searchIdeas: async () => [],
    openActions: async () => [],
    pendingFollowups: async () => [],
    recordUsage: vi.fn(async () => {}),
    addClaim: vi.fn(async () => 7),
    createApproval: vi.fn(async () => 11),
    ...overrides,
  };
}

function ctx(agent: SkillContext["agent"], ai: unknown, store: unknown, env: Partial<Env> = {}): SkillContext {
  return {
    env: { AI: ai, DAILY_TOKEN_BUDGET_PER_AGENT: "0", GITHUB_REPOS: "", ...env } as unknown as Env,
    store: store as never,
    convId: -100,
    chatId: -100,
    agent,
    sharedConvIds: [-100],
    transcript: [],
    consultDepth: 0,
    callOptions: {},
    hooks: { scheduleNext: vi.fn(async () => {}), sendPhoto: vi.fn(async () => {}), requestApproval: vi.fn(async () => {}) },
  };
}

const req = {
  mode: "chat" as const,
  turn: "normal" as const,
  topic: "",
  transcript: [{ chatId: -100, discussionId: 1, speaker: "human" as const, speakerName: "Dam", text: "Is Rust faster than Go?", createdAt: 0 }],
};

describe("runAgentTurn", () => {
  it("answers with the primary model and records usage", async () => {
    const { ai } = fakeAi({ [AGENTS.sage.model]: [{ response: "Usually, yes.", usage: { prompt_tokens: 100, completion_tokens: 5 } }] });
    const store = fakeStore();
    expect(await runAgentTurn(req, ctx("sage", ai, store))).toBe("Usually, yes.");
    expect(store.recordUsage).toHaveBeenCalledWith(-100, "sage", AGENTS.sage.model, 100, 5);
  });

  it("switches to the backup model when the primary fails", async () => {
    const { ai, calls } = fakeAi({
      [AGENTS.sage.model]: [new Error("capacity")],
      [AGENTS.sage.fallbackModel]: [{ response: "From the backup." }],
    });
    expect(await runAgentTurn(req, ctx("sage", ai, fakeStore()))).toBe("From the backup.");
    expect(calls.map((c) => c.model)).toEqual([AGENTS.sage.model, AGENTS.sage.fallbackModel]);
  });

  it("runs a skill the model chose and feeds the result back", async () => {
    const { ai, calls } = fakeAi({
      [AGENTS.sage.model]: [
        { tool_calls: [{ name: "claims_record", arguments: { claim: "Rust is faster", claimed_by: "founder", verdict: "unclear" } }] },
        { response: "It depends on the workload; I logged it as unclear." },
      ],
    });
    const store = fakeStore();
    const reply = await runAgentTurn(req, ctx("sage", ai, store));
    expect(reply).toContain("depends");
    expect(store.addClaim).toHaveBeenCalledWith(expect.objectContaining({ claim: "Rust is faster", verdict: "unclear", checkedBy: "sage" }));
    const toolMsg = calls[1]!.input.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toBe("Claim #7 recorded as unclear.");
  });

  it("asks the founder instead of running a skill that needs approval", async () => {
    const { ai, calls } = fakeAi({
      [AGENTS.cipher.model]: [
        { tool_calls: [{ name: "github_open_pr", arguments: { repo: "damcheck/claude-cloud", branch: "fix", title: "Fix" } }] },
        { response: "I've asked for approval to open the PR." },
      ],
    });
    const store = fakeStore();
    const c = ctx("cipher", ai, store, { GITHUB_TOKEN: "t", GITHUB_REPOS: "damcheck/claude-cloud" });
    await runAgentTurn(req, c);
    expect(store.createApproval).toHaveBeenCalledWith(expect.objectContaining({ skill: "github.open_pr", agent: "cipher" }));
    expect(c.hooks!.requestApproval).toHaveBeenCalledWith(11, "cipher", expect.stringContaining("open a draft PR"));
    expect(calls[1]!.input.messages.find((m: any) => m.role === "tool").content).toContain("Approval request #11");
  });

  it("passes silently on [PASS]", async () => {
    const { ai } = fakeAi({ [AGENTS.nova.model]: [{ response: "[PASS]" }] });
    expect(await runAgentTurn(req, ctx("nova", ai, fakeStore()))).toBeNull();
  });

  it("refuses to run over the daily budget", async () => {
    const { ai } = fakeAi({});
    const c = ctx("atlas", ai, fakeStore({ tokensToday: async () => 500 }), { DAILY_TOKEN_BUDGET_PER_AGENT: "400" });
    await expect(runAgentTurn(req, c)).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it("uses the fast voice model and no skills when speaking in a live call", async () => {
    const { ai, calls } = fakeAi({ [AGENTS.atlas.voiceModel]: [{ response: "Short answer." }] });
    await runAgentTurn({ ...req, mode: "live", speaking: true }, ctx("atlas", ai, fakeStore()));
    expect(calls[0]!.model).toBe(AGENTS.atlas.voiceModel);
    expect(calls[0]!.input.tools).toBeUndefined();
    expect(calls[0]!.input.messages[0].content).toContain("SPEAKING");
  });

  it("sends the image to vision models and a description to the others", async () => {
    const image = "data:image/png;base64,AAAA";
    const vision = fakeAi({ [AGENTS.axiom.model]: [{ response: "The CTA is below the fold." }] });
    await runAgentTurn(req, { ...ctx("axiom", vision.ai, fakeStore()), image });
    expect(vision.calls[0]!.input.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: image } });

    const blind = fakeAi({
      [AGENTS.iris.model]: [{ caption: "A pricing page with two buttons." }],
      [AGENTS.atlas.model]: [{ response: "Pricing looks confusing." }],
    });
    await runAgentTurn(req, { ...ctx("atlas", blind.ai, fakeStore()), image });
    expect(blind.calls[1]!.input.messages[1].content).toContain("A pricing page with two buttons.");
  });
});
