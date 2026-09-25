import { AGENTS, AGENT_IDS } from "../agents/registry";
import { bytesToBase64 } from "../ai/workers-ai";
import { LIMITS } from "../config";
import type { AgentId, CallbackAction, Env, IncomingMessage } from "../types";
import { escapeHtml, markdownToTelegramHtml, splitMarkdown } from "./format";

/** Subset of the Telegram Update we use. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number; is_bot: boolean; first_name: string };
    message?: TelegramMessage;
    data?: string;
  };
  message_reaction?: {
    chat: { id: number; type: string };
    message_id: number;
    user?: { id: number; is_bot: boolean };
    old_reaction: { type: string; emoji?: string }[];
    new_reaction: { type: string; emoji?: string }[];
  };
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot: boolean; first_name: string; username?: string };
  text?: string;
  caption?: string;
  photo?: { file_id: string; width: number; height: number; file_size?: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; duration: number };
  audio?: { file_id: string; duration: number };
  video_note?: { file_id: string; duration: number };
  reply_to_message?: TelegramMessage;
}

export type InlineKeyboard = { text: string; callback_data?: string; url?: string }[][];

export function botToken(env: Env, agent: AgentId): string | undefined {
  return env[AGENTS[agent].botTokenKey] as string | undefined;
}

export function hostAgent(env: Env): AgentId {
  return (AGENT_IDS as string[]).includes(env.HOST_AGENT) ? (env.HOST_AGENT as AgentId) : "nexus";
}

/** Map a bot username like "DamAtlasBot" back to the agent whose name it contains. */
export function agentFromUsername(username: string | undefined): AgentId | undefined {
  if (!username) return undefined;
  const u = username.toLowerCase();
  return AGENT_IDS.find((id) => u.includes(AGENTS[id].name.toLowerCase()));
}

/**
 * Telegram gives a user's DMs with every bot the same chat id (the user id), so each
 * agent's DM needs its own conversation id. Group ids are negative; these are positive.
 */
export function dmConvId(userId: number, agent: AgentId): number {
  return userId * 16 + AGENT_IDS.indexOf(agent) + 1;
}

export function parseIds(list: string): string[] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isOwner(env: Env, userId: number): boolean {
  const owners = parseIds(env.OWNER_USER_IDS);
  return owners.length === 0 || owners.includes(String(userId));
}

/**
 * Convert a Telegram message received by `viaAgent`'s bot into an IncomingMessage.
 * Returns null for anything we ignore. Group messages are only taken from the host bot,
 * otherwise every bot in the group would start the same discussion.
 */
export function parseIncoming(msg: TelegramMessage, viaAgent: AgentId, host: AgentId): IncomingMessage | null {
  // Only humans start turns. Agents' own posts are recorded by the orchestrator.
  if (!msg.from || msg.from.is_bot) return null;
  const isPrivate = msg.chat.type === "private";
  if (!isPrivate && viaAgent !== host) return null;

  const text = msg.text ?? msg.caption ?? "";
  const largestPhoto = msg.photo?.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  const imageDoc = msg.document?.mime_type?.startsWith("image/") ? msg.document : undefined;
  const imageFileId = largestPhoto?.file_id ?? imageDoc?.file_id;
  const voiceFileId = (msg.voice ?? msg.audio ?? msg.video_note)?.file_id;
  const document =
    msg.document && !imageDoc
      ? { fileId: msg.document.file_id, name: msg.document.file_name ?? "document", mimeType: msg.document.mime_type }
      : undefined;
  if (!text && !imageFileId && !voiceFileId && !document) return null;

  const replyFrom = msg.reply_to_message?.from;
  return {
    chatId: msg.chat.id,
    convId: isPrivate ? dmConvId(msg.from.id, viaAgent) : msg.chat.id,
    messageId: msg.message_id,
    fromId: msg.from.id,
    fromName: msg.from.first_name,
    text,
    dmAgent: isPrivate ? viaAgent : undefined,
    imageFileId,
    voiceFileId,
    document,
    replyToAgent: replyFrom?.is_bot ? agentFromUsername(replyFrom.username) : undefined,
  };
}

