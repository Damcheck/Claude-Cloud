import type { Skill } from "../types";
import { str } from "../types";

export const memorySearch: Skill = {
  id: "memory.search",
  description:
    "Search older group conversation, past discussion summaries and your own private memories. Use when the founder refers to something discussed before, or when past decisions matter.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "What to look for, in natural language" } },
    required: ["query"],
  },
  risk: "read",
  async run(args, ctx) {
    const results = await ctx.store.search(ctx.convId, ctx.agent, str(args.query));
    return results.length ? results.join("\n") : "No matching memories.";
  },
};

export const memoryRemember: Skill = {
  id: "memory.remember",
  description:
    "Save a private note only you will see in future conversations: your own position, a warning you gave, or something you learnt about the founder. Keep it to one sentence.",
  parameters: {
    type: "object",
    properties: { note: { type: "string" } },
    required: ["note"],
  },
  risk: "write",
  async run(args, ctx) {
    const note = str(args.note).trim().slice(0, 500);
    if (!note) return "Nothing saved: empty note.";
    await ctx.store.addAgentMemory(ctx.convId, ctx.agent, note);
    return "Saved.";
  },
};

export const groupRecordFact: Skill = {
  id: "group.record_fact",
  description:
    "Record a fact the whole council should remember: a decision the founder made, the current project, a constraint. Only record things the founder actually stated or agreed to.",
  parameters: {
    type: "object",
    properties: { fact: { type: "string" } },
    required: ["fact"],
  },
  risk: "write",
  async run(args, ctx) {
    const fact = str(args.fact).trim().slice(0, 500);
    if (!fact) return "Nothing recorded: empty fact.";
    await ctx.store.addGroupFact(ctx.convId, fact, ctx.agent);
    return "Recorded in group memory.";
  },
};
