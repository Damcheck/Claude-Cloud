import { AGENTS, AGENT_IDS } from "../agents/registry";
import { LIMITS } from "../config";
import { splitForTelegram } from "../council/text";
import type { AgentId, Env, IncomingMessage } from "../types";

/** Subset of the Telegram Update we use. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot: boolean; first_name: string; username?: string };
  text?: string;
  caption?: string;
  photo?: { file_id: string; width: number; height: number; file_size?: number }[];
  document?: { file_id: string; mime_type?: string; file_size?: number };
  reply_to_message?: TelegramMessage;
}

export function botToken(env: Env, agent: AgentId): string | undefined {
  return env[AGENTS[agent].botTokenKey] as string | undefined;
}

/** Map a bot username like "DamAtlasBot" back to the agent whose name it contains. */
export function agentFromUsername(username: string | undefined): AgentId | undefined {
  if (!username) return undefined;
  const u = username.toLowerCase();
  return AGENT_IDS.find((id) => u.includes(AGENTS[id].name.toLowerCase()));
}

/** Convert a Telegram message to our IncomingMessage. Returns null for anything we ignore. */
export function parseIncoming(msg: TelegramMessage): IncomingMessage | null {
  // Only humans start turns. Agents' own posts are recorded by the orchestrator, not via webhook.
  if (!msg.from || msg.from.is_bot) return null;
  const text = msg.text ?? msg.caption ?? "";
  const largestPhoto = msg.photo?.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  const imageDoc = msg.document?.mime_type?.startsWith("image/") ? msg.document : undefined;
  const imageFileId = largestPhoto?.file_id ?? imageDoc?.file_id;
  if (!text && !imageFileId) return null;

  const replyFrom = msg.reply_to_message?.from;
  return {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    fromName: msg.from.first_name,
    text,
    imageFileId,
    replyToAgent: replyFrom?.is_bot ? agentFromUsername(replyFrom.username) : undefined,
  };
}

async function call<T>(token: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
  return json.result as T;
}

/** Post as a specific agent. Falls back to the host bot (with a name prefix) if that agent has no token. */
export async function sendAs(env: Env, agent: AgentId, chatId: number, text: string): Promise<number | undefined> {
  const own = botToken(env, agent);
  const host = botToken(env, env.HOST_AGENT as AgentId);
  const token = own ?? host;
  if (!token) throw new Error(`No bot token for ${agent} or host`);
  const body = own ? text : `${AGENTS[agent].emoji} ${AGENTS[agent].name}:\n${text}`;

  let firstId: number | undefined;
  for (const chunk of splitForTelegram(body, LIMITS.telegramMaxChars)) {
    const sent = await call<{ message_id: number }>(token, "sendMessage", { chat_id: chatId, text: chunk });
    firstId ??= sent.message_id;
  }
  return firstId;
}

/** System notices (/status, /help, errors) go out through the host bot. */
export async function sendSystem(env: Env, chatId: number, text: string): Promise<void> {
  const token = botToken(env, env.HOST_AGENT as AgentId);
  if (!token) return;
  await call(token, "sendMessage", { chat_id: chatId, text });
}

export async function sendTyping(env: Env, agent: AgentId, chatId: number): Promise<void> {
  const token = botToken(env, agent) ?? botToken(env, env.HOST_AGENT as AgentId);
  if (!token) return;
  await call(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

/** Download a file the host bot can see and return it as a data URI (never expose the token URL). */
export async function downloadAsDataUri(env: Env, fileId: string): Promise<string> {
  const token = botToken(env, env.HOST_AGENT as AgentId);
  if (!token) throw new Error("Host bot token missing");
  const file = await call<{ file_path: string }>(token, "getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`File download failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const ext = file.file_path.split(".").pop()?.toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${btoa(binary)}`;
}
