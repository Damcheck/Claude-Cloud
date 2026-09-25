import { describe, expect, it } from "vitest";
import { CORE_AGENTS } from "../src/agents/registry";
import { agentsOf, findMentions, pickChatAgents, route, routeLive, wakeSpecialists } from "../src/council/router";
import type { IncomingMessage } from "../src/types";

const msg = (text: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
  chatId: -100,
  convId: -100,
  messageId: 1,
  fromId: 42,
  fromName: "Dam",
  text,
  ...extra,
});
const ctx = { recentSpeakers: [] };

describe("commands", () => {
  it("parses /stop, /status, /help and bot-suffixed commands", () => {
    expect(route(msg("/stop"), ctx).kind).toBe("stop");
    expect(route(msg("/status@NexusCouncilBot"), ctx).kind).toBe("status");
    expect(route(msg("/help"), ctx).kind).toBe("help");
    expect(route(msg("/nonsense"), ctx).kind).toBe("help");
  });

  it("/council runs a blind parallel round, a follow-up round and a Nexus summary", () => {
    const c = route(msg("/council Should I build a forex journal?"), ctx);
    if (c.kind !== "discuss") throw new Error("expected discuss");
    expect(c.mode).toBe("council");
    expect(c.topic).toBe("Should I build a forex journal?");
    expect(c.steps.map((s) => [s.turn, s.parallel, !!s.crux])).toEqual([
      ["blind", true, false],
      ["normal", false, true],
      ["followUp", false, false],
      ["summary", false, false],
    ]);
    expect(c.steps[0]!.agents).toEqual(CORE_AGENTS);
    expect(c.steps[3]!.agents).toEqual(["nexus"]);
  });

  it("/debate has the configured number of rounds plus summary", () => {
    const c = route(msg("/debate subscriptions vs one-time"), ctx);
    if (c.kind !== "discuss") throw new Error("expected discuss");
    expect(c.steps.filter((s) => s.turn !== "summary" && !s.crux)).toHaveLength(3);
    expect(c.steps.filter((s) => s.crux)).toHaveLength(1);
  });

  it("/atlas addresses Atlas directly", () => {
    const c = route(msg("/atlas what do you think"), ctx);
    expect(c.kind === "discuss" && c.agents).toEqual(["atlas"]);
  });
});

describe("mentions", () => {
  it("finds @usernames, vocatives and leading names", () => {
    expect(findMentions("@DamAtlasBot thoughts?")).toEqual(["atlas"]);
    expect(findMentions("Nova, explain your point")).toEqual(["nova"]);
    expect(findMentions("ok so Sage: is that true?")).toEqual(["sage"]);
    expect(findMentions("Cipher how would you build it")).toEqual(["cipher"]);
  });

  it("does not match names used as ordinary words mid-sentence", () => {
    expect(findMentions("the atlas of the world is big")).toEqual([]);
  });

  it("routes a reply to a bot as a direct message to that agent", () => {
    const c = route(msg("why?", { replyToAgent: "forge" }), ctx);
    expect(c.kind === "discuss" && c.mode).toBe("direct");
    expect(c.kind === "discuss" && c.agents).toEqual(["forge"]);
  });
});

describe("specialists", () => {
  it("wakes Cipher for code and Forge for architecture", () => {
    expect(wakeSpecialists(msg("my typescript build fails with a TypeError"))).toContain("cipher");
    expect(wakeSpecialists(msg("how should we handle the race condition in durable objects locking?"))).toContain("forge");
    expect(wakeSpecialists(msg("should we raise our prices?"))).toEqual([]);
  });

  it("wakes Iris first when an image is attached", () => {
    const c = route(msg("why does my site look wrong", { imageFileId: "f1" }), ctx);
    if (c.kind !== "discuss") throw new Error("expected discuss");
    expect(c.steps[0]!.agents[0]).toBe("iris");
  });

  it("puts Iris before the addressed agent when an image is sent with a mention", () => {
    const c = route(msg("Axiom, what do you think of this?", { imageFileId: "f1" }), ctx);
    expect(c.kind === "discuss" && c.agents).toEqual(["iris", "axiom"]);
  });

  it("council with a code topic adds specialists to the rounds but not the summary", () => {
    const c = route(msg("/council rewrite the backend in rust or keep typescript?"), ctx);
    if (c.kind !== "discuss") throw new Error("expected discuss");
    expect(c.steps[0]!.agents).toContain("cipher");
    expect(c.steps.at(-1)!.agents).toEqual(["nexus"]);
  });
});

