import type { CouncilRoom } from "./council/room";

export interface Env {
  AI: Ai;
  DB: D1Database;
  COUNCIL_ROOM: DurableObjectNamespace<CouncilRoom>;
  ALLOWED_CHAT_IDS: string;
  HOST_AGENT: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  BOT_TOKEN_ATLAS?: string;
  BOT_TOKEN_NOVA?: string;
  BOT_TOKEN_SAGE?: string;
  BOT_TOKEN_NEXUS?: string;
  BOT_TOKEN_AXIOM?: string;
  BOT_TOKEN_CIPHER?: string;
  BOT_TOKEN_FORGE?: string;
  BOT_TOKEN_IRIS?: string;
}

export type AgentId = "atlas" | "nova" | "sage" | "nexus" | "axiom" | "cipher" | "forge" | "iris";

export type Mode = "chat" | "direct" | "council" | "debate" | "brainstorm" | "critic";

/** A message as stored in the transcript. `speaker` is an AgentId or "human". */
export interface TranscriptMessage {
  id?: number;
  chatId: number;
  discussionId: number | null;
  speaker: AgentId | "human";
  speakerName: string;
  text: string;
  createdAt: number;
}

/** A normalized inbound human message, independent of Telegram's shape. */
export interface IncomingMessage {
  chatId: number;
  messageId: number;
  fromName: string;
  text: string;
  /** Telegram file_id of the largest photo / image document, if any. */
  imageFileId?: string;
  /** Agent the human replied to (Telegram "reply"), if any. */
  replyToAgent?: AgentId;
}
