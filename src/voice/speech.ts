import { AGENTS } from "../agents/registry";
import { bytesToBase64, speak, transcribe, type CallOptions } from "../ai/workers-ai";
import { SYSTEM_MODELS } from "../config";
import { speechChunks, speechText } from "../telegram/format";
import type { AgentId } from "../types";

export function speechToText(ai: Ai, audio: Uint8Array, opts?: CallOptions): Promise<string> {
  return transcribe(ai, SYSTEM_MODELS.speechToText, audio, opts);
}

/** One Telegram voice note (OGG/Opus) in the agent's own voice. */
export async function voiceNote(ai: Ai, agent: AgentId, markdown: string, opts?: CallOptions): Promise<Uint8Array | null> {
  const text = speechText(markdown).slice(0, 1800);
  if (!text) return null;
  return speak(ai, SYSTEM_MODELS.textToSpeech, text, { speaker: AGENTS[agent].voice, format: "ogg-opus" }, opts);
}

/**
 * Browser playback for live calls: sentence groups synthesized in parallel and yielded in
 * order, so the first sentence can start playing while the rest is still being generated.
 */
export async function* speechStream(ai: Ai, agent: AgentId, markdown: string, opts?: CallOptions): AsyncGenerator<{ text: string; audioB64: string }> {
  const chunks = speechChunks(speechText(markdown));
  const pending = chunks.map((text) =>
    speak(ai, SYSTEM_MODELS.textToSpeech, text, { speaker: AGENTS[agent].voice, format: "mp3" }, opts).then((bytes) => ({
      text,
      audioB64: bytesToBase64(bytes),
    })),
  );
  // If the caller stops early (interruption), later chunks must not surface as unhandled rejections.
  for (const p of pending) p.catch(() => {});
  for (const p of pending) yield await p;
}

/** Rough speaking time, used to schedule the next speaker if the client never reports playback end. */
export function estimateSpeechMs(text: string): number {
  const words = speechText(text).split(/\s+/).filter(Boolean).length;
  return Math.min(60_000, 800 + (words / 2.6) * 1000);
}

/** Phone playback: sentence groups as raw 8 kHz μ-law, in order. */
export async function* phoneSpeechStream(ai: Ai, agent: AgentId, markdown: string, opts?: CallOptions): AsyncGenerator<Uint8Array> {
  const chunks = speechChunks(speechText(markdown));
  const pending = chunks.map((text) => speak(ai, SYSTEM_MODELS.textToSpeech, text, { speaker: AGENTS[agent].voice, format: "mulaw-8k" }, opts));
  for (const p of pending) p.catch(() => {});
  for (const p of pending) yield await p;
}
