/**
 * Thin adapter over env.AI.run for chat models.
 *
 * Workers AI models return either the legacy shape `{ response, tool_calls }` or the
 * OpenAI-compatible shape `{ choices: [{ message: { content, tool_calls } }] }`.
 * Everything above this file only sees the normalized `ChatResult`.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
}

interface RawToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
  function?: { name?: string; arguments?: unknown };
}

function toArgString(args: unknown): string {
  if (typeof args === "string") return args;
  return JSON.stringify(args ?? {});
}

export function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawToolCall[])
    .map((c, i): ToolCall | null => {
      const name = c.function?.name ?? c.name;
      if (!name) return null;
      return {
        id: c.id ?? `call_${i}`,
        type: "function",
        function: { name, arguments: toArgString(c.function?.arguments ?? c.arguments) },
      };
    })
    .filter((c): c is ToolCall => c !== null);
}

export function normalizeChatOutput(out: unknown): ChatResult {
  if (typeof out === "string") return { text: out, toolCalls: [] };
  const o = (out ?? {}) as Record<string, any>;
  const message = o.choices?.[0]?.message;
  if (message) {
    return { text: String(message.content ?? ""), toolCalls: normalizeToolCalls(message.tool_calls) };
  }
  return { text: String(o.response ?? ""), toolCalls: normalizeToolCalls(o.tool_calls) };
}

export async function runChat(
  ai: Ai,
  model: string,
  messages: ChatMessage[],
  opts: { tools?: ToolDefinition[]; maxTokens: number },
): Promise<ChatResult> {
  const input: Record<string, unknown> = { messages, max_tokens: opts.maxTokens };
  if (opts.tools?.length) input.tools = opts.tools;
  // Model ids are newer than the generated binding types, so call through an untyped signature.
  const out = await (ai.run as (m: string, i: unknown) => Promise<unknown>)(model, input);
  return normalizeChatOutput(out);
}

export interface VisionInput {
  task: "query" | "caption" | "detect" | "point";
  /** Public HTTPS URL or base64 data URI. */
  image: string;
  prompt?: string;
  maxTokens?: number;
}

/** Moondream-style vision call. Returns a readable string whatever the response shape. */
export async function runVision(ai: Ai, model: string, input: VisionInput): Promise<string> {
  const out = await (ai.run as (m: string, i: unknown) => Promise<unknown>)(model, {
    task: input.task,
    image: input.image,
    prompt: input.prompt,
    max_tokens: input.maxTokens ?? 512,
  });
  return describeVisionOutput(out);
}

export function describeVisionOutput(out: unknown): string {
  if (typeof out === "string") return out;
  const o = (out ?? {}) as Record<string, unknown>;
  for (const key of ["answer", "caption", "response", "text", "description"]) {
    if (typeof o[key] === "string" && o[key]) return o[key] as string;
  }
  const result = (o.result ?? o) as Record<string, unknown>;
  if (result !== o) return describeVisionOutput(result);
  return JSON.stringify(out);
}
