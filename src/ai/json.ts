import { runChat, type CallOptions, type ChatMessage } from "./workers-ai";

/** Pull the first JSON object or array out of model output (reasoning, fences and prose tolerated). */
export function extractJson<T = unknown>(text: string): T | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
  const start = cleaned.search(/[{[]/);
  if (start === -1) return null;
  const open = cleaned[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, i + 1)) as T;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Ask a model for JSON; one retry with a reminder if the first answer doesn't parse. */
export async function askJson<T>(
  ai: Ai,
  model: string,
  messages: ChatMessage[],
  opts: { maxTokens: number } & CallOptions,
): Promise<{ value: T | null; promptTokens: number; completionTokens: number }> {
  let p = 0;
  let c = 0;
  let history = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await runChat(ai, model, history, opts);
    p += r.usage.promptTokens;
    c += r.usage.completionTokens;
    const value = extractJson<T>(r.text);
    if (value !== null) return { value, promptTokens: p, completionTokens: c };
    history = [...messages, { role: "assistant", content: r.text }, { role: "user", content: "Reply with only the JSON, nothing else." }];
  }
  return { value: null, promptTokens: p, completionTokens: c };
}
