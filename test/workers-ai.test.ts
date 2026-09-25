import { describe, expect, it } from "vitest";
import { describeVisionOutput, normalizeChatOutput } from "../src/ai/workers-ai";

describe("normalizeChatOutput", () => {
  it("reads the legacy { response, tool_calls } shape", () => {
    const r = normalizeChatOutput({ response: "hi", tool_calls: [{ name: "web_fetch", arguments: { url: "https://x.y" } }] });
    expect(r.text).toBe("hi");
    expect(r.toolCalls[0]!.function).toEqual({ name: "web_fetch", arguments: '{"url":"https://x.y"}' });
  });

  it("reads the OpenAI-compatible choices shape", () => {
    const r = normalizeChatOutput({
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "memory_search", arguments: '{"query":"pricing"}' } }] } }],
    });
    expect(r.text).toBe("");
    expect(r.toolCalls).toEqual([{ id: "c1", type: "function", function: { name: "memory_search", arguments: '{"query":"pricing"}' } }]);
  });
});

describe("describeVisionOutput", () => {
  it("prefers answer/caption fields and falls back to JSON", () => {
    expect(describeVisionOutput({ answer: "a red button" })).toBe("a red button");
    expect(describeVisionOutput({ result: { caption: "a chart" } })).toBe("a chart");
    expect(describeVisionOutput({ objects: [1] })).toBe('{"objects":[1]}');
  });
});
