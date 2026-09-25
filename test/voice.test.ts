import { describe, expect, it } from "vitest";
import { parseFluxMessage } from "../src/voice/flux";
import { EnergyVad, mulawDecodeSample, mulawEncodeSample, mulawToPcm16, pcm16ToWav, twiml, validateTwilioSignature } from "../src/voice/phone";

describe("μ-law", () => {
  it("round-trips within quantization error", () => {
    for (const v of [0, 100, -100, 1000, -5000, 20000, -32000]) {
      const back = mulawDecodeSample(mulawEncodeSample(v));
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(8, Math.abs(v) * 0.07));
    }
    expect(mulawToPcm16(new Uint8Array([0xff, 0x7f])).length).toBe(2);
  });
});

describe("server VAD", () => {
  const tone = (n: number, amp: number) => Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 3) * amp));
  it("detects an utterance between silences", () => {
    const vad = new EnergyVad(8000, 400);
    const events: string[] = [];
    let audio: Int16Array | undefined;
    for (let i = 0; i < 20; i++) vad.push(tone(160, 30));
    for (let i = 0; i < 40; i++) {
      const e = vad.push(tone(160, 12000));
      if (e) events.push(e.type);
    }
    for (let i = 0; i < 40; i++) {
      const e = vad.push(tone(160, 30));
      if (e) {
        events.push(e.type);
        if (e.type === "end") audio = e.audio;
      }
    }
    expect(events).toEqual(["start", "end"]);
    expect(audio!.length).toBeGreaterThan(160 * 30);
  });

  it("writes a valid WAV header", () => {
    const wav = pcm16ToWav(new Int16Array(10), 8000);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(8000);
    expect(wav.length).toBe(64);
  });
});

describe("Twilio", () => {
  it("validates request signatures", async () => {
    const token = "12345";
    const url = "https://council.example/twilio/voice";
    const params = { CallSid: "CA1", From: "+15550001111" };
    const data = url + "CallSidCA1From+15550001111";
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))));
    expect(await validateTwilioSignature(token, url, params, sig)).toBe(true);
    expect(await validateTwilioSignature(token, url, { ...params, From: "+1999" }, sig)).toBe(false);
    expect(await validateTwilioSignature(token, url, params, null)).toBe(false);
  });

  it("builds TwiML with the token as a stream parameter", () => {
    const x = twiml("wss://h/twilio/stream", "a.b&c");
    expect(x).toContain('<Stream url="wss://h/twilio/stream">');
    expect(x).toContain('<Parameter name="token" value="a.b&amp;c"/>');
  });
});

describe("Flux", () => {
  it("maps turn events", () => {
    expect(parseFluxMessage('{"event":"StartOfTurn"}')).toEqual({ type: "start" });
    expect(parseFluxMessage('{"event":"EndOfTurn","transcript":" hello council "}')).toEqual({ type: "end", transcript: "hello council" });
    expect(parseFluxMessage('{"event":"Update","transcript":"hel"}')).toBeNull();
    expect(parseFluxMessage("not json")).toBeNull();
  });
});
