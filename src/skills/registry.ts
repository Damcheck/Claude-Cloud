import { AGENTS } from "../agents/registry";
import type { ToolDefinition } from "../ai/workers-ai";
import type { AgentId, Env } from "../types";
import { browserInspect, browserScreenshot, browserTest } from "./builtin/browser";
import { councilConsult } from "./builtin/consult";
import { docParse, docRead } from "./builtin/docs";
import { githubCiStatus, githubComment, githubOpenPr, githubRead, githubWrite } from "./builtin/github";
import { groupRecordFact, memoryRemember, memorySearch } from "./builtin/memory";
import {
  actionsAdd,
  actionsComplete,
  claimsRecord,
  ideasSave,
  ideasSearch,
  predictionRecord,
  predictionResolve,
  scheduleFollowup,
} from "./builtin/powers";
import { sandboxExec, sandboxWriteFile } from "./builtin/sandbox";
import { visionInspect } from "./builtin/vision";
import { webFetch, webSearch } from "./builtin/web";
import type { Skill } from "./types";

/** Every skill the council can use. Which agent may use which is set in agents/registry.ts. */
export const SKILLS: Skill[] = [
  memorySearch,
  memoryRemember,
  groupRecordFact,
  webSearch,
  webFetch,
  docRead,
  docParse,
  visionInspect,
  councilConsult,
  scheduleFollowup,
  predictionRecord,
  predictionResolve,
  claimsRecord,
  ideasSave,
  ideasSearch,
  actionsAdd,
  actionsComplete,
  githubRead,
  githubWrite,
  githubOpenPr,
  githubCiStatus,
  githubComment,
  sandboxExec,
  sandboxWriteFile,
  browserInspect,
  browserTest,
  browserScreenshot,
];

const BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

export function getSkill(id: string): Skill | undefined {
  return BY_ID.get(id);
}

/** Function names must match ^[a-zA-Z0-9_-]+$ for OpenAI-style tool calling. */
export function toolName(skillId: string): string {
  return skillId.replace(/\./g, "_");
}

/** Skills this agent is permitted to use and whose bindings / keys are configured. */
export function skillsFor(agent: AgentId, env?: Env, opts: { consultDepth?: number } = {}): Skill[] {
  return AGENTS[agent].skills
    .map((id) => BY_ID.get(id))
    .filter((s): s is Skill => s !== undefined)
    .filter((s) => !env || !s.available || s.available(env))
    .filter((s) => !(opts.consultDepth && s.id === "council.consult"));
}

export function toolsFor(agent: AgentId, env?: Env, opts: { consultDepth?: number } = {}): ToolDefinition[] {
  return skillsFor(agent, env, opts).map((s) => ({
    type: "function",
    function: { name: toolName(s.id), description: s.description, parameters: s.parameters },
  }));
}

export function findSkillByToolName(agent: AgentId, name: string, env?: Env): Skill | undefined {
  return skillsFor(agent, env).find((s) => toolName(s.id) === name);
}
