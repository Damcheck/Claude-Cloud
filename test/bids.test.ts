import { describe, expect, it } from "vitest";
import { chooseSpeakers, parseBid, type Bid } from "../src/council/bids";

describe("parseBid", () => {
  it("reads JSON, even wrapped in reasoning or prose", () => {
    expect(parseBid("sage", '<think>hmm</think>Sure: {"want_to_speak": true, "importance": 0.8, "reason": "Atlas is wrong"}')).toEqual({
      agent: "sage",
      wantToSpeak: true,
      importance: 0.8,
      reason: "Atlas is wrong",
    });
  });

  it("clamps importance and treats garbage as silence", () => {
    expect(parseBid("nova", '{"want_to_speak":"true","importance":7}').importance).toBe(1);
    expect(parseBid("nova", "I'd like to talk").wantToSpeak).toBe(false);
    expect(parseBid("nova", "{broken").wantToSpeak).toBe(false);
  });
});

describe("chooseSpeakers", () => {
  const bid = (agent: Bid["agent"], wantToSpeak: boolean, importance: number): Bid => ({ agent, wantToSpeak, importance, reason: "" });

  it("gives the floor to the strongest willing bids", () => {
    const bids = [bid("atlas", true, 0.5), bid("nova", true, 0.9), bid("sage", true, 0.7), bid("nexus", false, 0.95)];
    expect(chooseSpeakers(bids, "I think we should launch", 2)).toEqual(["nova", "sage"]);
  });

  it("drops weak bids", () => {
    expect(chooseSpeakers([bid("atlas", true, 0.1)], "ok cool", 2, 0.35)).toEqual([]);
  });

  it("never leaves a direct question unanswered", () => {
    expect(chooseSpeakers([bid("atlas", false, 0.3), bid("axiom", false, 0.6)], "What do you think?", 2)).toEqual(["axiom"]);
  });
});
