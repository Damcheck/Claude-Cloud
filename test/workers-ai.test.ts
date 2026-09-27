import { describe, expect, it } from "vitest";
import { describeVisionOutput, normalizeChatOutput, reasoningParameters } from "../src/ai/workers-ai";

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

  it("serializes structured JSON responses for semantic routing", () => {
    const r = normalizeChatOutput({ response: { intent: "debate", agents: ["atlas", "nova"] } });
    expect(JSON.parse(r.text)).toEqual({ intent: "debate", agents: ["atlas", "nova"] });
  });
});

describe("describeVisionOutput", () => {
  it("prefers answer/caption fields and falls back to JSON", () => {
    expect(describeVisionOutput({ answer: "a red button" })).toBe("a red button");
    expect(describeVisionOutput({ result: { caption: "a chart" } })).toBe("a chart");
    expect(describeVisionOutput({ objects: [1] })).toBe('{"objects":[1]}');
  });
});

describe("reasoningParameters", () => {
  it("maps adaptive modes to Qwen and DeepSeek reasoning effort", () => {
    expect(reasoningParameters("@cf/qwen/qwen3.8-27b", "fast")).toEqual({ reasoning_effort: "low" });
    expect(reasoningParameters("@cf/qwen/qwen3.8-27b", "deep")).toEqual({ reasoning_effort: "xhigh" });
    expect(reasoningParameters("@cf/deepseek-ai/deepseek-v4-pro-0813", "deep")).toEqual({ reasoning_effort: "high" });
  });

  it("toggles Kimi thinking and leaves unsupported models untouched", () => {
    expect(reasoningParameters("@cf/moonshotai/kimi-k2.6", "fast")).toEqual({ chat_template_kwargs: { thinking: false } });
    expect(reasoningParameters("@cf/moonshotai/kimi-k2.6", "normal")).toEqual({ chat_template_kwargs: { thinking: true } });
    expect(reasoningParameters("@cf/google/gemma-4-26b-a4b-it", "deep")).toEqual({});
  });
});
