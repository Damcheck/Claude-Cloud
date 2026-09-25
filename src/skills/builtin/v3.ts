import { clearOverrideCache } from "../../agents/overrides";
import { AGENTS, isAgentId } from "../../agents/registry";
import { base64ToBytes } from "../../ai/workers-ai";
import { parseMissionFlags, startMission } from "../../jobs/start";
import { customSkillsFor, validateTool } from "../../tools/custom";
import type { AgentId } from "../../types";
import type { Skill } from "../types";
import { num, str } from "../types";
import { allowedRepo } from "./github";
import { parseHttpUrl } from "./web";

const DAY = 86400_000;

// ---------------------------------------------------------------------------
// Decision records
// ---------------------------------------------------------------------------

export const decisionRecord: Skill = {
  id: "decision.record",
  description:
    "Record a decision the founder made as a decision record: the options considered, what was chosen, who disagreed and why, the rationale, and when to check whether it worked.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      context: { type: "string" },
      options: { type: "array", items: { type: "string" } },
      chosen: { type: "string" },
      dissent: { type: "string", description: "Who disagreed and their strongest argument" },
      rationale: { type: "string" },
      review_in_days: { type: "number" },
    },
    required: ["title", "chosen"],
  },
  risk: "write",
  async run(args, ctx) {
    const days = num(args.review_in_days, 30);
    const reviewAt = Date.now() + Math.min(365, Math.max(1, days)) * DAY;
    const id = await ctx.store.ops.addDecision({
      convId: ctx.convId,
      title: str(args.title).slice(0, 200),
      context: str(args.context).slice(0, 1500),
      options: (Array.isArray(args.options) ? args.options : []).map((o) => str(o).slice(0, 200)).slice(0, 8),
      chosen: str(args.chosen).slice(0, 300),
      dissent: str(args.dissent).slice(0, 800),
      rationale: str(args.rationale).slice(0, 1500),
      reviewAt,
      by: ctx.agent,
    });
    await ctx.store.addFollowup({ convId: ctx.convId, agent: "nexus", kind: "decision_review", note: `Review decision #${id}: ${str(args.title)} (chose: ${str(args.chosen)})`, refId: id, dueAt: reviewAt });
    await ctx.hooks?.scheduleNext();
    return `Decision #${id} recorded; review on ${new Date(reviewAt).toISOString().slice(0, 10)}.`;
  },
};

export const decisionReview: Skill = {
  id: "decision.review",
  description: "Record how a past decision turned out: worked, failed, or revised, with what happened.",
  parameters: {
    type: "object",
    properties: { id: { type: "number" }, status: { type: "string", enum: ["worked", "failed", "revised"] }, outcome: { type: "string" } },
    required: ["id", "status", "outcome"],
  },
  risk: "write",
  async run(args, ctx) {
    const status = str(args.status);
    if (!["worked", "failed", "revised"].includes(status)) return "Status must be worked, failed or revised.";
    const ok = await ctx.store.ops.reviewDecision(num(args.id, -1), ctx.sharedConvIds, status as "worked" | "failed" | "revised", str(args.outcome).slice(0, 1000));
    return ok ? "Decision updated." : "No such decision.";
  },
};

// ---------------------------------------------------------------------------
// Knowledge graph
// ---------------------------------------------------------------------------

