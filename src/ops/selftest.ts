import { AGENTS, AGENT_IDS } from "../agents/registry";
import { embed, runChat, runVision, speak, transcribe } from "../ai/workers-ai";
import { SYSTEM_MODELS } from "../config";
import { botToken } from "../telegram/api";
import type { Env } from "../types";

/**
 * /selftest: exercises every model and binding for real, so the first deploy can be
 * verified from Telegram. Reports what works, what's slow, and response shapes that
 * didn't match what the code expects.
 */

// 32x32 PNG: red square on white, enough for a vision smoke test.
const TEST_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAMUlEQVR4nGP4T2PAMGrBqAVD2IIHCgokoVELRi0YtWDUglELhqcF1AKjFoxaMAQsAADR4ReXKj/zzQAAAABJRU5ErkJggg==";

interface Check {
  name: string;
  ok: boolean;
  ms: number;
  note: string;
}

async function timed(name: string, fn: () => Promise<string>): Promise<Check> {
  const t = Date.now();
  try {
    const note = await fn();
    return { name, ok: true, ms: Date.now() - t, note };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - t, note: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
  }
}

export async function runSelftest(env: Env): Promise<string> {
  const chatModels = [...new Set(AGENT_IDS.filter((a) => AGENTS[a].kind === "chat").flatMap((a) => [AGENTS[a].model, AGENTS[a].fallbackModel, AGENTS[a].voiceModel]))];
  const tool = { type: "function" as const, function: { name: "ping", description: "Call this to answer.", parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"] } } };

  const checks = await Promise.all([
    ...chatModels.map((m) =>
      timed(`chat ${m.split("/").pop()}`, async () => {
        const r = await runChat(env.AI, m, [{ role: "user", content: "Reply with just the word OK." }], { maxTokens: 30 });
        if (!r.text.trim()) throw new Error("empty reply (check the response shape)");
        const t = await runChat(env.AI, m, [{ role: "user", content: 'Call the ping tool with word "hi".' }], { maxTokens: 80, tools: [tool] }).catch(() => null);
        return `"${r.text.trim().slice(0, 20)}" · tools ${t?.toolCalls.length ? "✅" : "❌"}`;
      }),
    ),
    timed("vision moondream", async () => (await runVision(env.AI, AGENTS.iris.model, { task: "caption", image: TEST_PNG, maxTokens: 40 })).slice(0, 60)),
    timed("speech aura→whisper", async () => {
      const mp3 = await speak(env.AI, SYSTEM_MODELS.textToSpeech, "Hello council, this is a test.", { speaker: "athena", format: "mp3" });
      const heard = await transcribe(env.AI, SYSTEM_MODELS.speechToText, mp3);
      if (!/council|test|hello/i.test(heard)) throw new Error(`heard "${heard}"`);
      return `heard "${heard.slice(0, 40)}"`;
    }),
    timed("voice note opus", async () => `${(await speak(env.AI, SYSTEM_MODELS.textToSpeech, "Voice check.", { speaker: "zeus", format: "ogg-opus" })).length} bytes`),
    timed("embeddings", async () => `${(await embed(env.AI, SYSTEM_MODELS.embeddings, ["hello"]))[0]?.length ?? 0} dims`),
    timed("D1", async () => `${(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())?.n ?? 0} messages`),
  ]);

  const bindings = [
    ["Vectorize", !!env.VECTORIZE],
    ["Browser", !!env.BROWSER],
    ["Sandbox", !!env.Sandbox],
    ["Workflows (JOBS)", !!env.JOBS],
    ["Worker Loader", !!env.LOADER],
    ["R2 backups", !!env.BACKUPS],
    ["AI Gateway", !!env.AI_GATEWAY_ID],
    ["web search key", !!(env.FIRECRAWL_API_KEY || env.BRAVE_API_KEY)],
    ["GitHub token", !!env.GITHUB_TOKEN],
    ["owner lock", !!env.OWNER_USER_IDS],
  ] as const;
  const bots = AGENT_IDS.map((a) => `${AGENTS[a].emoji}${botToken(env, a) ? "✅" : "❌"}`).join(" ");

  const lines = checks.map((c) => `${c.ok ? "✅" : "❌"} ${c.name} (${c.ms} ms): ${c.note}`);
  const failed = checks.filter((c) => !c.ok).length;
  return [
    `🩺 Self-test: ${checks.length - failed}/${checks.length} checks passed`,
    "",
    ...lines,
    "",
    `Bindings: ${bindings.map(([n, ok]) => `${n} ${ok ? "✅" : "❌"}`).join(" · ")}`,
    `Bot tokens: ${bots}`,
  ].join("\n");
}
