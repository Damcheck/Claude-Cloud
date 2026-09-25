import type { Env } from "../types";

export const BACKUP_TABLES = [
  "messages",
  "discussions",
  "group_facts",
  "agent_memories",
  "discussion_summaries",
  "documents",
  "usage",
  "approvals",
  "followups",
  "predictions",
  "claims",
  "ideas",
  "action_items",
  "decisions",
  "missions",
  "mission_tasks",
  "watchers",
  "entities",
  "entity_facts",
  "relations",
  "custom_tools",
  "playbook",
  "persona_versions",
  "agent_overrides",
  "autonomy",
  "chats",
];

/** Export every table as JSON to R2 under backups/<date>/. */
export async function runBackup(env: Env): Promise<string> {
  if (!env.BACKUPS) return "Backups need an R2 bucket bound as BACKUPS.";
  const day = new Date().toISOString().slice(0, 10);
  const counts: string[] = [];
  for (const table of BACKUP_TABLES) {
    try {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table} LIMIT 200000`).all();
      await env.BACKUPS.put(`backups/${day}/${table}.json`, JSON.stringify(results), { httpMetadata: { contentType: "application/json" } });
      counts.push(`${table} ${results.length}`);
    } catch (err) {
      counts.push(`${table} ✗`);
      console.warn(`backup of ${table} failed`, err);
    }
  }
  return `💾 Backup ${day}: ${counts.join(", ")}`;
}
