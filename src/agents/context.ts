import { LIMITS } from "../config";
import type { MemoryStore } from "../memory/store";
import { parseIds } from "../telegram/api";
import type { AgentId, Env, TranscriptMessage } from "../types";

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/**
 * Extra context that makes each agent good at its own job: Nova sees its idea bank,
 * Sage its claim ledger, Nexus the open action items, engineers the repos they may touch,
 * and everyone gets semantically retrieved older memory.
 */
export async function agentContext(
  agent: AgentId,
  env: Env,
  store: MemoryStore,
  convId: number,
  sharedConvIds: number[],
  transcript: TranscriptMessage[],
): Promise<string> {
  const lastHuman = [...transcript].reverse().find((m) => m.speaker === "human")?.text ?? "";
  const parts: string[] = [];

  const inWindow = new Set(transcript.map((m) => `msg:${m.id}`));
  const [retrieved, predictions] = await Promise.all([
    store.hasVectors ? store.semanticSearch(convId, lastHuman, LIMITS.retrievedMemories, agent) : Promise.resolve([]),
    store.openPredictions(agent, 3),
  ]);
  const older = retrieved.filter((r) => !inWindow.has(r.id));
  if (older.length) parts.push(`Relevant older memory:\n${older.map((r) => `- [${r.kind}] ${r.text}`).join("\n")}`);
  if (predictions.length) {
    parts.push(`Your open predictions:\n${predictions.map((p) => `- #${p.id} "${p.claim}" (check ${day(p.check_at)})`).join("\n")}`);
  }

  switch (agent) {
    case "nova": {
      const ideas = await store.searchIdeas(lastHuman, 5);
      if (ideas.length) parts.push(`From your idea bank:\n${ideas.map((i) => `- #${i.id} ${i.idea}`).join("\n")}`);
      break;
    }
    case "sage": {
      const claims = await store.recentClaims(convId, 6);
      if (claims.length) {
        const mark = (v: string) => (v === "true" ? "✅" : v === "false" ? "❌" : "❓");
        parts.push(`Recent claim ledger:\n${claims.map((c) => `- ${mark(c.verdict)} "${c.claim}" (${c.claimed_by})`).join("\n")}`);
      }
      break;
    }
    case "nexus": {
      const [actions, followups] = await Promise.all([store.openActions(sharedConvIds, 10), store.pendingFollowups(convId)]);
      if (actions.length) {
        parts.push(`Open action items:\n${actions.map((a) => `- #${a.id} ${a.text} (owner: ${a.owner}${a.due_at ? `, due ${day(a.due_at)}` : ""})`).join("\n")}`);
      }
      if (followups.length) parts.push(`Scheduled follow-ups:\n${followups.map((f) => `- ${day(f.due_at)} ${f.agent}: ${f.note}`).join("\n")}`);
      break;
    }
    case "cipher":
    case "forge": {
      const repos = parseIds(env.GITHUB_REPOS);
      parts.push(
        `Engineering environment: repos you may touch: ${repos.join(", ") || "none configured"}. ` +
          `GitHub ${env.GITHUB_TOKEN ? "connected" : "not connected"}; sandbox ${env.Sandbox ? "available" : "not available"}; browser ${env.BROWSER ? "available" : "not available"}.`,
      );
      break;
    }
  }
  return parts.join("\n\n");
}
