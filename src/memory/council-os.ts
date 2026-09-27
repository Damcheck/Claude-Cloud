import { AGENT_IDS } from "../agents/registry";
import type { AgentId } from "../types";

export interface ProjectWorld {
  id: number;
  conv_id: number;
  name: string;
  description: string;
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
}

export interface CouncilOsSnapshot {
  world: ProjectWorld;
  worlds: ProjectWorld[];
  reputation: Record<string, any>[];
  relationships: Record<string, any>[];
  events: Record<string, any>[];
  simulations: Record<string, any>[];
  missions: Record<string, any>[];
  decisions: Record<string, any>[];
  founderProfile: Record<string, any>[];
}

const now = () => Date.now();
const clamp = (value: number) => Math.max(0, Math.min(100, value));

export class CouncilOsStore {
  constructor(private db: D1Database) {}

  async ensureDefaultWorld(convId: number): Promise<ProjectWorld> {
    let active = await this.activeWorld(convId);
    if (active) return active;
    const at = now();
    await this.db
      .prepare("INSERT OR IGNORE INTO project_worlds (conv_id, name, description, created_at, updated_at) VALUES (?, 'General', 'The council shared home world.', ?, ?)")
      .bind(convId, at, at)
      .run();
    const world = await this.db.prepare("SELECT * FROM project_worlds WHERE conv_id = ? AND name = 'General'").bind(convId).first<ProjectWorld>();
    if (!world) throw new Error("could not create default project world");
    await this.selectWorld(convId, world.id);
    return world;
  }

  async activeWorld(convId: number): Promise<ProjectWorld | null> {
    return this.db
      .prepare("SELECT w.* FROM project_world_state s JOIN project_worlds w ON w.id = s.project_id WHERE s.conv_id = ?")
      .bind(convId)
      .first<ProjectWorld>();
  }

  async worlds(convId: number): Promise<ProjectWorld[]> {
    return (await this.db.prepare("SELECT * FROM project_worlds WHERE conv_id = ? ORDER BY status, updated_at DESC").bind(convId).all<ProjectWorld>()).results;
  }

