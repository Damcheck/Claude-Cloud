import { AGENTS } from "../agents/registry";
import type { ToolDefinition } from "../ai/workers-ai";
import type { AgentId } from "../types";
import { groupRecordFact, memoryRemember, memorySearch } from "./builtin/memory";
import { visionInspect } from "./builtin/vision";
import { webFetch } from "./builtin/web";
import type { Skill } from "./types";

/**
 * Every skill the council can use. Planned skills (docs/SPEC.md §7) are added here
 * as they're built: web.search, doc.parse, github.*, sandbox.exec, browser.*.
 */
export const SKILLS: Skill[] = [memorySearch, memoryRemember, groupRecordFact, webFetch, visionInspect];

const BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

/** Function names must match ^[a-zA-Z0-9_-]+$ for OpenAI-style tool calling. */
export function toolName(skillId: string): string {
  return skillId.replace(/\./g, "_");
}

export function skillsFor(agent: AgentId): Skill[] {
  return AGENTS[agent].skills.map((id) => BY_ID.get(id)).filter((s): s is Skill => s !== undefined);
}

export function toolsFor(agent: AgentId): ToolDefinition[] {
  return skillsFor(agent).map((s) => ({
    type: "function",
    function: { name: toolName(s.id), description: s.description, parameters: s.parameters },
  }));
}

export function findSkillByToolName(agent: AgentId, name: string): Skill | undefined {
  return skillsFor(agent).find((s) => toolName(s.id) === name);
}
