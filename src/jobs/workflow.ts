import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { postAs } from "../council/post";
import { MemoryStore } from "../memory/store";
import type { Env } from "../types";
import { runDesignLoop } from "./design";
import { formatEval, runEvalSuite } from "./evals";
import { runMission } from "./mission";
import { runReflection } from "./reflect";
import { runResearch } from "./research";
import { runScout } from "./scout";
import type { JobParams } from "./types";

/**
 * One durable Workflow class for all long-running work. Every step is checkpointed, so a
 * mission or research job survives restarts and can sleep for hours or wait for the founder.
 */
export class CouncilJob extends WorkflowEntrypoint<Env, JobParams> {
  async run(event: WorkflowEvent<JobParams>, step: WorkflowStep): Promise<unknown> {
    const p = event.payload;
    const store = new MemoryStore(this.env.DB, this.env.AI, this.env.VECTORIZE);
    const loopback = this.ctx.exports;

    if (p.kind === "mission") return runMission(this.env, step, p.missionId, p.identity, loopback);

    let result = "";
    try {
      switch (p.kind) {
        case "research":
          result = await runResearch(this.env, step, p.jobId, p.identity, p.topic);
          break;
        case "design":
          result = await runDesignLoop(this.env, step, p);
          break;
        case "reflect":
          result = await runReflection(this.env, step, p.jobId, p.identity);
          break;
        case "scout":
          result = await runScout(this.env, step, p.jobId, p.identity);
          break;
        case "eval": {
          const lines: string[] = [];
          for (const agent of p.agents) {
            lines.push(await step.do(`eval-${agent}`, { timeout: "20 minutes" }, async () => formatEval(await runEvalSuite(this.env, store, agent, { model: p.model }))));
          }
          result = lines.join("\n");
          if (p.identity) {
            const identity = p.identity;
            await step.do("report", () => postAs(this.env, store, identity, "nexus", `🧪 **Eval results**\n\n${result}`).then(() => "ok"));
          }
          break;
        }
      }
      await step.do("record", () => store.ops.finishJob(p.jobId, "done", result).then(() => "ok"));
    } catch (err) {
      await step.do("record-failure", () => store.ops.finishJob(p.jobId, "failed", String(err)).then(() => "ok"));
      throw err;
    }
    return result;
  }
}

