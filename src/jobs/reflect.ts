import type { WorkflowStep } from "cloudflare:workers";
import { formatTrackRecord } from "../agents/prompts";
import { effectiveAgent } from "../agents/overrides";
import { AGENTS, AGENT_IDS } from "../agents/registry";
import { askJson } from "../ai/json";
import { postAs, remoteHooks } from "../council/post";
import { MemoryStore } from "../memory/store";
import type { Env, Identity } from "../types";
import { callOptions } from "./common";
import { runEvalSuite } from "./evals";

const WEEK = 7 * 86400_000;

interface Reflection {
  lessons?: string[];
  persona_change?: { personality?: string; reason?: string } | null;
}

/**
 * Weekly self-improvement. Each agent reads the founder's reactions to its messages and its
 * prediction record, writes itself lessons, and may propose a new personality. A proposal
 * is only sent to the founder if it scores at least as well on the eval suite.
 */
export async function runReflection(env: Env, step: WorkflowStep, jobId: number, identity: Identity): Promise<string> {
  const store = new MemoryStore(env.DB, env.AI, env.VECTORIZE);
  const tag = `job:${jobId}`;
  const agents = AGENT_IDS.filter((a) => AGENTS[a].kind === "chat");
  const report: string[] = [];

  for (const agent of agents) {
    const proposal = await step.do(`reflect-${agent}`, { timeout: "5 minutes" }, async () => {
      const a = await effectiveAgent(store, agent);
      const [feedback, record, lessons] = await Promise.all([
        store.ops.feedbackSince(agent, Date.now() - WEEK),
        store.trackRecord(agent),
        store.ops.lessons(agent),
      ]);
      if (!feedback.length && record.right + record.wrong === 0) {
        report.push(`${a.emoji} ${a.name}: no feedback this week`);
        return null;
      }
      const fb = feedback.map((f) => `${f.score > 0 ? "👍" : f.score < 0 ? "👎" : f.reaction} on: "${f.text.slice(0, 300)}"`).join("\n");
      const r = await askJson<Reflection>(
        env.AI,
        a.model,
        [
          {
            role: "user",
            content: `You are ${a.name}, reviewing your own week in the AI council.
Your current personality: ${a.personality}
Your current lessons: ${lessons.join(" | ") || "none"}
The founder's reactions to your messages:
${fb || "none"}
Your prediction record: ${formatTrackRecord(record)}

Write up to 4 short, concrete lessons for yourself (what to do more / less). Only propose a personality change if the feedback shows a clear, repeated problem the lessons can't fix; keep your role.
Reply with only JSON: {"lessons": ["..."], "persona_change": null | {"personality": "the full new personality paragraph", "reason": "why"}}`,
          },
        ],
        { maxTokens: 900, ...callOptions(env, identity.convId) },
      );
      await store.recordUsage(identity.convId, agent, a.model, r.promptTokens, r.completionTokens, tag);
      const newLessons = (r.value?.lessons ?? []).map(String).filter(Boolean).slice(0, 4);
      if (newLessons.length) await store.ops.addLessons(agent, newLessons);
      report.push(`${a.emoji} ${a.name}: ${newLessons.length} lesson(s)${newLessons.length ? ` — ${newLessons[0]}` : ""}`);
      const pc = r.value?.persona_change;
      return pc?.personality && pc.personality.length > 80 ? { personality: pc.personality.slice(0, 2000), reason: String(pc.reason ?? "").slice(0, 500) } : null;
    });

    if (proposal) {
      await step.do(`persona-${agent}`, { timeout: "20 minutes" }, async () => {
        const a = await effectiveAgent(store, agent);
        const baseline = (await store.ops.latestEval(agent, a.model))?.score ?? (await runEvalSuite(env, store, agent)).score;
        const candidate = await runEvalSuite(env, store, agent, { personality: proposal.personality });
        if (candidate.score < baseline - 0.02) {
          report.push(`   ↳ proposed a new personality, but it scored worse (${pct(candidate.score)} vs ${pct(baseline)}), so it was dropped`);
          return "dropped";
        }
        const personaId = await store.ops.proposePersona(agent, proposal.personality, proposal.reason, { baseline, candidate: candidate.score });
        const summary = `adopt a new personality (eval ${pct(candidate.score)} vs current ${pct(baseline)}). Reason: ${proposal.reason}\n\nNew: ${proposal.personality.slice(0, 600)}`;
        const approvalId = await store.createApproval({ convId: identity.convId, chatId: identity.chatId, agent, skill: "persona.update", args: { persona_id: personaId }, summary });
        await remoteHooks(env, store, identity).requestApproval(approvalId, agent, summary);
        report.push(`   ↳ proposed a new personality (${pct(candidate.score)} vs ${pct(baseline)}) — waiting for your ✅`);
        return "proposed";
      });
    }
  }

  await step.do("report", () => postAs(env, store, identity, "nexus", `🪞 **Weekly reflection**\n\n${report.join("\n")}`).then(() => "ok"));
  return report.join("\n");
}

function pct(n: number): string {
  return `${Math.round(n * 100)}/100`;
}

