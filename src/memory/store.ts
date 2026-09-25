import { embed } from "../ai/workers-ai";
import { SYSTEM_MODELS } from "../config";
import type { AgentId, Mode, TranscriptMessage } from "../types";

/**
 * All D1 / Vectorize access goes through here.
 * Note: the v1 tables call the conversation id `chat_id`; for groups it equals the
 * Telegram chat id, for DMs it is the per-agent DM conversation id.
 */

export interface Approval {
  id: number;
  conv_id: number;
  chat_id: number;
  agent: AgentId;
  skill: string;
  args_json: string;
  summary: string;
  status: "pending" | "approved" | "rejected" | "failed";
  result: string | null;
  telegram_message_id: number | null;
}

export interface Followup {
  id: number;
  conv_id: number;
  agent: AgentId;
  kind: "followup" | "prediction_review" | "action_check" | "pr_review";
  note: string;
  ref_id: number | null;
  due_at: number;
}

export interface ChatSettings {
  conv_id: number;
  chat_id: number;
  dm_agent: AgentId | null;
  brief_enabled: number;
  voice_replies: number;
}

export interface TrackRecord {
  right: number;
  wrong: number;
  unclear: number;
  open: number;
}

export function utcDay(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class MemoryStore {
  constructor(
    private db: D1Database,
    private ai?: Ai,
    private vectors?: VectorizeIndex,
  ) {}

  get hasVectors(): boolean {
    return !!(this.ai && this.vectors);
  }

  // -------------------------------------------------------------------------
  // Updates, chats
  // -------------------------------------------------------------------------

  /** Returns false if this Telegram update was already processed. */
  async markUpdateSeen(bot: string, updateId: number): Promise<boolean> {
    const res = await this.db
      .prepare("INSERT OR IGNORE INTO seen_updates (bot, update_id, created_at) VALUES (?, ?, ?)")
      .bind(bot, updateId, Date.now())
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async cleanupSeenUpdates(olderThan: number): Promise<void> {
    await this.db.prepare("DELETE FROM seen_updates WHERE created_at < ?").bind(olderThan).run();
  }

  async upsertChat(convId: number, chatId: number, dmAgent?: AgentId): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO chats (conv_id, chat_id, dm_agent, created_at) VALUES (?, ?, ?, ?)")
      .bind(convId, chatId, dmAgent ?? null, Date.now())
      .run();
  }

  async chatSettings(convId: number): Promise<ChatSettings | null> {
    return this.db.prepare("SELECT * FROM chats WHERE conv_id = ?").bind(convId).first<ChatSettings>();
  }

  async setChatFlag(convId: number, flag: "brief_enabled" | "voice_replies", on: boolean): Promise<void> {
    await this.db.prepare(`UPDATE chats SET ${flag} = ? WHERE conv_id = ?`).bind(on ? 1 : 0, convId).run();
  }

  async chatsWithBrief(): Promise<ChatSettings[]> {
    const { results } = await this.db.prepare("SELECT * FROM chats WHERE brief_enabled = 1").all<ChatSettings>();
    return results;
  }

  // -------------------------------------------------------------------------
  // Discussions and messages
  // -------------------------------------------------------------------------

  async createDiscussion(convId: number, mode: Mode, topic: string): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO discussions (chat_id, mode, topic, created_at) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(convId, mode, topic, Date.now())
      .first<{ id: number }>();
    return row!.id;
  }

  async endDiscussion(id: number, status: "done" | "stopped" | "interrupted", posts: number): Promise<void> {
    await this.db
      .prepare("UPDATE discussions SET status = ?, posts = ?, ended_at = ? WHERE id = ? AND status = 'running'")
      .bind(status, posts, Date.now(), id)
      .run();
  }

  async lastDiscussionId(convId: number): Promise<number | null> {
    const row = await this.db
      .prepare("SELECT id FROM discussions WHERE chat_id = ? AND mode != 'chat' ORDER BY id DESC LIMIT 1")
      .bind(convId)
      .first<{ id: number }>();
    return row?.id ?? null;
  }

  async addMessage(m: TranscriptMessage, telegramMessageId?: number): Promise<number> {
    const row = await this.db
      .prepare(
        "INSERT INTO messages (chat_id, discussion_id, speaker, speaker_name, text, telegram_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .bind(m.chatId, m.discussionId, m.speaker, m.speakerName, m.text, telegramMessageId ?? null, m.createdAt)
      .first<{ id: number }>();
    return row!.id;
  }

  /** Most recent `limit` messages, oldest first. */
  async recentMessages(convId: number, limit: number): Promise<TranscriptMessage[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, chat_id, discussion_id, speaker, speaker_name, text, created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?",
      )
      .bind(convId, limit)
      .all<Record<string, any>>();
    return results.reverse().map(rowToMessage);
  }

  async discussionMessages(discussionId: number): Promise<TranscriptMessage[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, chat_id, discussion_id, speaker, speaker_name, text, created_at FROM messages WHERE discussion_id = ? ORDER BY id",
      )
      .bind(discussionId)
      .all<Record<string, any>>();
    return results.map(rowToMessage);
  }

  // -------------------------------------------------------------------------
  // Group facts and private agent memory
  // -------------------------------------------------------------------------

  async groupFacts(convIds: number[], limit = 30): Promise<string[]> {
    if (!convIds.length) return [];
    const marks = convIds.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(`SELECT fact FROM group_facts WHERE chat_id IN (${marks}) ORDER BY id DESC LIMIT ?`)
      .bind(...convIds, limit)
      .all<{ fact: string }>();
    return results.reverse().map((r) => r.fact);
  }

  async addGroupFact(convId: number, fact: string, createdBy: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO group_facts (chat_id, fact, created_by, created_at) VALUES (?, ?, ?, ?)")
      .bind(convId, fact, createdBy, Date.now())
      .run();
  }

  /** An agent's private memory follows it everywhere (group and DMs): there is only one Atlas. */
  async agentMemories(agent: AgentId, limit = 20): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT memory FROM agent_memories WHERE agent = ? ORDER BY id DESC LIMIT ?")
      .bind(agent, limit)
      .all<{ memory: string }>();
    return results.reverse().map((r) => r.memory);
  }

  async addAgentMemory(convId: number, agent: AgentId, memory: string): Promise<void> {
    const row = await this.db
      .prepare("INSERT INTO agent_memories (chat_id, agent, memory, created_at) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(convId, agent, memory, Date.now())
      .first<{ id: number }>();
    await this.index(convId, `mem:${row!.id}`, memory, { kind: "memory", agent });
  }

  // -------------------------------------------------------------------------
  // Semantic memory (Vectorize; one namespace per conversation)
  // -------------------------------------------------------------------------

  async index(convId: number, id: string, text: string, meta: Record<string, string | number>): Promise<void> {
    if (!this.ai || !this.vectors || text.trim().length < 20) return;
    try {
      const [values] = await embed(this.ai, SYSTEM_MODELS.embeddings, [text.slice(0, 2000)]);
      if (!values) return;
      await this.vectors.upsert([
        { id, values, namespace: String(convId), metadata: { ...meta, text: text.slice(0, 1500), at: Date.now() } },
      ]);
    } catch (err) {
      console.warn("vector index failed", err);
    }
  }

  async semanticSearch(convId: number, query: string, topK: number, agent?: AgentId): Promise<{ id: string; text: string; kind: string }[]> {
    if (!this.ai || !this.vectors || !query.trim()) return [];
    try {
      const [values] = await embed(this.ai, SYSTEM_MODELS.embeddings, [query.slice(0, 2000)]);
      if (!values) return [];
      const res = await this.vectors.query(values, { topK: topK * 2, namespace: String(convId), returnMetadata: "all" });
      return res.matches
        .filter((m) => (m.score ?? 0) > 0.45)
        .map((m) => ({ id: m.id, text: String(m.metadata?.text ?? ""), kind: String(m.metadata?.kind ?? ""), agent: m.metadata?.agent }))
        // Another agent's private memory is not yours to read.
        .filter((m) => m.kind !== "memory" || m.agent === agent)
        .slice(0, topK);
    } catch (err) {
      console.warn("vector query failed", err);
      return [];
    }
  }

  /** Semantic search when Vectorize is bound, keyword search otherwise. */
  async search(convId: number, agent: AgentId, query: string, limit = 8): Promise<string[]> {
    if (this.hasVectors) {
      const hits = await this.semanticSearch(convId, query, limit, agent);
      if (hits.length) return hits.map((h) => `[${h.kind}] ${h.text}`);
    }
    const terms = query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2)
      .slice(0, 5);
    if (!terms.length) return [];
    const like = terms.map(() => "LOWER(text) LIKE ?").join(" OR ");
    const memLike = terms.map(() => "LOWER(memory) LIKE ?").join(" OR ");
    const params = terms.map((t) => `%${t}%`);
    const [msgs, mems] = await Promise.all([
      this.db
        .prepare(`SELECT speaker_name, text, created_at FROM messages WHERE chat_id = ? AND (${like}) ORDER BY id DESC LIMIT ?`)
        .bind(convId, ...params, limit)
        .all<{ speaker_name: string; text: string; created_at: number }>(),
      this.db
        .prepare(`SELECT memory FROM agent_memories WHERE agent = ? AND (${memLike}) ORDER BY id DESC LIMIT ?`)
        .bind(agent, ...params, limit)
        .all<{ memory: string }>(),
    ]);
    return [
      ...mems.results.map((m) => `[your memory] ${m.memory}`),
      ...msgs.results.map((m) => `[${utcDay(m.created_at)}] ${m.speaker_name}: ${m.text.slice(0, 400)}`),
    ];
  }

  // -------------------------------------------------------------------------
  // Discussion summaries and documents
  // -------------------------------------------------------------------------

  async saveSummary(convId: number, discussionId: number, summary: string): Promise<void> {
    await this.db
      .prepare("INSERT OR REPLACE INTO discussion_summaries (discussion_id, conv_id, summary, created_at) VALUES (?, ?, ?, ?)")
      .bind(discussionId, convId, summary, Date.now())
      .run();
    await this.index(convId, `sum:${discussionId}`, summary, { kind: "summary" });
  }

  async recentSummaries(convId: number, limit = 3): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT summary, created_at FROM discussion_summaries WHERE conv_id = ? ORDER BY created_at DESC LIMIT ?")
      .bind(convId, limit)
      .all<{ summary: string; created_at: number }>();
    return results.reverse().map((r) => `[${utcDay(r.created_at)}] ${r.summary}`);
  }

  async saveDocument(convId: number, name: string, markdown: string): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO documents (conv_id, name, markdown, created_at) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(convId, name, markdown, Date.now())
      .first<{ id: number }>();
    return row!.id;
  }

  async getDocument(id: number): Promise<{ id: number; conv_id: number; name: string; markdown: string } | null> {
    return this.db.prepare("SELECT id, conv_id, name, markdown FROM documents WHERE id = ?").bind(id).first();
  }

  // -------------------------------------------------------------------------
  // Usage and budgets
  // -------------------------------------------------------------------------

  async recordUsage(convId: number, agent: AgentId, model: string, prompt: number, completion: number): Promise<void> {
    if (!prompt && !completion) return;
    await this.db
      .prepare(
        "INSERT INTO usage (conv_id, agent, model, prompt_tokens, completion_tokens, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(convId, agent, model, prompt, completion, utcDay(), Date.now())
      .run();
  }

  async tokensToday(agent: AgentId): Promise<number> {
    const row = await this.db
      .prepare("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t FROM usage WHERE agent = ? AND day = ?")
      .bind(agent, utcDay())
      .first<{ t: number }>();
    return row?.t ?? 0;
  }

  async usageReport(days: number): Promise<{ agent: string; day: string; prompt: number; completion: number; calls: number }[]> {
    const since = utcDay(Date.now() - (days - 1) * 86400_000);
    const { results } = await this.db
      .prepare(
        "SELECT agent, day, SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion, COUNT(*) AS calls FROM usage WHERE day >= ? GROUP BY agent, day ORDER BY day DESC, agent",
      )
      .bind(since)
      .all<{ agent: string; day: string; prompt: number; completion: number; calls: number }>();
    return results;
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  async createApproval(a: { convId: number; chatId: number; agent: AgentId; skill: string; args: unknown; summary: string }): Promise<number> {
    const row = await this.db
      .prepare(
        "INSERT INTO approvals (conv_id, chat_id, agent, skill, args_json, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .bind(a.convId, a.chatId, a.agent, a.skill, JSON.stringify(a.args ?? {}), a.summary, Date.now())
      .first<{ id: number }>();
    return row!.id;
  }

  async setApprovalMessage(id: number, messageId: number): Promise<void> {
    await this.db.prepare("UPDATE approvals SET telegram_message_id = ? WHERE id = ?").bind(messageId, id).run();
  }

  async getApproval(id: number): Promise<Approval | null> {
    return this.db.prepare("SELECT * FROM approvals WHERE id = ?").bind(id).first<Approval>();
  }

  /** Atomically move a pending approval to `status`. Returns false if it was already decided. */
  async decideApproval(id: number, status: "approved" | "rejected"): Promise<boolean> {
    const res = await this.db
      .prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .bind(status, Date.now(), id)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async setApprovalResult(id: number, status: "approved" | "failed", result: string): Promise<void> {
    await this.db.prepare("UPDATE approvals SET status = ?, result = ? WHERE id = ?").bind(status, result, id).run();
  }

  // -------------------------------------------------------------------------
  // Follow-ups
  // -------------------------------------------------------------------------

  async addFollowup(f: { convId: number; agent: AgentId; kind?: Followup["kind"]; note: string; refId?: number; dueAt: number }): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO followups (conv_id, agent, kind, note, ref_id, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(f.convId, f.agent, f.kind ?? "followup", f.note, f.refId ?? null, f.dueAt, Date.now())
      .first<{ id: number }>();
    return row!.id;
  }

  async nextFollowupAt(convId: number): Promise<number | null> {
    const row = await this.db
      .prepare("SELECT MIN(due_at) AS due FROM followups WHERE conv_id = ? AND status = 'pending'")
      .bind(convId)
      .first<{ due: number | null }>();
    return row?.due ?? null;
  }

  async dueFollowups(convId: number, now: number, limit = 3): Promise<Followup[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM followups WHERE conv_id = ? AND status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT ?")
      .bind(convId, now, limit)
      .all<Followup>();
    return results;
  }

  async completeFollowup(id: number): Promise<void> {
    await this.db.prepare("UPDATE followups SET status = 'done' WHERE id = ?").bind(id).run();
  }

  async pendingFollowups(convId: number): Promise<Followup[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM followups WHERE conv_id = ? AND status = 'pending' ORDER BY due_at LIMIT 20")
      .bind(convId)
      .all<Followup>();
    return results;
  }

  // -------------------------------------------------------------------------
  // Predictions (track record)
  // -------------------------------------------------------------------------

  async addPrediction(p: { convId: number; agent: AgentId; claim: string; confidence: number; checkAt: number }): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO predictions (conv_id, agent, claim, confidence, check_at, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(p.convId, p.agent, p.claim, p.confidence, p.checkAt, Date.now())
      .first<{ id: number }>();
    return row!.id;
  }

  async getPrediction(id: number): Promise<{ id: number; agent: AgentId; claim: string; confidence: number; status: string; created_at: number } | null> {
    return this.db.prepare("SELECT id, agent, claim, confidence, status, created_at FROM predictions WHERE id = ?").bind(id).first();
  }

  async resolvePrediction(id: number, agent: AgentId, status: "right" | "wrong" | "unclear", note: string): Promise<boolean> {
    const res = await this.db
      .prepare("UPDATE predictions SET status = ?, outcome_note = ?, resolved_at = ? WHERE id = ? AND agent = ?")
      .bind(status, note, Date.now(), id, agent)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async trackRecord(agent: AgentId): Promise<TrackRecord> {
    const { results } = await this.db
      .prepare("SELECT status, COUNT(*) AS n FROM predictions WHERE agent = ? GROUP BY status")
      .bind(agent)
      .all<{ status: keyof TrackRecord; n: number }>();
    const rec: TrackRecord = { right: 0, wrong: 0, unclear: 0, open: 0 };
    for (const r of results) if (r.status in rec) rec[r.status] = r.n;
    return rec;
  }

  async openPredictions(agent: AgentId, limit = 5): Promise<{ id: number; claim: string; check_at: number }[]> {
    const { results } = await this.db
      .prepare("SELECT id, claim, check_at FROM predictions WHERE agent = ? AND status = 'open' ORDER BY check_at LIMIT ?")
      .bind(agent, limit)
      .all<{ id: number; claim: string; check_at: number }>();
    return results;
  }

  // -------------------------------------------------------------------------
  // Claims, ideas, action items
  // -------------------------------------------------------------------------

  async addClaim(c: { convId: number; checkedBy: AgentId; claim: string; claimedBy: string; verdict: string; source?: string; note?: string }): Promise<number> {
    const row = await this.db
      .prepare(
        "INSERT INTO claims (conv_id, checked_by, claim, claimed_by, verdict, source, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .bind(c.convId, c.checkedBy, c.claim, c.claimedBy, c.verdict, c.source ?? null, c.note ?? null, Date.now())
      .first<{ id: number }>();
    return row!.id;
  }

  async recentClaims(convId: number, limit = 10): Promise<{ id: number; claim: string; claimed_by: string; verdict: string; source: string | null }[]> {
    const { results } = await this.db
      .prepare("SELECT id, claim, claimed_by, verdict, source FROM claims WHERE conv_id = ? ORDER BY id DESC LIMIT ?")
      .bind(convId, limit)
      .all<{ id: number; claim: string; claimed_by: string; verdict: string; source: string | null }>();
    return results;
  }

  async addIdea(convId: number, agent: AgentId, idea: string, tags: string): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO ideas (conv_id, agent, idea, tags, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .bind(convId, agent, idea, tags, Date.now())
      .first<{ id: number }>();
    await this.index(convId, `idea:${row!.id}`, idea, { kind: "idea", agent });
    return row!.id;
  }

  async searchIdeas(query: string, limit = 5): Promise<{ id: number; idea: string; tags: string; created_at: number }[]> {
    const terms = query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2)
      .slice(0, 6);
    if (!terms.length) return this.recentIdeas(limit);
    const where = terms.map(() => "(LOWER(idea) LIKE ? OR LOWER(tags) LIKE ?)").join(" OR ");
    const params = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
    const { results } = await this.db
      .prepare(`SELECT id, idea, tags, created_at FROM ideas WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .bind(...params, limit)
      .all<{ id: number; idea: string; tags: string; created_at: number }>();
    return results;
  }

  async recentIdeas(limit = 10): Promise<{ id: number; idea: string; tags: string; created_at: number }[]> {
    const { results } = await this.db
      .prepare("SELECT id, idea, tags, created_at FROM ideas ORDER BY id DESC LIMIT ?")
      .bind(limit)
      .all<{ id: number; idea: string; tags: string; created_at: number }>();
    return results;
  }

  async addAction(a: { convId: number; text: string; owner: string; dueAt: number | null; createdBy: AgentId }): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO action_items (conv_id, text, owner, due_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(a.convId, a.text, a.owner, a.dueAt, a.createdBy, Date.now())
      .first<{ id: number }>();
    return row!.id;
  }

  async completeAction(id: number, convIds: number[]): Promise<boolean> {
    const marks = convIds.map(() => "?").join(",");
    const res = await this.db
      .prepare(`UPDATE action_items SET status = 'done', done_at = ? WHERE id = ? AND conv_id IN (${marks}) AND status = 'open'`)
      .bind(Date.now(), id, ...convIds)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async openActions(convIds: number[], limit = 20): Promise<{ id: number; text: string; owner: string; due_at: number | null }[]> {
    if (!convIds.length) return [];
    const marks = convIds.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(`SELECT id, text, owner, due_at FROM action_items WHERE conv_id IN (${marks}) AND status = 'open' ORDER BY COALESCE(due_at, 9e15), id LIMIT ?`)
      .bind(...convIds, limit)
      .all<{ id: number; text: string; owner: string; due_at: number | null }>();
    return results;
  }
}

function rowToMessage(r: Record<string, any>): TranscriptMessage {
  return {
    id: r.id,
    chatId: r.chat_id,
    discussionId: r.discussion_id,
    speaker: r.speaker,
    speakerName: r.speaker_name,
    text: r.text,
    createdAt: r.created_at,
  };
}
