import type { MemoryStore } from "../memory/store";
import type { AgentId, Env } from "../types";

export type SkillRisk = "read" | "write" | "exec";

export interface SkillContext {
  env: Env;
  store: MemoryStore;
  chatId: number;
  agent: AgentId;
  /** Data URI of the image attached to the triggering message, if any. */
  image?: string;
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
  /** Write/exec skills listed here never run without human approval (phase 9). */
  requiresApproval?: boolean;
  run(args: Record<string, unknown>, ctx: SkillContext): Promise<string>;
}
