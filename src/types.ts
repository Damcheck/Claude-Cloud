import type { Sandbox } from "@cloudflare/sandbox";
import type { CouncilRoom } from "./council/room";
import type { JobParams } from "./jobs/types";

export interface Env {
  AI: Ai;
  DB: D1Database;
  COUNCIL_ROOM: DurableObjectNamespace<CouncilRoom>;
  /** Optional bindings: the skills that need them turn themselves off when missing. */
  VECTORIZE?: VectorizeIndex;
  /** Durable jobs: missions, research, design loop, evals, reflection, scouting. */
  JOBS?: Workflow<JobParams>;
  /** Runs council-built tools in their own isolate. */
  LOADER?: WorkerLoader;
  /** Weekly database exports. */
  BACKUPS?: R2Bucket;
  BROWSER?: Fetcher;
  Sandbox?: DurableObjectNamespace<Sandbox>;

  ALLOWED_CHAT_IDS: string;
  /** Telegram user ids allowed to talk to the council. Empty = anyone (not recommended). */
  OWNER_USER_IDS: string;
  /** The group whose shared memory DMs with individual agents can read. */
  HOME_CHAT_ID: string;
  HOST_AGENT: string;
  /** AI Gateway id for logs, cost and caching. Empty = call Workers AI directly. */
  AI_GATEWAY_ID: string;
  /** Max tokens (prompt + completion) each agent may use per UTC day. 0 = unlimited. */
  DAILY_TOKEN_BUDGET_PER_AGENT: string;
  /** Public https URL of this Worker (used for the voice room link). */
  PUBLIC_URL: string;
  /** Optional Telegram Mini App link, e.g. https://t.me/NexusCouncilBot/call */
  MINIAPP_URL: string;
  /** Comma-separated owner/repo list the GitHub and Sandbox skills may touch. */
  GITHUB_REPOS: string;
  /** JSON list of MCP servers: [{name, url, agents, approval?, tools?, tokenSecret?}] */
  MCP_SERVERS?: string;
  /** Shopify store for the design loop, e.g. my-store.myshopify.com */
  SHOPIFY_STORE?: string;
  /** Development theme id the design loop previews on. */
  SHOPIFY_THEME_ID?: string;
  /** Phone numbers allowed to call the council (E.164, comma-separated). */
  OWNER_PHONE_NUMBERS?: string;

  TELEGRAM_WEBHOOK_SECRET: string;
  FIRECRAWL_API_KEY?: string;
  BRAVE_API_KEY?: string;
  GITHUB_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  SHOPIFY_CLI_THEME_TOKEN?: string;
  TWILIO_AUTH_TOKEN?: string;
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

export type Mode = "chat" | "direct" | "council" | "debate" | "brainstorm" | "critic" | "live";

/**
 * A message as stored in the transcript. `speaker` is an AgentId or "human".
 * `chatId` here is the conversation id (see IncomingMessage.convId).
 */
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
  /** Telegram chat to reply in. */
  chatId: number;
  /**
   * Storage / room key. Equal to chatId for groups. For a DM with one agent's bot it is
   * derived from the user id and the agent, because Telegram uses the same chat id for
   * a user's DMs with every bot.
   */
  convId: number;
  messageId: number;
  fromId: number;
  fromName: string;
  text: string;
  /** Set when this is a private chat with one agent's bot: only that agent answers. */
  dmAgent?: AgentId;
  imageFileId?: string;
  voiceFileId?: string;
  document?: { fileId: string; name: string; mimeType?: string };
  replyToAgent?: AgentId;
  /** Filled by the room after transcription. */
  viaVoice?: boolean;
}

export interface CallbackAction {
  chatId: number;
  convId: number;
  fromId: number;
  callbackId: string;
  messageId: number;
  data: string;
  /** The bot that received the callback (the one that sent the buttons). */
  viaAgent: AgentId;
}

/** Where a conversation lives: storage key, Telegram chat, and the DM agent if it's a DM. */
export interface Identity {
  convId: number;
  chatId: number;
  dmAgent?: AgentId;
}
