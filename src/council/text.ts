import { PASS_TOKEN } from "../agents/prompts";
import { AGENTS } from "../agents/registry";
import type { AgentId } from "../types";

/** Remove reasoning blocks some models emit inline. */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();
}

/** Remove "Atlas:" / "🧠 Atlas:" if the model prefixed its own name despite instructions. */
export function stripSelfPrefix(agent: AgentId, text: string): string {
  const name = AGENTS[agent].name;
  return text.replace(new RegExp(`^\\s*(\\S+\\s+)?\\**${name}\\**\\s*:\\s*`, "i"), "").trim();
}

/** True when the agent chose to stay silent. Tolerates "[PASS]." or "PASS". */
export function isPass(text: string): boolean {
  const t = text.trim().replace(/[.*_`]/g, "");
  return t === "" || t.toUpperCase() === PASS_TOKEN || t.toUpperCase() === "PASS";
}

export function cleanReply(agent: AgentId, raw: string): string | null {
  const text = stripSelfPrefix(agent, stripReasoning(raw));
  return isPass(text) ? null : text;
}