  async createWorld(convId: number, name: string, description = ""): Promise<ProjectWorld> {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new Error("world name is required");
    const at = now();
    await this.db
      .prepare("INSERT OR IGNORE INTO project_worlds (conv_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(convId, clean, description.trim().slice(0, 1000), at, at)
      .run();
    const world = await this.db.prepare("SELECT * FROM project_worlds WHERE conv_id = ? AND name = ?").bind(convId, clean).first<ProjectWorld>();
    if (!world) throw new Error("could not create project world");
    await this.selectWorld(convId, world.id);
    return world;
  }

  async selectWorld(convId: number, projectId: number): Promise<boolean> {
    const world = await this.db.prepare("SELECT id FROM project_worlds WHERE id = ? AND conv_id = ? AND status = 'active'").bind(projectId, convId).first();
    if (!world) return false;
    await this.db
      .prepare("INSERT INTO project_world_state (conv_id, project_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(conv_id) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at")
      .bind(convId, projectId, now())
      .run();
    return true;
  }

  private async projectId(convId: number): Promise<number> {
    return (await this.ensureDefaultWorld(convId)).id;
  }

  async recordMeetingEvent(input: {
    convId: number;
    discussionId?: number | null;
    kind: string;
    actor: string;
    target?: string;
    text?: string;
    metadata?: unknown;
  }): Promise<void> {
    const projectId = await this.projectId(input.convId);
    await this.db
      .prepare("INSERT INTO meeting_events (conv_id, project_id, discussion_id, kind, actor, target, text, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(input.convId, projectId, input.discussionId ?? null, input.kind, input.actor, input.target ?? null, (input.text ?? "").slice(0, 8000), JSON.stringify(input.metadata ?? {}).slice(0, 8000), now())
      .run();
  }

  async recordInteraction(convId: number, source: AgentId, target: AgentId, text: string): Promise<void> {
    if (source === target) return;
    const projectId = await this.projectId(convId);
    const challenge = /\b(wrong|disagree|false|broken|nonsense|challenge|prove|evidence|but|however)\b/i.test(text);
    const positive = /\b(agree|good point|exactly|fair|concede|right about|well spotted|thank)\b/i.test(text);
    const trustDelta = positive ? 2 : challenge ? -0.5 : 0.25;
    const respectDelta = challenge ? 1 : positive ? 1.5 : 0.25;
    const tensionDelta = challenge ? 3 : positive ? -2 : -0.25;
    const at = now();
    await this.db
      .prepare("INSERT OR IGNORE INTO agent_relationships (conv_id, project_id, source_agent, target_agent, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(convId, projectId, source, target, at)
      .run();
    const current = await this.db
      .prepare("SELECT trust, respect, tension FROM agent_relationships WHERE conv_id = ? AND project_id = ? AND source_agent = ? AND target_agent = ?")
      .bind(convId, projectId, source, target)
      .first<{ trust: number; respect: number; tension: number }>();
    await this.db
      .prepare("UPDATE agent_relationships SET trust = ?, respect = ?, tension = ?, interactions = interactions + 1, last_reason = ?, updated_at = ? WHERE conv_id = ? AND project_id = ? AND source_agent = ? AND target_agent = ?")
      .bind(clamp((current?.trust ?? 50) + trustDelta), clamp((current?.respect ?? 50) + respectDelta), clamp((current?.tension ?? 10) + tensionDelta), text.slice(0, 240), at, convId, projectId, source, target)
      .run();
  }

  async reputationEvent(convId: number, agent: AgentId, dimension: "accuracy" | "usefulness" | "creativity" | "reliability" | "founder_score" | "wins" | "losses", delta: number, reason: string, refType?: string, refId?: number): Promise<void> {
    const projectId = await this.projectId(convId);
    const at = now();
    await this.db
      .prepare("INSERT OR IGNORE INTO agent_reputation (conv_id, project_id, agent, updated_at) VALUES (?, ?, ?, ?)")
      .bind(convId, projectId, agent, at)
      .run();
    if (["wins", "losses", "founder_score"].includes(dimension)) {
      await this.db.prepare(`UPDATE agent_reputation SET ${dimension} = ${dimension} + ?, updated_at = ? WHERE conv_id = ? AND project_id = ? AND agent = ?`).bind(delta, at, convId, projectId, agent).run();
    } else {
      const row = await this.db.prepare(`SELECT ${dimension} AS value FROM agent_reputation WHERE conv_id = ? AND project_id = ? AND agent = ?`).bind(convId, projectId, agent).first<{ value: number }>();
      await this.db.prepare(`UPDATE agent_reputation SET ${dimension} = ?, updated_at = ? WHERE conv_id = ? AND project_id = ? AND agent = ?`).bind(clamp((row?.value ?? 50) + delta), at, convId, projectId, agent).run();
    }
    await this.db
      .prepare("INSERT INTO reputation_events (conv_id, project_id, agent, dimension, delta, reason, ref_type, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(convId, projectId, agent, dimension, delta, reason.slice(0, 500), refType ?? null, refId ?? null, at)
      .run();
  }

  async createSimulation(convId: number, title: string, question: string, scenario = "war_room"): Promise<number> {
    const projectId = await this.projectId(convId);
    const at = now();
    const row = await this.db
      .prepare("INSERT INTO simulations (conv_id, project_id, title, question, scenario, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(convId, projectId, title.slice(0, 120), question.slice(0, 4000), scenario, at, at)
      .first<{ id: number }>();
    return row!.id;
  }

  async setFounderTrait(convId: number, key: string, value: string, confidence = 1, source = "founder"): Promise<void> {
    await this.db
      .prepare("INSERT INTO founder_profile (conv_id, key, value, confidence, source, approved, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(conv_id, key) DO UPDATE SET value = excluded.value, confidence = excluded.confidence, source = excluded.source, approved = 1, updated_at = excluded.updated_at")
      .bind(convId, key.slice(0, 80), value.slice(0, 2000), clamp(confidence * 100) / 100, source, now())
      .run();
  }

  async snapshot(convId: number): Promise<CouncilOsSnapshot> {
    const world = await this.ensureDefaultWorld(convId);
    const [worlds, reputationRows, relationships, events, simulations, missions, decisions, founderProfile] = await Promise.all([
      this.worlds(convId),
      this.db.prepare("SELECT * FROM agent_reputation WHERE conv_id = ? AND project_id = ? ORDER BY founder_score DESC, usefulness DESC").bind(convId, world.id).all<Record<string, any>>(),
      this.db.prepare("SELECT * FROM agent_relationships WHERE conv_id = ? AND project_id = ? AND interactions > 0 ORDER BY tension DESC, respect DESC LIMIT 24").bind(convId, world.id).all<Record<string, any>>(),
      this.db.prepare("SELECT id, discussion_id, kind, actor, target, text, metadata_json, created_at FROM meeting_events WHERE conv_id = ? AND project_id = ? ORDER BY id DESC LIMIT 60").bind(convId, world.id).all<Record<string, any>>(),
      this.db.prepare("SELECT id, title, question, scenario, status, created_at, updated_at FROM simulations WHERE conv_id = ? AND project_id = ? ORDER BY id DESC LIMIT 10").bind(convId, world.id).all<Record<string, any>>(),
      this.db.prepare("SELECT id, goal, status, deadline_at, updated_at FROM missions WHERE conv_id = ? ORDER BY id DESC LIMIT 10").bind(convId).all<Record<string, any>>(),
      this.db.prepare("SELECT id, title, chosen, dissent, status, created_at FROM decisions WHERE conv_id = ? ORDER BY id DESC LIMIT 12").bind(convId).all<Record<string, any>>(),
      this.db.prepare("SELECT key, value, confidence, source, approved, updated_at FROM founder_profile WHERE conv_id = ? ORDER BY key").bind(convId).all<Record<string, any>>(),
    ]);
    const reputation = [...reputationRows.results];
    for (const agent of AGENT_IDS) {
      if (!reputation.some((row) => row.agent === agent)) reputation.push({ agent, accuracy: 50, usefulness: 50, creativity: 50, reliability: 50, founder_score: 0, wins: 0, losses: 0 });
    }
    return {
      world,
      worlds,
      reputation,
      relationships: relationships.results,
      events: events.results,
      simulations: simulations.results,
      missions: missions.results,
      decisions: decisions.results,
      founderProfile: founderProfile.results,
    };
  }
}
