import type { CallOptions } from "../ai/workers-ai";
import type { MemoryStore } from "../memory/store";
import type { AgentId, Env, TranscriptMessage } from "../types";

export type SkillRisk = "read" | "write" | "exec";

/** Things a skill may ask the room (Durable Object) to do. */
export interface RoomHooks {
  /** Re-plan the room's alarm after scheduling a follow-up. */
  scheduleNext(): Promise<void>;
  sendPhoto(agent: AgentId, png: Uint8Array, caption?: string): Promise<void>;
  /** Post the ✅ / ❌ buttons for approval request `id`. */
  requestApproval(id: number, agent: AgentId, summary: string): Promise<void>;
}

export interface SkillContext {
  env: Env;
  store: MemoryStore;
  /** Conversation id (storage key). */
  convId: number;
  /** Telegram chat id (where to post). */
  chatId: number;
  agent: AgentId;
  /** This conversation plus the home group, so DMs share group memory. */
  sharedConvIds: number[];
  /** Data URI of the image in play, if any. */
  image?: string;
  /** Recent conversation, for skills that consult other members. */
  transcript: TranscriptMessage[];
  /** 0 for a normal turn; 1 inside a private consultation (which may not consult again). */
  consultDepth: number;
  callOptions: CallOptions;
  hooks?: RoomHooks;
}

/**
 * A typed capability an agent can decide to use on its own.
 * External repos / MCP servers / APIs are always wrapped behind one of these;
 * agents never execute arbitrary code or install things themselves.
 */
export interface Skill {
  id: string;
  /** Shown to the model: say *when* to use it, not just what it does. */
  description: string;
  /** JSON schema for the arguments. */
  parameters: Record<string, unknown>;
  risk: SkillRisk;
  /** Calls that need the founder's ✅ first. A function lets only some calls need approval. */
  requiresApproval?: boolean | ((args: Record<string, unknown>) => boolean);
  /** One line shown on the approval request. */
  describeCall?(args: Record<string, unknown>): string;
  /** False when a binding or API key the skill needs is missing; the skill is then not offered. */
  available?(env: Env): boolean;
  run(args: Record<string, unknown>, ctx: SkillContext): Promise<string>;
}

export function needsApproval(skill: Skill, args: Record<string, unknown>): boolean {
  const r = skill.requiresApproval;
  return typeof r === "function" ? r(args) : !!r;
}

export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : v == null ? fallback : String(v);
}

export function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
