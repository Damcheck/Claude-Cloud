import { AGENTS } from "../../agents/registry";
import type { Skill } from "../types";
import { num, str } from "../types";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const scheduleFollowup: Skill = {
  id: "schedule.followup",
  description:
    "Set a reminder for yourself: after the given delay you'll get a turn in this chat to follow up (check on a decision, re-verify a claim, ask how something went). Use it instead of promising to 'check later'.",
  parameters: {
    type: "object",
    properties: {
      in_hours: { type: "number", description: "Delay in hours (0.1 – 720)" },
      note: { type: "string", description: "What you want to do when it fires" },
    },
    required: ["in_hours", "note"],
  },
  risk: "write",
  async run(args, ctx) {
    const hours = Math.min(720, Math.max(0.1, num(args.in_hours, 24)));
    const note = str(args.note).trim().slice(0, 500);
    if (!note) return "A follow-up needs a note.";
    const dueAt = Date.now() + hours * HOUR;
    const id = await ctx.store.addFollowup({ convId: ctx.convId, agent: ctx.agent, note, dueAt });
    await ctx.hooks?.scheduleNext();
    return `Follow-up #${id} scheduled for ${new Date(dueAt).toISOString().slice(0, 16).replace("T", " ")} UTC.`;
  },
};

export const predictionRecord: Skill = {
  id: "prediction.record",
  description:
    "Commit to a forecast so your track record can be checked: a concrete, checkable claim, your confidence (0-1), and when it can be checked. You'll be reminded to review it then.",
  parameters: {
    type: "object",
    properties: {
      claim: { type: "string" },
      confidence: { type: "number" },
      check_in_days: { type: "number" },
    },
    required: ["claim", "confidence", "check_in_days"],
  },
  risk: "write",
  async run(args, ctx) {
    const claim = str(args.claim).trim().slice(0, 500);
    if (!claim) return "Empty prediction.";
    const confidence = Math.min(1, Math.max(0, num(args.confidence, 0.5)));
    const checkAt = Date.now() + Math.min(365, Math.max(0.5, num(args.check_in_days, 14))) * DAY;
    const id = await ctx.store.addPrediction({ convId: ctx.convId, agent: ctx.agent, claim, confidence, checkAt });
    await ctx.store.addFollowup({
      convId: ctx.convId,
      agent: ctx.agent,
      kind: "prediction_review",
      note: `Review your prediction #${id}: "${claim}" (you said ${Math.round(confidence * 100)}%).`,
      refId: id,
      dueAt: checkAt,
    });
    await ctx.hooks?.scheduleNext();
    return `Prediction #${id} recorded; you'll review it on ${new Date(checkAt).toISOString().slice(0, 10)}.`;
  },
};

export const predictionResolve: Skill = {
  id: "prediction.resolve",
  description: "Mark one of your own predictions as right, wrong or unclear, with a one-line note on what happened.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "number" },
      outcome: { type: "string", enum: ["right", "wrong", "unclear"] },
      note: { type: "string" },
    },
    required: ["id", "outcome"],
  },
  risk: "write",
  async run(args, ctx) {
    const outcome = str(args.outcome);
    if (!["right", "wrong", "unclear"].includes(outcome)) return "Outcome must be right, wrong or unclear.";
    const ok = await ctx.store.resolvePrediction(num(args.id, -1), ctx.agent, outcome as "right" | "wrong" | "unclear", str(args.note).slice(0, 500));
    if (!ok) return "No such prediction of yours.";
    const rec = await ctx.store.trackRecord(ctx.agent);
    return `Resolved. Your record: ${rec.right} right, ${rec.wrong} wrong, ${rec.unclear} unclear, ${rec.open} open.`;
  },
};

