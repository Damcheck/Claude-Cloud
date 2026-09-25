/**
 * Phone calls via Twilio Media Streams: 8 kHz μ-law audio over a WebSocket.
 * Pure helpers here (codec, VAD, WAV, TwiML, signature check); the room does the wiring.
 */

// ---------------------------------------------------------------- μ-law codec
const MULAW_BIAS = 0x84;

export function mulawDecodeSample(u: number): number {
  const x = ~u & 0xff;
  const sign = x & 0x80;
  const exponent = (x >> 4) & 0x07;
  const mantissa = x & 0x0f;
  const sample = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  return sign ? -sample : sample;
}

export function mulawEncodeSample(pcm: number): number {
  const sign = pcm < 0 ? 0x80 : 0;
  let s = Math.min(32635, Math.abs(pcm)) + MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawToPcm16(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = mulawDecodeSample(bytes[i]!);
  return out;
}

// ------------------------------------------------------------------ WAV / VAD
export function pcm16ToWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i]!, true);
  return new Uint8Array(buf);
}

export function rms(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += (samples[i]! / 32768) ** 2;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

export type VadEvent = { type: "start" } | { type: "end"; audio: Int16Array } | null;

/** Energy-based voice activity detection with an adaptive noise floor (same idea as the browser client). */
export class EnergyVad {
  private noise = 0.01;
  private loud = 0;
  private speaking = false;
  private silenceMs = 0;
  private speechMs = 0;
  private chunks: Int16Array[] = [];
  private preroll: Int16Array[] = [];

  constructor(
    private sampleRate: number,
    private endSilenceMs = 800,
    private maxMs = 25_000,
  ) {}

  /** `boost` raises the threshold, e.g. while the council is talking (echo). */
  push(frame: Int16Array, boost = 1): VadEvent {
    const level = rms(frame);
    const frameMs = (frame.length / this.sampleRate) * 1000;
    const threshold = Math.max(0.015, this.noise * 3) * boost;
    if (!this.speaking) {
      this.noise = this.noise * 0.95 + level * 0.05;
      this.preroll.push(frame);
      if (this.preroll.length > 10) this.preroll.shift();
      this.loud = level > threshold ? this.loud + 1 : 0;
      if (this.loud >= 3) {
        this.speaking = true;
        this.chunks = [...this.preroll];
        this.preroll = [];
        this.silenceMs = 0;
        this.speechMs = 0;
        return { type: "start" };
      }
      return null;
    }
    this.chunks.push(frame);
    this.speechMs += frameMs;
    this.silenceMs = level > threshold ? 0 : this.silenceMs + frameMs;
    if (this.silenceMs >= this.endSilenceMs || this.speechMs >= this.maxMs) {
      this.speaking = false;
      this.loud = 0;
      const total = this.chunks.reduce((n, c) => n + c.length, 0);
      const audio = new Int16Array(total);
      let o = 0;
      for (const c of this.chunks) {
        audio.set(c, o);
        o += c.length;
      }
      this.chunks = [];
      return this.speechMs - this.silenceMs >= 300 ? { type: "end", audio } : null;
    }
    return null;
  }
}

// --------------------------------------------------------------------- Twilio
export function twiml(streamUrl: string, token: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Connecting you to the council.</Say><Connect><Stream url="${esc(streamUrl)}"><Parameter name="token" value="${esc(token)}"/></Stream></Connect></Response>`;
}

export function twimlReject(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`;
}

/** https://www.twilio.com/docs/usage/security#validating-requests */
export async function validateTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  const expected = btoa(String.fromCharCode(...sig));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export function normalizePhone(n: string): string {
  return n.replace(/[^\d+]/g, "");
}
