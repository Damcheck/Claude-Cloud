/**
 * Thin adapter over env.AI.run.
 *
 * Workers AI models return either the legacy shape `{ response, tool_calls }` or the
 * OpenAI-compatible shape `{ choices: [{ message: { content, tool_calls } }] }`.
 * Everything above this file only sees the normalized types below.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
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

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

/** Per-call options passed through to env.AI.run (AI Gateway routing and tags). */
export interface CallOptions {
  gatewayId?: string;
  /** Shown in AI Gateway logs, e.g. { agent: "atlas" }. */
  metadata?: Record<string, string | number>;
}

type RunFn = (model: string, input: unknown, options?: AiOptions) => Promise<unknown>;

function aiOptions(opts?: CallOptions): AiOptions | undefined {
  if (!opts?.gatewayId) return undefined;
  return { gateway: { id: opts.gatewayId, metadata: opts.metadata, collectLog: true } };
}

/** Model ids are newer than the generated binding types, so call through an untyped signature. */
function run(ai: Ai, model: string, input: unknown, opts?: CallOptions): Promise<unknown> {
  return (ai.run as unknown as RunFn).call(ai, model, input, aiOptions(opts));
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

function normalizeUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  return {
    promptTokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0,
    completionTokens: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0,
  };
}

export function normalizeChatOutput(out: unknown): ChatResult {
  if (typeof out === "string") return { text: out, toolCalls: [], usage: normalizeUsage(null) };
  const o = (out ?? {}) as Record<string, any>;
  const usage = normalizeUsage(o.usage);
  const message = o.choices?.[0]?.message;
  if (message) {
    return { text: String(message.content ?? ""), toolCalls: normalizeToolCalls(message.tool_calls), usage };
  }
  return { text: String(o.response ?? ""), toolCalls: normalizeToolCalls(o.tool_calls), usage };
}

export async function runChat(
  ai: Ai,
  model: string,
  messages: ChatMessage[],
  opts: { tools?: ToolDefinition[]; maxTokens: number } & CallOptions,
): Promise<ChatResult> {
  const input: Record<string, unknown> = { messages, max_tokens: opts.maxTokens };
  if (opts.tools?.length) input.tools = opts.tools;
  return normalizeChatOutput(await run(ai, model, input, opts));
}

// ---------------------------------------------------------------------------
// Vision (Moondream)
// ---------------------------------------------------------------------------

export interface VisionInput {
  task: "query" | "caption" | "detect" | "point";
  /** Public HTTPS URL or base64 data URI. */
  image: string;
  prompt?: string;
  maxTokens?: number;
}

/** Moondream-style vision call. Returns a readable string whatever the response shape. */
export async function runVision(ai: Ai, model: string, input: VisionInput, opts?: CallOptions): Promise<string> {
  const out = await run(
    ai,
    model,
    { task: input.task, image: input.image, prompt: input.prompt, max_tokens: input.maxTokens ?? 512 },
    opts,
  );
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

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function transcribe(ai: Ai, model: string, audio: Uint8Array, opts?: CallOptions): Promise<string> {
  const out = (await run(ai, model, { audio: bytesToBase64(audio), vad_filter: true }, opts)) as { text?: string };
  return (out?.text ?? "").trim();
}

export interface SpeechOptions {
  speaker: string;
  /** "ogg-opus" for Telegram voice bubbles, "mp3" for browsers. */
  format: "ogg-opus" | "mp3";
}

/** Text → audio bytes. Handles every output shape the TTS binding may return. */
export async function speak(ai: Ai, model: string, text: string, speech: SpeechOptions, opts?: CallOptions): Promise<Uint8Array> {
  const input =
    speech.format === "ogg-opus"
      ? { text, speaker: speech.speaker, encoding: "opus", container: "ogg" }
      : { text, speaker: speech.speaker, encoding: "mp3" };
  return audioBytes(await run(ai, model, input, opts));
}

export async function audioBytes(out: unknown): Promise<Uint8Array> {
  if (out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (out instanceof ReadableStream) return new Uint8Array(await new Response(out).arrayBuffer());
  if (out instanceof Response) return new Uint8Array(await out.arrayBuffer());
  if (typeof out === "string") return base64ToBytes(out);
  const o = (out ?? {}) as Record<string, unknown>;
  if (o.audio !== undefined) return audioBytes(o.audio);
  throw new Error("Unrecognized audio output");
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export async function embed(ai: Ai, model: string, texts: string[], opts?: CallOptions): Promise<number[][]> {
  const out = (await run(ai, model, { text: texts }, opts)) as { data?: number[][] };
  return out?.data ?? [];
}
