/**
 * Who may join a live call:
 *  - inside Telegram: the Mini App's initData, signed by Telegram with the host bot token;
 *  - in a browser: a room link signed by us (/call), valid for a few hours.
 */

const enc = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array | string, data: string): Promise<ArrayBuffer> {
  const raw = typeof key === "string" ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface InitDataUser {
  userId: number;
  firstName: string;
  startParam?: string;
}

/** https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
export async function validateInitData(initData: string, botToken: string, maxAgeSec = 24 * 3600, now = Date.now()): Promise<InitDataUser | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const checkString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = await hmac("WebAppData", botToken);
  const expected = hex(await hmac(secret, checkString));
  if (!safeEqual(expected, hash)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!authDate || now / 1000 - authDate > maxAgeSec) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "{}") as { id?: number; first_name?: string };
    if (!user.id) return null;
    return { userId: user.id, firstName: user.first_name ?? "", startParam: params.get("start_param") ?? undefined };
  } catch {
    return null;
  }
}

/** Mini App start_param only allows [A-Za-z0-9_-]; negative group ids become "m123…". */
export function encodeRoom(convId: number): string {
  return String(convId).replace("-", "m");
}

export function decodeRoom(param: string): number | null {
  const n = Number(param.replace(/^m/, "-"));
  return Number.isSafeInteger(n) && n !== 0 ? n : null;
}

export async function signRoomToken(secret: string, convId: number, ttlMs = 6 * 3600_000, now = Date.now()): Promise<string> {
  const exp = Math.floor((now + ttlMs) / 1000);
  const payload = `${encodeRoom(convId)}.${exp}`;
  return `${payload}.${b64url(await hmac(secret, payload))}`;
}

export async function verifyRoomToken(secret: string, token: string, now = Date.now()): Promise<number | null> {
  const [room, exp, sig] = token.split(".");
  if (!room || !exp || !sig) return null;
  if (Number(exp) * 1000 < now) return null;
  const expected = b64url(await hmac(secret, `${room}.${exp}`));
  if (!safeEqual(expected, sig)) return null;
  return decodeRoom(room);
}
