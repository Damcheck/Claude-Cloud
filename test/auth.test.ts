import { describe, expect, it } from "vitest";
import { decodeRoom, encodeRoom, signRoomToken, validateInitData, verifyRoomToken } from "../src/voice/auth";

const enc = new TextEncoder();
async function hmacHex(key: ArrayBuffer | Uint8Array, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function makeInitData(botToken: string, fields: Record<string, string>) {
  const check = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secretKey = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", secretKey, enc.encode(botToken));
  const params = new URLSearchParams(fields);
  params.set("hash", await hmacHex(secret, check));
  return params.toString();
}

describe("Mini App initData", () => {
  const now = Date.now();
  const fields = { auth_date: String(Math.floor(now / 1000)), user: JSON.stringify({ id: 42, first_name: "Dam" }), start_param: "m100123" };

  it("accepts data signed with the bot token", async () => {
    const data = await makeInitData("123:ABC", fields);
    expect(await validateInitData(data, "123:ABC", 3600, now)).toEqual({ userId: 42, firstName: "Dam", startParam: "m100123" });
  });

  it("rejects a different bot token, tampering and old data", async () => {
    const data = await makeInitData("123:ABC", fields);
    expect(await validateInitData(data, "999:XYZ", 3600, now)).toBeNull();
    expect(await validateInitData(data.replace("m100123", "m100999"), "123:ABC", 3600, now)).toBeNull();
    expect(await validateInitData(data, "123:ABC", 60, now + 3600_000)).toBeNull();
  });
});

describe("room links", () => {
  it("round-trips group and DM rooms", async () => {
    expect(decodeRoom(encodeRoom(-100123))).toBe(-100123);
    const token = await signRoomToken("secret", -100123, 1000, 0);
    expect(await verifyRoomToken("secret", token, 500)).toBe(-100123);
    expect(await verifyRoomToken("secret", await signRoomToken("secret", 6721, 1000, 0), 500)).toBe(6721);
  });

  it("rejects expired, forged and re-targeted tokens", async () => {
    const token = await signRoomToken("secret", -100123, 1000, 0);
    expect(await verifyRoomToken("secret", token, 5000)).toBeNull();
    expect(await verifyRoomToken("other", token, 500)).toBeNull();
    expect(await verifyRoomToken("secret", token.replace("m100123", "m100999"), 500)).toBeNull();
    expect(await verifyRoomToken("secret", "garbage", 500)).toBeNull();
  });
});