export function parseCallback(update: TelegramUpdate, viaAgent: AgentId): CallbackAction | null {
  const cq = update.callback_query;
  if (!cq?.message || !cq.data) return null;
  const isPrivate = cq.message.chat.type === "private";
  return {
    chatId: cq.message.chat.id,
    convId: isPrivate ? dmConvId(cq.from.id, viaAgent) : cq.message.chat.id,
    fromId: cq.from.id,
    callbackId: cq.id,
    messageId: cq.message.message_id,
    data: cq.data,
    viaAgent,
  };
}

const POSITIVE = ["👍", "❤", "❤️", "🔥", "🎉", "👏", "💯", "🤩", "🏆", "⚡", "🙏", "👌", "😍"];
const NEGATIVE = ["👎", "💩", "🤮", "😡", "🤡", "🥱", "😴", "🤨", "😐"];

export function reactionScore(emoji: string): number {
  if (POSITIVE.includes(emoji)) return 1;
  if (NEGATIVE.includes(emoji)) return -1;
  return 0;
}

export interface ReactionEvent {
  convId: number;
  chatId: number;
  fromId: number;
  messageId: number;
  emoji: string;
  score: number;
}

/** Newly added emoji reactions (the founder's feedback on an agent's message). */
export function parseReactions(update: TelegramUpdate, viaAgent: AgentId): ReactionEvent[] {
  const r = update.message_reaction;
  if (!r?.user || r.user.is_bot) return [];
  const old = new Set(r.old_reaction.map((x) => x.emoji));
  const isPrivate = r.chat.type === "private";
  return r.new_reaction
    .filter((x) => x.type === "emoji" && x.emoji && !old.has(x.emoji))
    .map((x) => ({
      convId: isPrivate ? dmConvId(r.user!.id, viaAgent) : r.chat.id,
      chatId: r.chat.id,
      fromId: r.user!.id,
      messageId: r.message_id,
      emoji: x.emoji!,
      score: reactionScore(x.emoji!),
    }));
}

// ---------------------------------------------------------------------------
// Bot API calls
// ---------------------------------------------------------------------------

export class TelegramError extends Error {
  constructor(
    public method: string,
    public description: string,
  ) {
    super(`Telegram ${method} failed: ${description}`);
  }
}

async function call<T>(token: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new TelegramError(method, json.description ?? String(res.status));
  return json.result as T;
}

async function callMultipart<T>(token: string, method: string, form: FormData): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new TelegramError(method, json.description ?? String(res.status));
  return json.result as T;
}

/** The token to post as `agent`: its own bot, or the host bot as a fallback (never in DMs). */
function tokenFor(env: Env, agent: AgentId): { token: string; own: boolean } {
  const own = botToken(env, agent);
  if (own) return { token: own, own: true };
  const host = botToken(env, hostAgent(env));
  if (!host) throw new Error(`No bot token for ${agent} or the host`);
  return { token: host, own: false };
}

function namePrefix(agent: AgentId): string {
  return `${AGENTS[agent].emoji} <b>${AGENTS[agent].name}</b>\n`;
}

/** Send Markdown as Telegram HTML; if Telegram rejects the markup, resend as plain text. */
async function sendFormatted(
  token: string,
  chatId: number,
  markdown: string,
  prefix: string,
  replyMarkup?: { inline_keyboard: InlineKeyboard },
): Promise<number> {
  try {
    const sent = await call<{ message_id: number }>(token, "sendMessage", {
      chat_id: chatId,
      text: prefix + markdownToTelegramHtml(markdown),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup,
    });
    return sent.message_id;
  } catch (err) {
    if (!(err instanceof TelegramError) || !/parse|entit|tag/i.test(err.description)) throw err;
    const plainPrefix = prefix.replace(/<[^>]+>/g, "");
    const sent = await call<{ message_id: number }>(token, "sendMessage", {
      chat_id: chatId,
      text: plainPrefix + markdown,
      reply_markup: replyMarkup,
    });
    return sent.message_id;
  }
}

/** Post Markdown as a specific agent. Returns the first Telegram message id. */
export async function sendAs(
  env: Env,
  agent: AgentId,
  chatId: number,
  markdown: string,
  replyMarkup?: { inline_keyboard: InlineKeyboard },
): Promise<number | undefined> {
  const { token, own } = tokenFor(env, agent);
  const prefix = own ? "" : namePrefix(agent);
  // HTML escaping (&lt; etc.) can grow a chunk, so leave generous headroom under 4096.
  const chunks = splitMarkdown(markdown, LIMITS.telegramMaxChars - 1100);
  let firstId: number | undefined;
  for (const [i, chunk] of chunks.entries()) {
    const last = i === chunks.length - 1;
    const id = await sendFormatted(token, chatId, chunk, i === 0 ? prefix : "", last ? replyMarkup : undefined);
    firstId ??= id;
  }
  return firstId;
}

