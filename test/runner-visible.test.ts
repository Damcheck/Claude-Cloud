import { describe, expect, it } from "vitest";
import { boundVisibleReply } from "../src/agents/runner";

describe("visible reply bounding", () => {
  it("never leaves a dangling numbered step after truncation", () => {
    const reply = "I can help with an isolated lab. We will use local targets only and keep it authorized. Concrete next step, Cipher's shop: 1. Install the intentionally vulnerable target and scanner now.";
    const bounded = boundVisibleReply(reply, 24);
    expect(bounded).not.toMatch(/(?:\d+\.|\d+\)|:)$/);
    expect(bounded).toContain("authorized.");
  });
});
