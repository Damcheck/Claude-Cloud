import { describe, expect, it } from "vitest";
import { cleanReply, isPass, splitForTelegram, stripReasoning } from "../src/council/text";

describe("reply cleaning", () => {
  it("detects PASS variants", () => {
    expect(isPass("[PASS]")).toBe(true);
    expect(isPass(" [PASS]. ")).toBe(true);
    expect(isPass("pass")).toBe(true);
    expect(isPass("I'll pass on the details, but X")).toBe(false);
  });

  it("strips reasoning blocks and self prefixes", () => {
    expect(stripReasoning("<think>hmm</think>Answer")).toBe("Answer");
    expect(stripReasoning("leaked reasoning</think>Answer")).toBe("Answer");
    expect(cleanReply("atlas", "🧠 Atlas: The real issue is distribution.")).toBe("The real issue is distribution.");
    expect(cleanReply("nova", "<think>x</think>[PASS]")).toBeNull();
  });
});

describe("splitForTelegram", () => {
  it("keeps short text whole", () => {
    expect(splitForTelegram("hi", 10)).toEqual(["hi"]);
  });
  it("splits on paragraph boundaries under the limit", () => {
    const text = "a".repeat(30) + "\n\n" + "b".repeat(30);
    const parts = splitForTelegram(text, 40);
    expect(parts).toEqual(["a".repeat(30), "b".repeat(30)]);
    expect(parts.every((p) => p.length <= 40)).toBe(true);
  });
  it("hard-splits text with no spaces", () => {
    expect(splitForTelegram("x".repeat(25), 10).map((p) => p.length)).toEqual([10, 10, 5]);
  });
});