/** System notices go out through `via` (the DM agent) or the host bot. */
export async function sendSystem(env: Env, chatId: number, text: string, via?: AgentId): Promise<void> {
  const token = botToken(env, via ?? hostAgent(env));
  if (!token) return;
  await call(token, "sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
}

/** Post an HTML-formatted system notice with optional buttons. */
export async function sendSystemHtml(
  env: Env,
  chatId: number,
  html: string,
  via?: AgentId,
  replyMarkup?: { inline_keyboard: InlineKeyboard },
): Promise<number | undefined> {
  const token = botToken(env, via ?? hostAgent(env));
  if (!token) return undefined;
  const sent = await call<{ message_id: number }>(token, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: replyMarkup,
  });
  return sent.message_id;
}

export async function sendVoiceAs(env: Env, agent: AgentId, chatId: number, ogg: Uint8Array, caption?: string): Promise<number> {
  const { token, own } = tokenFor(env, agent);
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("voice", new Blob([ogg], { type: "audio/ogg" }), `${agent}.ogg`);
  const text = (own ? "" : `${AGENTS[agent].emoji} ${AGENTS[agent].name}: `) + (caption ?? "");
  if (text) form.set("caption", text.slice(0, LIMITS.telegramMaxCaption));
  const sent = await callMultipart<{ message_id: number }>(token, "sendVoice", form);
  return sent.message_id;
}

/** Returns the file_id of the largest size Telegram stored, so the image can be fetched again later. */
export async function sendPhotoAs(env: Env, agent: AgentId, chatId: number, image: Uint8Array, caption?: string): Promise<string | undefined> {
  const { token } = tokenFor(env, agent);
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("photo", new Blob([image], { type: "image/png" }), "image.png");
  if (caption) form.set("caption", caption.slice(0, LIMITS.telegramMaxCaption));
  const sent = await callMultipart<{ photo?: { file_id: string; width: number; height: number }[] }>(token, "sendPhoto", form);
  return sent.photo?.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a)).file_id;
}

export async function sendDocumentAs(env: Env, agent: AgentId, chatId: number, name: string, content: string, caption?: string): Promise<void> {
  const { token } = tokenFor(env, agent);
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("document", new Blob([content], { type: "text/markdown" }), name);
  if (caption) form.set("caption", caption.slice(0, LIMITS.telegramMaxCaption));
  await callMultipart(token, "sendDocument", form);
}

export async function sendTyping(env: Env, agent: AgentId, chatId: number, action: "typing" | "record_voice" = "typing"): Promise<void> {
  const token = botToken(env, agent) ?? botToken(env, hostAgent(env));
  if (!token) return;
  await call(token, "sendChatAction", { chat_id: chatId, action }).catch(() => {});
}

export async function answerCallback(env: Env, via: AgentId, callbackId: string, text: string): Promise<void> {
  const token = botToken(env, via);
  if (!token) return;
  await call(token, "answerCallbackQuery", { callback_query_id: callbackId, text }).catch(() => {});
}

export async function editMessageHtml(env: Env, via: AgentId, chatId: number, messageId: number, html: string): Promise<void> {
  const token = botToken(env, via);
  if (!token) return;
  await call(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  }).catch((err) => console.warn("editMessageText failed", err));
}

/** Download a file visible to `via`'s bot. The file URL contains the token, so it never leaves this function. */
export async function downloadFile(env: Env, fileId: string, via?: AgentId): Promise<{ bytes: Uint8Array; path: string }> {
  const token = botToken(env, via ?? hostAgent(env));
  if (!token) throw new Error("Bot token missing for file download");
  const file = await call<{ file_path: string }>(token, "getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`File download failed: ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), path: file.file_path };
}

export async function downloadAsDataUri(env: Env, fileId: string, via?: AgentId): Promise<string> {
  const { bytes, path } = await downloadFile(env, fileId, via);
  const ext = path.split(".").pop()?.toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

export { escapeHtml };