export const claimsRecord: Skill = {
  id: "claims.record",
  description:
    "Add a checked factual claim to the claim ledger: who claimed it, your verdict (true / false / unclear) and the source you checked.",
  parameters: {
    type: "object",
    properties: {
      claim: { type: "string" },
      claimed_by: { type: "string", description: "Member name or 'founder'" },
      verdict: { type: "string", enum: ["true", "false", "unclear"] },
      source: { type: "string", description: "URL or reference" },
      note: { type: "string" },
    },
    required: ["claim", "claimed_by", "verdict"],
  },
  risk: "write",
  async run(args, ctx) {
    const verdict = str(args.verdict);
    if (!["true", "false", "unclear"].includes(verdict)) return "Verdict must be true, false or unclear.";
    const id = await ctx.store.addClaim({
      convId: ctx.convId,
      checkedBy: ctx.agent,
      claim: str(args.claim).slice(0, 500),
      claimedBy: str(args.claimed_by, "unknown").slice(0, 60),
      verdict,
      source: str(args.source).slice(0, 500) || undefined,
      note: str(args.note).slice(0, 500) || undefined,
    });
    return `Claim #${id} recorded as ${verdict}.`;
  },
};

export const ideasSave: Skill = {
  id: "ideas.save",
  description: "Save an idea to the idea bank so it can be brought back later when it becomes relevant.",
  parameters: {
    type: "object",
    properties: { idea: { type: "string" }, tags: { type: "string", description: "Comma-separated tags" } },
    required: ["idea"],
  },
  risk: "write",
  async run(args, ctx) {
    const idea = str(args.idea).trim().slice(0, 800);
    if (!idea) return "Empty idea.";
    const id = await ctx.store.addIdea(ctx.convId, ctx.agent, idea, str(args.tags).slice(0, 200));
    return `Idea #${id} saved.`;
  },
};

export const ideasSearch: Skill = {
  id: "ideas.search",
  description: "Search the idea bank for earlier ideas related to the current topic.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  risk: "read",
  async run(args, ctx) {
    const ideas = await ctx.store.searchIdeas(str(args.query));
    return ideas.length ? ideas.map((i) => `#${i.id} ${i.idea}${i.tags ? ` [${i.tags}]` : ""}`).join("\n") : "No matching ideas.";
  },
};

export const actionsAdd: Skill = {
  id: "actions.add",
  description:
    "Create an action item from a decision: what must happen, who owns it (founder or a member), and optionally a due date. Nexus follows up when it's due.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string" },
      owner: { type: "string" },
      due_in_days: { type: "number" },
    },
    required: ["text"],
  },
  risk: "write",
  async run(args, ctx) {
    const text = str(args.text).trim().slice(0, 500);
    if (!text) return "Empty action item.";
    const days = num(args.due_in_days, NaN);
    const dueAt = Number.isFinite(days) ? Date.now() + Math.max(0.1, days) * DAY : null;
    const id = await ctx.store.addAction({ convId: ctx.convId, text, owner: str(args.owner, "founder").slice(0, 60) || "founder", dueAt, createdBy: ctx.agent });
    if (dueAt) {
      await ctx.store.addFollowup({ convId: ctx.convId, agent: "nexus", kind: "action_check", note: `Check action item #${id}: ${text}`, refId: id, dueAt });
      await ctx.hooks?.scheduleNext();
    }
    return `Action item #${id} created${dueAt ? `, due ${new Date(dueAt).toISOString().slice(0, 10)}` : ""}.`;
  },
};

export const actionsComplete: Skill = {
  id: "actions.complete",
  description: "Mark an action item as done once the founder confirms it happened.",
  parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  risk: "write",
  async run(args, ctx) {
    const ok = await ctx.store.completeAction(num(args.id, -1), ctx.sharedConvIds);
    return ok ? "Marked done." : "No open action item with that number.";
  },
};

export function followupInstruction(kind: string, note: string): string {
  switch (kind) {
    case "prediction_review":
      return `Time to review a prediction you made. ${note} Decide whether it came true (search if needed), call prediction.resolve, and tell the founder briefly what happened and what you learnt.`;
    case "action_check":
      return `An action item is due. ${note} Ask the founder whether it happened; if they already said so in the conversation, call actions.complete.`;
    case "pr_review":
      return `${note} Read the PR and its diff with github.read (action pr, then pr_diff), review it for correctness and architecture, post your review with github.comment, then summarise it here in a few lines.`;
    default:
      return `You scheduled this follow-up for yourself: "${note}". Do it now: check on it, ask the founder, or report what you found.`;
  }
}

export function agentLabel(id: string): string {
  const a = (AGENTS as Record<string, { emoji: string; name: string }>)[id];
  return a ? `${a.emoji} ${a.name}` : id;
}
