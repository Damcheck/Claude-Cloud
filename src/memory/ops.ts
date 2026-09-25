import type { AgentId } from "../types";

/**
 * D1 access for the v3 features: autonomy, audit, missions, jobs, watchers, learning,
 * decisions, knowledge graph, custom tools and model scouting.
 */

export type AutonomyLevel = "suggest" | "approve" | "act";

export interface MissionRow {
  id: number;
  conv_id: number;
  chat_id: number;
  dm_agent: AgentId | null;
  goal: string;
  success_criteria: string;
  token_budget: number;
  deadline_at: number;
  status: "planning" | "running" | "blocked" | "done" | "failed" | "stopped";
  instance_id: string | null;
  result: string | null;
  created_at: number;
}

export interface MissionTaskRow {
  id: number;
  mission_id: number;
  key: string;
  title: string;
  detail: string;
  assignee: AgentId;
  depends_on: string;
  status: "pending" | "done" | "blocked" | "failed";
  result: string | null;
  attempts: number;
}

export interface WatcherRow {
  id: number;
  conv_id: number;
  chat_id: number;
  agent: AgentId;
  kind: "url" | "rss" | "github";
  target: string;
  every_minutes: number;
  state_json: string;
  last_checked_at: number;
  active: number;
}

export interface CustomToolRow {
  id: number;
  name: string;
  description: string;
  parameters_json: string;
  code: string;
  allowed_domains: string;
  agents: string;
  version: number;
  status: "review" | "pending_approval" | "active" | "rejected";
  review_notes: string | null;
  created_by: AgentId;
}

export interface TraceInput {
  convId: number;
  discussionId: number | null;
  agent: AgentId;
  models: string[];
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  tainted: boolean;
  outcome: "posted" | "passed" | "error";
  error?: string;
  detail: unknown;
}

const now = () => Date.now();

export class OpsStore {
  constructor(private db: D1Database) {}

  // ---------------------------------------------------------------- settings
  async getSetting(key: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string | null): Promise<void> {
    if (value === null) await this.db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
    else await this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
  }

  async isFrozen(): Promise<boolean> {
    return (await this.getSetting("frozen")) === "1";
  }

  async isDryRun(convId: number): Promise<boolean> {
    return (await this.getSetting(`dry_run:${convId}`)) === "1";
  }

  // ---------------------------------------------------------------- autonomy
  async autonomyFor(agent: AgentId): Promise<Map<string, AutonomyLevel>> {
    const { results } = await this.db
      .prepare("SELECT agent, skill, level FROM autonomy WHERE agent = ? OR agent = '*' ORDER BY CASE agent WHEN '*' THEN 0 ELSE 1 END")
      .bind(agent)
      .all<{ agent: string; skill: string; level: AutonomyLevel }>();
    // Council-wide rules first, so an agent's own rule overrides them.
    return new Map(results.map((r) => [r.skill, r.level]));
  }

  async setAutonomy(agent: AgentId | "*", skill: string, level: AutonomyLevel | null): Promise<void> {
    if (level === null) await this.db.prepare("DELETE FROM autonomy WHERE agent = ? AND skill = ?").bind(agent, skill).run();
    else await this.db.prepare("INSERT OR REPLACE INTO autonomy (agent, skill, level) VALUES (?, ?, ?)").bind(agent, skill, level).run();
  }

  async allAutonomy(): Promise<{ agent: string; skill: string; level: string }[]> {
    const { results } = await this.db.prepare("SELECT agent, skill, level FROM autonomy ORDER BY agent, skill").all<{ agent: string; skill: string; level: string }>();
    return results;
  }

