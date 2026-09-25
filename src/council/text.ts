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

/** Split text into Telegram-sized chunks, preferring paragraph then line boundaries. */
export function splitForTelegram(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max * 0.5) cut = window.lastIndexOf("\n");
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
