import { describe, expect, it } from "vitest";
import { cleanReply, isPass, stripReasoning } from "../src/council/text";

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