describe("plain chat", () => {
  it("picks agents whose interests match", () => {
    expect(pickChatAgents("what would users think of the pricing and ux?", ctx, 1)).toEqual(["axiom"]);
  });

  it("rotates away from whoever spoke last when nothing matches", () => {
    const first = pickChatAgents("hello", { recentSpeakers: [] }, 2);
    const next = pickChatAgents("hello", { recentSpeakers: first }, 2);
    expect(next).not.toEqual(first);
  });

  it("uses one core member plus specialists for technical chat", () => {
    const c = route(msg("the npm build fails on the api endpoint"), ctx);
    if (c.kind !== "discuss") throw new Error("expected discuss");
    expect(agentsOf(c.steps).filter((a) => CORE_AGENTS.includes(a))).toHaveLength(1);
    expect(agentsOf(c.steps)).toContain("cipher");
  });
});

describe("v2 commands", () => {
  it("/premortem gives Atlas the pre-mortem and Sage the challenge", () => {
    const c = route(msg("/premortem launch a Shopify app in 30 days"), ctx);
    if (c.kind !== "discuss") throw new Error("expected discuss");
    expect(c.steps.map((s) => s.agents[0])).toEqual(["atlas", "sage"]);
    expect(c.steps[0]!.instruction).toContain("pre-mortem");
    expect(c.topic).toBe("launch a Shopify app in 30 days");
  });

  it("commands that need a topic show help without one", () => {
    expect(route(msg("/decide"), ctx).kind).toBe("help");
    expect(route(msg("/personas"), ctx).kind).toBe("help");
  });

  it("list commands and toggles don't start a discussion", () => {
    expect(route(msg("/actions"), ctx)).toEqual({ kind: "system", name: "actions", arg: "" });
    expect(route(msg("/voice off"), ctx)).toEqual({ kind: "system", name: "voice", arg: "off" });
    expect(route(msg("/brief on"), ctx)).toEqual({ kind: "brief_toggle", on: true });
    expect(route(msg("/brief"), ctx).kind).toBe("discuss");
  });

  it("collapses everything to the DM agent in a private chat", () => {
    const dm = { dmAgent: "cipher" as const, convId: 42 * 16 + 6 };
    expect(route(msg("/council should we rewrite it?", dm), ctx)).toMatchObject({ kind: "discuss", agents: ["cipher"] });
    const pm = route(msg("/premortem ship it", dm), ctx);
    expect(pm.kind === "discuss" && pm.steps).toEqual([expect.objectContaining({ agents: ["cipher"], instruction: expect.stringContaining("pre-mortem") })]);
    expect(route(msg("/cost", dm), ctx).kind).toBe("system");
  });
});

describe("routeLive", () => {
  it("lets everyone bid, with specialists when relevant", () => {
    const c = routeLive(msg("how would we build the api for this?"));
    if (c.kind !== "discuss") throw new Error("expected discuss");
    expect(c.steps[0]!.bid).toBe(true);
    expect(c.agents).toEqual(expect.arrayContaining([...CORE_AGENTS, "cipher"]));
  });

  it("gives the floor directly to a named member", () => {
    const c = routeLive(msg("Forge, is that going to scale?"));
    expect(c.kind === "discuss" && c.steps).toEqual([{ agents: ["forge"], parallel: false, turn: "normal" }]);
  });
});