  // ------------------------------------------------------------ audit/traces
  async recordSkillCall(c: { convId: number; agent: AgentId; skill: string; args: unknown; decision: string; tainted: boolean; ok?: boolean; durationMs?: number }): Promise<void> {
    await this.db
      .prepare("INSERT INTO skill_calls (conv_id, agent, skill, args_summary, decision, tainted, ok, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(c.convId, c.agent, c.skill, JSON.stringify(c.args ?? {}).slice(0, 400), c.decision, c.tainted ? 1 : 0, c.ok === undefined ? null : c.ok ? 1 : 0, c.durationMs ?? null, now())
      .run();
  }

  async recentSkillCalls(convId: number, limit = 20): Promise<{ agent: string; skill: string; args_summary: string; decision: string; tainted: number; ok: number | null; created_at: number }[]> {
    const { results } = await this.db
      .prepare("SELECT agent, skill, args_summary, decision, tainted, ok, created_at FROM skill_calls WHERE conv_id = ? ORDER BY id DESC LIMIT ?")
      .bind(convId, limit)
      .all<{ agent: string; skill: string; args_summary: string; decision: string; tainted: number; ok: number | null; created_at: number }>();
    return results;
  }

  async recordTrace(t: TraceInput): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO traces (conv_id, discussion_id, agent, models, latency_ms, prompt_tokens, completion_tokens, tool_calls, tainted, outcome, error, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(t.convId, t.discussionId, t.agent, t.models.join(","), t.latencyMs, t.promptTokens, t.completionTokens, t.toolCalls, t.tainted ? 1 : 0, t.outcome, t.error ?? null, JSON.stringify(t.detail).slice(0, 20_000), now())
      .run();
  }

  async lastTrace(convId: number, agent?: AgentId): Promise<Record<string, any> | null> {
    const q = agent
      ? this.db.prepare("SELECT * FROM traces WHERE conv_id = ? AND agent = ? ORDER BY id DESC LIMIT 1").bind(convId, agent)
      : this.db.prepare("SELECT * FROM traces WHERE conv_id = ? ORDER BY id DESC LIMIT 1").bind(convId);
    return q.first<Record<string, any>>();
  }

  async recentTraces(convId: number | null, limit = 50): Promise<Record<string, any>[]> {
    const q =
      convId === null
        ? this.db.prepare("SELECT id, conv_id, discussion_id, agent, models, latency_ms, prompt_tokens, completion_tokens, tool_calls, tainted, outcome, error, created_at FROM traces ORDER BY id DESC LIMIT ?").bind(limit)
        : this.db.prepare("SELECT id, conv_id, discussion_id, agent, models, latency_ms, prompt_tokens, completion_tokens, tool_calls, tainted, outcome, error, created_at FROM traces WHERE conv_id = ? ORDER BY id DESC LIMIT ?").bind(convId, limit);
    return (await q.all<Record<string, any>>()).results;
  }

  async tokensForTag(tag: string): Promise<number> {
    const row = await this.db.prepare("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t FROM usage WHERE tag = ?").bind(tag).first<{ t: number }>();
    return row?.t ?? 0;
  }

  // ------------------------------------------------------------- overrides
  async overrides(): Promise<Map<string, { model: string | null; personality: string | null }>> {
    const { results } = await this.db.prepare("SELECT agent, model, personality FROM agent_overrides").all<{ agent: string; model: string | null; personality: string | null }>();
    return new Map(results.map((r) => [r.agent, { model: r.model, personality: r.personality }]));
  }

  async setOverride(agent: AgentId, field: "model" | "personality", value: string | null): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO agent_overrides (agent, updated_at) VALUES (?, ?)").bind(agent, now()).run();
    await this.db.prepare(`UPDATE agent_overrides SET ${field} = ?, updated_at = ? WHERE agent = ?`).bind(value, now(), agent).run();
  }

  async proposePersona(agent: AgentId, personality: string, reason: string, evalJson: unknown): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO persona_versions (agent, personality, reason, eval_json, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .bind(agent, personality, reason, JSON.stringify(evalJson ?? null), now())
      .first<{ id: number }>();
    return row!.id;
  }