export const graphQuery: Skill = {
  id: "graph.query",
  description: "Look up what the council knows about a project, person, company or product: current facts and relationships from the knowledge graph.",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  risk: "read",
  async run(args, ctx) {
    const e = await ctx.store.ops.entityByName(ctx.sharedConvIds, str(args.name).trim());
    if (!e) return "Nothing known about that yet.";
    const d = await ctx.store.ops.entityDetails(e.id);
    return [
      `${e.name} (${e.type})${e.summary ? `: ${e.summary}` : ""}`,
      d.facts.length ? `Facts:\n${d.facts.map((f) => `- ${f.attribute}: ${f.value}`).join("\n")}` : "",
      d.relations.length ? `Relations:\n${d.relations.map((r) => `- ${r}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
};

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

export const watchAdd: Skill = {
  id: "watch.add",
  description:
    "Start watching something and get woken up when it changes: a web page (kind=url), an RSS/Atom feed (kind=rss) or a GitHub repo's CI (kind=github, target owner/repo). Use for competitors, docs, prices, releases and builds.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["url", "rss", "github"] },
      target: { type: "string" },
      every_hours: { type: "number", description: "How often to check (0.25 – 168, default 24)" },
    },
    required: ["kind", "target"],
  },
  risk: "write",
  async run(args, ctx) {
    const kind = str(args.kind) as "url" | "rss" | "github";
    const target = str(args.target).trim();
    if (kind === "github") {
      if (!allowedRepo(ctx.env, target)) return "Repo not in GITHUB_REPOS.";
    } else if (kind === "url" || kind === "rss") {
      if (!parseHttpUrl(target)) return "Target must be an http(s) URL.";
    } else return "Kind must be url, rss or github.";
    const minutes = Math.round(Math.min(168, Math.max(0.25, num(args.every_hours, 24))) * 60);
    const id = await ctx.store.ops.addWatcher({ convId: ctx.convId, chatId: ctx.chatId, agent: ctx.agent, kind, target, everyMinutes: minutes, createdBy: ctx.agent });
    return `Watcher #${id} set: checking ${target} every ${minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`}.`;
  },
};

// ---------------------------------------------------------------------------
// Tools the council builds for itself
// ---------------------------------------------------------------------------

export const toolsCreate: Skill = {
  id: "tools.create",
  description:
    "Write a new tool for the council: an ES module `export default async function (args) { ... return result }` that may fetch only the https domains you list. Forge reviews it, the founder approves it, then the listed agents can call it as custom.<name>. Test the logic in the sandbox first.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "lowercase_with_underscores" },
      description: { type: "string", description: "When to use it and what it returns" },
      parameters: { type: "object", description: "JSON schema of the args" },
      code: { type: "string" },
      allowed_domains: { type: "array", items: { type: "string" }, description: "e.g. api.example.com or *.example.com" },
      agents: { type: "array", items: { type: "string" }, description: "Members who may use it" },
    },
    required: ["name", "description", "code"],
  },
  risk: "write",
  async run(args, ctx) {
    const t = {
      name: str(args.name).trim(),
      code: str(args.code),
      allowed_domains: (Array.isArray(args.allowed_domains) ? args.allowed_domains : []).map((d) => str(d).trim()).filter(Boolean),
    };
    const invalid = validateTool(t);
    if (invalid) return `Not saved: ${invalid}`;
    const agents = (Array.isArray(args.agents) ? args.agents : [ctx.agent]).map((a) => str(a).toLowerCase()).filter(isAgentId) as AgentId[];
    const id = await ctx.store.ops.createTool({
      name: t.name,
      description: str(args.description).slice(0, 800),
      parameters: args.parameters && typeof args.parameters === "object" ? args.parameters : { type: "object", properties: {} },
      code: t.code,
      allowedDomains: t.allowed_domains,
      agents: agents.length ? agents : [ctx.agent],
      createdBy: ctx.agent,
    });
    await ctx.store.addFollowup({ convId: ctx.convId, agent: "forge", kind: "tool_review", note: `Review tool #${id} "${t.name}" written by ${AGENTS[ctx.agent].name}.`, refId: id, dueAt: Date.now() });
    await ctx.hooks?.scheduleNext();
    return `Tool #${id} "${t.name}" saved for review. Forge will review it next, then the founder approves it.`;
  },
};

export const toolsReview: Skill = {
  id: "tools.review",
  description: "Review a council-built tool: read its code, then approve it (it goes to the founder for final approval) or reject it with notes.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "number" },
      action: { type: "string", enum: ["read", "approve", "reject"] },
      notes: { type: "string" },
    },
    required: ["id", "action"],
  },
  risk: "write",
  async run(args, ctx) {
    const tool = await ctx.store.ops.getTool(num(args.id, -1));
    if (!tool) return "No such tool.";
    const action = str(args.action);
    if (action === "read") {
      return `Tool #${tool.id} ${tool.name} v${tool.version} by ${tool.created_by} [${tool.status}]\nDomains: ${tool.allowed_domains}\nAgents: ${tool.agents}\nParameters: ${tool.parameters_json}\n\n${tool.code}`;
    }
    if (action === "reject") {
      await ctx.store.ops.setToolStatus(tool.id, "rejected", str(args.notes).slice(0, 1500));
      return "Rejected; the author can fix it and call tools.create again with the same name.";
    }
    if (action !== "approve") return "Action must be read, approve or reject.";
    if (tool.status !== "review") return `Tool is ${tool.status}, not awaiting review.`;
    await ctx.store.ops.setToolStatus(tool.id, "pending_approval", str(args.notes).slice(0, 1500));
    if (!ctx.hooks) return "Reviewed, but approval buttons can't be posted from here.";
    const summary = `activate council-built tool "${tool.name}" v${tool.version} (network: ${JSON.parse(tool.allowed_domains).join(", ") || "none"}; for ${JSON.parse(tool.agents).join(", ")})`;
    const approvalId = await ctx.store.createApproval({ convId: ctx.convId, chatId: ctx.chatId, agent: ctx.agent, skill: "tools.activate", args: { id: tool.id }, summary });
    await ctx.hooks.requestApproval(approvalId, ctx.agent, summary);
    return `Review passed; approval request #${approvalId} sent to the founder.`;
  },
};

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export const imageGenerate: Skill = {
  id: "image.generate",
  description: "Generate an image (mockup, concept, illustration) from a detailed prompt and post it to the chat.",
  parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
  risk: "write",
  async run(args, ctx) {
    const prompt = str(args.prompt).trim().slice(0, 2000);
    if (!prompt) return "Empty prompt.";
    const out = (await (ctx.env.AI.run as unknown as (m: string, i: unknown) => Promise<{ image?: string }>)(IMAGE_MODEL, { prompt, steps: 6 })) ?? {};
    if (!out.image) return "Image generation returned nothing.";
    await ctx.hooks?.sendPhoto(ctx.agent, base64ToBytes(out.image), prompt.slice(0, 200));
    return "Image generated and posted.";
  },
};

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

