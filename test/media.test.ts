import { describe, expect, it } from "vitest";
import { contextualStickerEmoji } from "../src/council/media";

describe("contextualStickerEmoji", () => {
  it("matches the actual social meaning", () => {
    expect(contextualStickerEmoji("Hello everyone", "Hey, what's good?")).toBe("👋");
    expect(contextualStickerEmoji("We finally won!", "That was earned.")).toBe("🥳");
    expect(contextualStickerEmoji("WTF, that is crazy", "I didn't expect that.")).toBe("🤯");
    expect(contextualStickerEmoji("I made serious profit", "Nice execution.")).toBe("🤑");
  });

  it("does not append generic media to ordinary technical discussion", () => {
    expect(contextualStickerEmoji("Review the database schema", "The index should cover chat_id and created_at.")).toBeNull();
  });
});