  async getPersona(id: number): Promise<{ id: number; agent: AgentId; personality: string; status: string } | null> {
    return this.db.prepare("SELECT id, agent, personality, status FROM persona_versions WHERE id = ?").bind(id).first();
  }

  async setPersonaStatus(id: number, status: "active" | "rejected"): Promise<void> {
    await this.db.prepare("UPDATE persona_versions SET status = ? WHERE id = ?").bind(status, id).run();
  }

  // ------------------------------------------------------- feedback/lessons
  async addFeedback(convId: number, agent: AgentId, messageId: number, reaction: string, score: number): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO feedback (conv_id, agent, message_id, reaction, score, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(convId, agent, messageId, reaction, score, now())
      .run();
  }

  async feedbackSince(agent: AgentId, since: number): Promise<{ score: number; reaction: string; text: string }[]> {
    const { results } = await this.db
      .prepare(
        "SELECT f.score, f.reaction, COALESCE(m.text, '') AS text FROM feedback f LEFT JOIN messages m ON m.id = f.message_id WHERE f.agent = ? AND f.created_at >= ? ORDER BY f.id DESC LIMIT 40",
      )
      .bind(agent, since)
      .all<{ score: number; reaction: string; text: string }>();
    return results;
  }

  async lessons(agent: AgentId, limit = 8): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT lesson FROM playbook WHERE agent = ? AND active = 1 ORDER BY id DESC LIMIT ?")
      .bind(agent, limit)
      .all<{ lesson: string }>();
    return results.map((r) => r.lesson);
  }

  async addLessons(agent: AgentId, lessons: string[], keep = 10): Promise<void> {
    for (const lesson of lessons) {
      await this.db.prepare("INSERT INTO playbook (agent, lesson, created_at) VALUES (?, ?, ?)").bind(agent, lesson.slice(0, 300), now()).run();
    }
    await this.db
      .prepare("UPDATE playbook SET active = 0 WHERE agent = ? AND id NOT IN (SELECT id FROM playbook WHERE agent = ? ORDER BY id DESC LIMIT ?)")
      .bind(agent, agent, keep)
      .run();
  }

  // ---------------------------------------------------------------- missions
  async createMission(m: { convId: number; chatId: number; dmAgent?: AgentId; goal: string; tokenBudget: number; deadlineAt: number }): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO missions (conv_id, chat_id, dm_agent, goal, token_budget, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(m.convId, m.chatId, m.dmAgent ?? null, m.goal, m.tokenBudget, m.deadlineAt, now(), now())
      .first<{ id: number }>();
    return row!.id;
  }

  async getMission(id: number): Promise<MissionRow | null> {
    return this.db.prepare("SELECT * FROM missions WHERE id = ?").bind(id).first<MissionRow>();
  }

  async updateMission(id: number, fields: Partial<Pick<MissionRow, "status" | "instance_id" | "result" | "success_criteria">>): Promise<void> {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    await this.db
      .prepare(`UPDATE missions SET ${sets}, updated_at = ? WHERE id = ?`)
      .bind(...keys.map((k) => fields[k] ?? null), now(), id)
      .run();
  }

  async missions(convIds: number[], limit = 10): Promise<MissionRow[]> {
    const marks = convIds.map(() => "?").join(",");
    const { results } = await this.db.prepare(`SELECT * FROM missions WHERE conv_id IN (${marks}) ORDER BY id DESC LIMIT ?`).bind(...convIds, limit).all<MissionRow>();
    return results;
  }

  async addTasks(missionId: number, tasks: { key: string; title: string; detail: string; assignee: AgentId; dependsOn: string[] }[]): Promise<void> {
    for (const t of tasks) {
      await this.db
        .prepare("INSERT INTO mission_tasks (mission_id, key, title, detail, assignee, depends_on, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(missionId, t.key, t.title, t.detail, t.assignee, JSON.stringify(t.dependsOn), now())
        .run();
    }
  }

  async tasks(missionId: number): Promise<MissionTaskRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM mission_tasks WHERE mission_id = ? ORDER BY id").bind(missionId).all<MissionTaskRow>();
    return results;
  }

  async updateTask(id: number, status: MissionTaskRow["status"], result: string | null, bumpAttempts = false): Promise<void> {
    await this.db
      .prepare(`UPDATE mission_tasks SET status = ?, result = ?, attempts = attempts + ?, updated_at = ? WHERE id = ?`)
      .bind(status, result, bumpAttempts ? 1 : 0, now(), id)
      .run();
  }

  // -------------------------------------------------------------------- jobs
  async createJob(convId: number, kind: string, params: unknown): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO jobs (conv_id, kind, params_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .bind(convId, kind, JSON.stringify(params), now(), now())
      .first<{ id: number }>();
    return row!.id;
  }

  async finishJob(id: number, status: "done" | "failed", result: string): Promise<void> {
    await this.db.prepare("UPDATE jobs SET status = ?, result = ?, updated_at = ? WHERE id = ?").bind(status, result.slice(0, 20_000), now(), id).run();
  }

  async recentJobs(limit = 20): Promise<Record<string, any>[]> {
    return (await this.db.prepare("SELECT id, conv_id, kind, status, created_at, updated_at FROM jobs ORDER BY id DESC LIMIT ?").bind(limit).all<Record<string, any>>()).results;
  }

  // ---------------------------------------------------------------- watchers
  async addWatcher(w: { convId: number; chatId: number; agent: AgentId; kind: WatcherRow["kind"]; target: string; everyMinutes: number; createdBy: string }): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO watchers (conv_id, chat_id, agent, kind, target, every_minutes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(w.convId, w.chatId, w.agent, w.kind, w.target, w.everyMinutes, w.createdBy, now())
      .first<{ id: number }>();
    return row!.id;
  }

  async watchers(convId: number): Promise<WatcherRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM watchers WHERE conv_id = ? AND active = 1 ORDER BY id").bind(convId).all<WatcherRow>();
    return results;
  }

  async dueWatchers(at: number, limit = 10): Promise<WatcherRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM watchers WHERE active = 1 AND last_checked_at + every_minutes * 60000 <= ? ORDER BY last_checked_at LIMIT ?")
      .bind(at, limit)
      .all<WatcherRow>();
    return results;
  }

  async watchersFor(kind: WatcherRow["kind"], target: string): Promise<WatcherRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM watchers WHERE active = 1 AND kind = ? AND LOWER(target) = LOWER(?)").bind(kind, target).all<WatcherRow>();
    return results;
  }

  async updateWatcher(id: number, state: unknown): Promise<void> {
    await this.db.prepare("UPDATE watchers SET state_json = ?, last_checked_at = ? WHERE id = ?").bind(JSON.stringify(state).slice(0, 60_000), now(), id).run();
  }

  async removeWatcher(id: number, convId: number): Promise<boolean> {
    const res = await this.db.prepare("UPDATE watchers SET active = 0 WHERE id = ? AND conv_id = ?").bind(id, convId).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async addDigest(convId: number, agent: AgentId, summary: string, importance: number): Promise<void> {
    await this.db.prepare("INSERT INTO digest_items (conv_id, agent, summary, importance, created_at) VALUES (?, ?, ?, ?, ?)").bind(convId, agent, summary.slice(0, 600), importance, now()).run();
  }

  async undeliveredDigest(convIds: number[]): Promise<{ id: number; agent: string; summary: string }[]> {
    const marks = convIds.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(`SELECT id, agent, summary FROM digest_items WHERE conv_id IN (${marks}) AND delivered = 0 ORDER BY importance DESC, id LIMIT 15`)
      .bind(...convIds)
      .all<{ id: number; agent: string; summary: string }>();
    return results;
  }

  async markDigestDelivered(ids: number[]): Promise<void> {
    if (!ids.length) return;
    await this.db.prepare(`UPDATE digest_items SET delivered = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
  }

  // --------------------------------------------------------------- decisions
  async addDecision(d: { convId: number; title: string; context: string; options: string[]; chosen: string; dissent: string; rationale: string; reviewAt: number | null; by: AgentId }): Promise<number> {
    const row = await this.db
      .prepare(
        "INSERT INTO decisions (conv_id, title, context, options, chosen, dissent, rationale, review_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .bind(d.convId, d.title, d.context, JSON.stringify(d.options), d.chosen, d.dissent, d.rationale, d.reviewAt, d.by, now())
      .first<{ id: number }>();
    return row!.id;
  }

  async reviewDecision(id: number, convIds: number[], status: "worked" | "failed" | "revised", outcome: string): Promise<boolean> {
    const res = await this.db
      .prepare(`UPDATE decisions SET status = ?, outcome = ? WHERE id = ? AND conv_id IN (${convIds.map(() => "?").join(",")})`)
      .bind(status, outcome, id, ...convIds)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async decisions(convIds: number[], limit = 15): Promise<{ id: number; title: string; chosen: string; status: string; review_at: number | null; created_at: number }[]> {
    const { results } = await this.db
      .prepare(`SELECT id, title, chosen, status, review_at, created_at FROM decisions WHERE conv_id IN (${convIds.map(() => "?").join(",")}) ORDER BY id DESC LIMIT ?`)
      .bind(...convIds, limit)
      .all<{ id: number; title: string; chosen: string; status: string; review_at: number | null; created_at: number }>();
    return results;
  }

  async saveArgumentMap(discussionId: number, convId: number, map: unknown): Promise<void> {
    await this.db.prepare("INSERT OR REPLACE INTO argument_maps (discussion_id, conv_id, map_json, created_at) VALUES (?, ?, ?, ?)").bind(discussionId, convId, JSON.stringify(map), now()).run();
  }

  // -------------------------------------------------------------- forecasts
  async nextForecastGroup(): Promise<number> {
    const row = await this.db.prepare("SELECT COALESCE(MAX(forecast_group), 0) + 1 AS g FROM predictions").first<{ g: number }>();
    return row?.g ?? 1;
  }

  async addForecast(p: { convId: number; agent: AgentId | "council"; claim: string; probability: number; checkAt: number; domain: string; group: number }): Promise<void> {
    await this.db
      .prepare("INSERT INTO predictions (conv_id, agent, claim, confidence, check_at, domain, forecast_group, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(p.convId, p.agent, p.claim, p.probability, p.checkAt, p.domain, p.group, now())
      .run();
  }

  /** Resolve every prediction in a forecast group: yes → the claims were true. */
  async resolveForecastGroup(group: number, happened: boolean): Promise<number> {
    const res = await this.db
      .prepare("UPDATE predictions SET status = ?, resolved_at = ? WHERE forecast_group = ? AND status = 'open'")
      .bind(happened ? "right" : "wrong", now(), group)
      .run();
    return res.meta.changes ?? 0;
  }

  /** Resolved predictions with the probability given and whether the claim came true. */
  async resolvedPredictions(agent: string): Promise<{ p: number; o: number; domain: string }[]> {
    const { results } = await this.db
      .prepare("SELECT confidence AS p, CASE status WHEN 'right' THEN 1 ELSE 0 END AS o, domain FROM predictions WHERE agent = ? AND status IN ('right', 'wrong')")
      .bind(agent)
      .all<{ p: number; o: number; domain: string }>();
    return results;
  }

  // --------------------------------------------------------- knowledge graph
  async upsertEntity(convId: number, name: string, type: string, summary: string): Promise<number> {
    await this.db
      .prepare(
        "INSERT INTO entities (conv_id, name, type, summary, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (conv_id, name) DO UPDATE SET type = excluded.type, summary = CASE WHEN excluded.summary != '' THEN excluded.summary ELSE entities.summary END, updated_at = excluded.updated_at",
      )
      .bind(convId, name, type, summary, now())
      .run();
    const row = await this.db.prepare("SELECT id FROM entities WHERE conv_id = ? AND name = ?").bind(convId, name).first<{ id: number }>();
    return row!.id;
  }

  async currentFact(entityId: number, attribute: string): Promise<{ id: number; value: string } | null> {
    return this.db.prepare("SELECT id, value FROM entity_facts WHERE entity_id = ? AND LOWER(attribute) = LOWER(?) AND current = 1 ORDER BY id DESC LIMIT 1").bind(entityId, attribute).first();
  }

  async addFact(entityId: number, attribute: string, value: string, source: string): Promise<number> {
    await this.db.prepare("UPDATE entity_facts SET current = 0 WHERE entity_id = ? AND LOWER(attribute) = LOWER(?)").bind(entityId, attribute).run();
    const row = await this.db
      .prepare("INSERT INTO entity_facts (entity_id, attribute, value, source, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .bind(entityId, attribute, value, source, now())
      .first<{ id: number }>();
    return row!.id;
  }

  async addRelation(convId: number, subjectId: number, predicate: string, objectId: number): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO relations (conv_id, subject_id, predicate, object_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(convId, subjectId, predicate, objectId, now()).run();
  }

  async addConflict(c: { convId: number; entityId: number; attribute: string; oldFactId: number; newValue: string; source: string }): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO fact_conflicts (conv_id, entity_id, attribute, old_fact_id, new_value, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(c.convId, c.entityId, c.attribute, c.oldFactId, c.newValue, c.source, now())
      .first<{ id: number }>();
    return row!.id;
  }

  async getConflict(id: number): Promise<{ id: number; conv_id: number; entity_id: number; attribute: string; new_value: string; source: string; status: string } | null> {
    return this.db.prepare("SELECT id, conv_id, entity_id, attribute, new_value, source, status FROM fact_conflicts WHERE id = ?").bind(id).first();
  }

  async settleConflict(id: number, status: "kept_old" | "used_new"): Promise<boolean> {
    const res = await this.db.prepare("UPDATE fact_conflicts SET status = ? WHERE id = ? AND status = 'open'").bind(status, id).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async findEntities(convIds: number[], text: string, limit = 5): Promise<{ id: number; name: string; type: string; summary: string }[]> {
    const marks = convIds.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(`SELECT id, name, type, summary FROM entities WHERE conv_id IN (${marks}) AND INSTR(LOWER(?), LOWER(name)) > 0 AND LENGTH(name) > 2 ORDER BY LENGTH(name) DESC LIMIT ?`)
      .bind(...convIds, text, limit)
      .all<{ id: number; name: string; type: string; summary: string }>();
    return results;
  }

  async entityByName(convIds: number[], name: string): Promise<{ id: number; name: string; type: string; summary: string } | null> {
    const marks = convIds.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT id, name, type, summary FROM entities WHERE conv_id IN (${marks}) AND LOWER(name) LIKE LOWER(?) ORDER BY LENGTH(name) LIMIT 1`)
      .bind(...convIds, `%${name}%`)
      .first();
  }

  async entityDetails(entityId: number): Promise<{ facts: { attribute: string; value: string }[]; relations: string[] }> {
    const [facts, rels] = await Promise.all([
      this.db.prepare("SELECT attribute, value FROM entity_facts WHERE entity_id = ? AND current = 1 ORDER BY id DESC LIMIT 20").bind(entityId).all<{ attribute: string; value: string }>(),
      this.db
        .prepare(
          "SELECT s.name AS s, r.predicate AS p, o.name AS o FROM relations r JOIN entities s ON s.id = r.subject_id JOIN entities o ON o.id = r.object_id WHERE r.subject_id = ? OR r.object_id = ? LIMIT 20",
        )
        .bind(entityId, entityId)
        .all<{ s: string; p: string; o: string }>(),
    ]);
    return { facts: facts.results, relations: rels.results.map((r) => `${r.s} ${r.p} ${r.o}`) };
  }

  // ------------------------------------------------------ memory maintenance
  async activeMemories(agent: AgentId): Promise<{ id: number; memory: string }[]> {
    const { results } = await this.db.prepare("SELECT id, memory FROM agent_memories WHERE agent = ? AND archived = 0 ORDER BY id").bind(agent).all<{ id: number; memory: string }>();
    return results;
  }

  async archiveMemories(ids: number[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      await this.db.prepare(`UPDATE agent_memories SET archived = 1 WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).run();
    }
  }

  // ------------------------------------------------------------ custom tools
  async createTool(t: { name: string; description: string; parameters: unknown; code: string; allowedDomains: string[]; agents: AgentId[]; createdBy: AgentId }): Promise<number> {
    const existing = await this.db.prepare("SELECT id, version FROM custom_tools WHERE name = ?").bind(t.name).first<{ id: number; version: number }>();
    if (existing) {
      await this.db
        .prepare("UPDATE custom_tools SET description = ?, parameters_json = ?, code = ?, allowed_domains = ?, agents = ?, version = version + 1, status = 'review', review_notes = NULL WHERE id = ?")
        .bind(t.description, JSON.stringify(t.parameters), t.code, JSON.stringify(t.allowedDomains), JSON.stringify(t.agents), existing.id)
        .run();
      return existing.id;
    }
    const row = await this.db
      .prepare("INSERT INTO custom_tools (name, description, parameters_json, code, allowed_domains, agents, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(t.name, t.description, JSON.stringify(t.parameters), t.code, JSON.stringify(t.allowedDomains), JSON.stringify(t.agents), t.createdBy, now())
      .first<{ id: number }>();
    return row!.id;
  }

  async getTool(id: number): Promise<CustomToolRow | null> {
    return this.db.prepare("SELECT * FROM custom_tools WHERE id = ?").bind(id).first<CustomToolRow>();
  }

  async setToolStatus(id: number, status: CustomToolRow["status"], notes?: string): Promise<void> {
    await this.db.prepare("UPDATE custom_tools SET status = ?, review_notes = COALESCE(?, review_notes) WHERE id = ?").bind(status, notes ?? null, id).run();
  }

  async activeTools(): Promise<CustomToolRow[]> {
    return (await this.db.prepare("SELECT * FROM custom_tools WHERE status = 'active'").all<CustomToolRow>()).results;
  }

  async allTools(): Promise<CustomToolRow[]> {
    return (await this.db.prepare("SELECT * FROM custom_tools ORDER BY id DESC LIMIT 30").all<CustomToolRow>()).results;
  }

  // -------------------------------------------------------- scouting / evals
  async markModelsSeen(ids: string[]): Promise<string[]> {
    const fresh: string[] = [];
    for (const id of ids) {
      const res = await this.db.prepare("INSERT OR IGNORE INTO seen_models (id, first_seen) VALUES (?, ?)").bind(id, now()).run();
      if ((res.meta.changes ?? 0) > 0) fresh.push(id);
    }
    return fresh;
  }

  async saveEval(agent: AgentId, model: string, personality: string | null, score: number, metrics: unknown): Promise<void> {
    await this.db
      .prepare("INSERT INTO eval_runs (agent, model, personality, score, metrics_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(agent, model, personality, score, JSON.stringify(metrics), now())
      .run();
  }

  async latestEval(agent: AgentId, model: string, maxAgeMs = 14 * 86400_000): Promise<{ score: number } | null> {
    return this.db
      .prepare("SELECT score FROM eval_runs WHERE agent = ? AND model = ? AND personality IS NULL AND created_at > ? ORDER BY id DESC LIMIT 1")
      .bind(agent, model, now() - maxAgeMs)
      .first<{ score: number }>();
  }
}
