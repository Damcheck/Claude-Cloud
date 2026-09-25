import { runRaw } from "../ai/workers-ai";

/**
 * Deepgram Flux on Workers AI: streaming speech-to-text with built-in turn detection.
 * We stream raw 16-bit PCM in and get StartOfTurn / EndOfTurn events out, which is faster
 * and more accurate than waiting for silence.
 */

export const FLUX_MODEL = "@cf/deepgram/flux";

export type FluxEvent = { type: "start" } | { type: "end"; transcript: string } | null;

export function parseFluxMessage(data: string): FluxEvent {
  let msg: { event?: string; transcript?: string };
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (msg.event === "StartOfTurn") return { type: "start" };
  if (msg.event === "EndOfTurn" && msg.transcript?.trim()) return { type: "end", transcript: msg.transcript.trim() };
  return null;
}

export class FluxSession {
  private ws: WebSocket | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static async open(ai: Ai, sampleRate: number, onEvent: (e: Exclude<FluxEvent, null>) => void): Promise<FluxSession | null> {
    try {
      const resp = (await runRaw(ai, FLUX_MODEL, { encoding: "linear16", sample_rate: String(sampleRate), eot_threshold: "0.7", eot_timeout_ms: "3000" }, { websocket: true })) as Response;
      const ws = resp.webSocket;
      if (!ws) return null;
      ws.accept();
      ws.addEventListener("message", (e) => {
        const ev = typeof e.data === "string" ? parseFluxMessage(e.data) : null;
        if (ev) onEvent(ev);
      });
      return new FluxSession(ws);
    } catch (err) {
      console.warn("Flux unavailable, falling back to VAD + Whisper", err);
      return null;
    }
  }

  send(pcm: ArrayBuffer | Uint8Array): void {
    try {
      this.ws?.send(pcm);
    } catch {
      this.ws = null;
    }
  }

  get open(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
  }
}
