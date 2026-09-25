import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml, speechChunks, speechText, splitMarkdown } from "../src/telegram/format";

describe("markdownToTelegramHtml", () => {
  it("renders code blocks, inline code, bold, italics and links", () => {
    const html = markdownToTelegramHtml("**Plan** with *care*:\n```ts\nconst a = 1 < 2;\n```\nUse `npm test` and [docs](https://x.dev/a).");
    expect(html).toContain("<b>Plan</b>");
    expect(html).toContain("<i>care</i>");
    expect(html).toContain('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
    expect(html).toContain("<code>npm test</code>");
    expect(html).toContain('<a href="https://x.dev/a">docs</a>');
  });

  it("escapes HTML the model wrote", () => {
    expect(markdownToTelegramHtml("<script>alert(1)</script> & co")).toBe("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
  });

  it("turns headings and bullets into Telegram-friendly text", () => {
    expect(markdownToTelegramHtml("## Options\n- one\n- two")).toBe("<b>Options</b>\n• one\n• two");
  });

  it("does not format inside inline code", () => {
    expect(markdownToTelegramHtml("`**not bold**`")).toBe("<code>**not bold**</code>");
  });

  it("closes an unterminated fence", () => {
    expect(markdownToTelegramHtml("```\nx")).toBe("<pre><code>x</code></pre>");
  });
});

describe("splitMarkdown", () => {
  it("keeps short text whole", () => {
    expect(splitMarkdown("hi", 100)).toEqual(["hi"]);
  });

  it("closes and reopens a code fence across chunks", () => {
    const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const parts = splitMarkdown("Intro\n```js\n" + code + "\n```", 120);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(120);
      expect((p.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(parts[1]!.startsWith("```js\n")).toBe(true);
  });

  it("hard-splits text without spaces", () => {
    const parts = splitMarkdown("x".repeat(250), 100);
    expect(parts.join("")).toBe("x".repeat(250));
    expect(parts.every((p) => p.length <= 100)).toBe(true);
  });
});

describe("speech", () => {
  it("strips code, markup and URLs", () => {
    expect(speechText("**Yes.** See `x` and https://a.b/c\n```js\ncode\n```\n- item")).toBe("Yes. See x and the link (code in the chat) item");
  });

  it("groups sentences into chunks under the limit", () => {
    const chunks = speechChunks("One. Two is here! Three? Four.", 12);
    expect(chunks).toEqual(["One.", "Two is here!", "Three? Four."]);
    expect(chunks.every((c) => c.length <= 12)).toBe(true);
    expect(speechChunks("Short. Text.", 100)).toEqual(["Short. Text."]);
  });
});
