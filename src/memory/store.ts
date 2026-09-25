import type { AgentId, Mode, TranscriptMessage } from "../types";

/** All D1 access goes through here. */
export class MemoryStore {
  constructor(private db: D1Database) {}

  async createDiscussion(chatId: number, mode: Mode, topic: string): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO discussions (chat_id, mode, topic, created_at) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(chatId, mode, topic, Date.now())
      .first<{ id: number }>();
    return row!.id;
  }

  async endDiscussion(id: number, status: "done" | "stopped" | "interrupted", posts: number): Promise<void> {
    await this.db
      .prepare("UPDATE discussions SET status = ?, posts = ?, ended_at = ? WHERE id = ? AND status = 'running'")
      .bind(status, posts, Date.now(), id)
      .run();
  }

  async addMessage(m: TranscriptMessage, telegramMessageId?: number): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO messages (chat_id, discussion_id, speaker, speaker_name, text, telegram_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(m.chatId, m.discussionId, m.speaker, m.speakerName, m.text, telegramMessageId ?? null, m.createdAt)
      .run();
  }

  /** Most recent `limit` messages, oldest first. */
  async recentMessages(chatId: number, limit: number): Promise<TranscriptMessage[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, chat_id, discussion_id, speaker, speaker_name, text, created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?",
      )
      .bind(chatId, limit)
      .all<Record<string, any>>();
    return results.reverse().map((r) => ({
      id: r.id,
      chatId: r.chat_id,
      discussionId: r.discussion_id,
      speaker: r.speaker,
      speakerName: r.speaker_name,
      text: r.text,
      createdAt: r.created_at,
    }));
  }

  async groupFacts(chatId: number, limit = 30): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT fact FROM group_facts WHERE chat_id = ? ORDER BY id DESC LIMIT ?")
      .bind(chatId, limit)
      .all<{ fact: string }>();
    return results.reverse().map((r) => r.fact);
  }

  async addGroupFact(chatId: number, fact: string, createdBy: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO group_facts (chat_id, fact, created_by, created_at) VALUES (?, ?, ?, ?)")
      .bind(chatId, fact, createdBy, Date.now())
      .run();
  }

  async agentMemories(chatId: number, agent: AgentId, limit = 20): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT memory FROM agent_memories WHERE chat_id = ? AND agent = ? ORDER BY id DESC LIMIT ?")
      .bind(chatId, agent, limit)
      .all<{ memory: string }>();
    return results.reverse().map((r) => r.memory);
  }

  async addAgentMemory(chatId: number, agent: AgentId, memory: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO agent_memories (chat_id, agent, memory, created_at) VALUES (?, ?, ?, ?)")
      .bind(chatId, agent, memory, Date.now())
      .run();
  }

  /** Keyword search over old messages and this agent's memories (Vectorize replaces this in phase 8). */
  async search(chatId: number, agent: AgentId, query: string, limit = 8): Promise<string[]> {
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
        .bind(chatId, ...params, limit)
        .all<{ speaker_name: string; text: string; created_at: number }>(),
      this.db
        .prepare(`SELECT memory FROM agent_memories WHERE chat_id = ? AND agent = ? AND (${memLike}) ORDER BY id DESC LIMIT ?`)
        .bind(chatId, agent, ...params, limit)
        .all<{ memory: string }>(),
    ]);
    return [
      ...mems.results.map((m) => `[your memory] ${m.memory}`),
      ...msgs.results.map(
        (m) => `[${new Date(m.created_at).toISOString().slice(0, 10)}] ${m.speaker_name}: ${m.text.slice(0, 400)}`,
      ),
    ];
  }
}