export const missionPropose: Skill = {
  id: "mission.propose",
  description:
    "Propose a mission: a goal the council works on by itself for hours or days, with a token budget. Needs the founder's approval. Use for multi-step work that can't be done in one reply.",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "The goal, with how success will be judged" },
      token_budget: { type: "number" },
      days: { type: "number" },
    },
    required: ["goal"],
  },
  risk: "write",
  requiresApproval: true,
  describeCall: (args) => `start a mission: “${str(args.goal).slice(0, 300)}” (budget ${num(args.token_budget, 300_000).toLocaleString()} tokens, ${num(args.days, 3)} days)`,
  available: (env) => !!env.JOBS,
  async run(args, ctx) {
    const { goal } = parseMissionFlags(str(args.goal));
    const id = await startMission(ctx.env, ctx.store, { convId: ctx.convId, chatId: ctx.chatId }, goal, {
      budget: Math.min(5_000_000, Math.max(10_000, num(args.token_budget, 300_000))),
      days: Math.min(30, Math.max(0.05, num(args.days, 3))),
      proposedBy: ctx.agent,
    });
    return `Mission #${id} started.`;
  },
};

// ---------------------------------------------------------------------------
// System skills: only run through approval buttons created by jobs.
// ---------------------------------------------------------------------------

export const toolsActivate: Skill = {
  id: "tools.activate",
  description: "Activate a reviewed council-built tool.",
  parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  risk: "write",
  requiresApproval: true,
  async run(args, ctx) {
    const tool = await ctx.store.ops.getTool(num(args.id, -1));
    if (!tool) return "No such tool.";
    await ctx.store.ops.setToolStatus(tool.id, "active");
    const count = (await customSkillsFor(ctx.agent, ctx.env, ctx.store)).length;
    return `Tool "${tool.name}" v${tool.version} is active as custom.${tool.name} (${count} custom tool(s) available to ${AGENTS[ctx.agent].name}).`;
  },
};

export const personaUpdate: Skill = {
  id: "persona.update",
  description: "Activate a proposed personality for an agent.",
  parameters: { type: "object", properties: { persona_id: { type: "number" } }, required: ["persona_id"] },
  risk: "write",
  requiresApproval: true,
  async run(args, ctx) {
    const p = await ctx.store.ops.getPersona(num(args.persona_id, -1));
    if (!p || p.status !== "proposed") return "No pending persona with that id.";
    await ctx.store.ops.setOverride(p.agent, "personality", p.personality);
    await ctx.store.ops.setPersonaStatus(p.id, "active");
    clearOverrideCache();
    return `${AGENTS[p.agent].name}'s new personality is active.`;
  },
};

export const modelSwap: Skill = {
  id: "model.swap",
  description: "Switch an agent to a different model.",
  parameters: { type: "object", properties: { agent: { type: "string" }, model: { type: "string" } }, required: ["agent", "model"] },
  risk: "write",
  requiresApproval: true,
  async run(args, ctx) {
    const agent = str(args.agent);
    const model = str(args.model);
    if (!isAgentId(agent) || !/^@cf\/[\w.-]+\/[\w.-]+$/.test(model)) return "Invalid agent or model.";
    await ctx.store.ops.setOverride(agent, "model", model);
    clearOverrideCache();
    return `${AGENTS[agent].name} now runs on ${model}.`;
  },
};

export const SYSTEM_SKILLS: Skill[] = [toolsActivate, personaUpdate, modelSwap];
