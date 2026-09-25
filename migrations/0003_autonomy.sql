-- AI Council v3: autonomy, missions, watchers, learning, knowledge graph, ops

-- Global switches (freeze) and per-conversation settings (dry run).
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Autonomy levels: agent default (skill = '*') or per skill. level: suggest | approve | act
CREATE TABLE IF NOT EXISTS autonomy (
  agent  TEXT NOT NULL,
  skill  TEXT NOT NULL DEFAULT '*',
  level  TEXT NOT NULL,
  PRIMARY KEY (agent, skill)
);

-- One row per agent turn (admin page, /why).
CREATE TABLE IF NOT EXISTS traces (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id            INTEGER NOT NULL,
  discussion_id      INTEGER,
  agent              TEXT    NOT NULL,
  models             TEXT    NOT NULL,
  latency_ms         INTEGER NOT NULL,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  tool_calls         INTEGER NOT NULL DEFAULT 0,
  tainted            INTEGER NOT NULL DEFAULT 0,
  outcome            TEXT    NOT NULL, -- posted | passed | error
  error              TEXT,
  detail_json        TEXT    NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_conv ON traces (conv_id, id DESC);

-- Audit log of every skill call and the policy decision behind it.
CREATE TABLE IF NOT EXISTS skill_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id      INTEGER NOT NULL,
  agent        TEXT    NOT NULL,
  skill        TEXT    NOT NULL,
  args_summary TEXT    NOT NULL,
  decision     TEXT    NOT NULL, -- run | approve | deny | dry_run
  tainted      INTEGER NOT NULL DEFAULT 0,
  ok           INTEGER,
  duration_ms  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_calls_conv ON skill_calls (conv_id, id DESC);

ALTER TABLE usage ADD COLUMN tag TEXT;
ALTER TABLE approvals ADD COLUMN mission_id INTEGER;
ALTER TABLE predictions ADD COLUMN domain TEXT NOT NULL DEFAULT 'general';
ALTER TABLE predictions ADD COLUMN forecast_group INTEGER;
ALTER TABLE agent_memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

-- Runtime overrides: model swaps (scouting) and persona versions (self-improvement).
CREATE TABLE IF NOT EXISTS agent_overrides (
  agent        TEXT PRIMARY KEY,
  model        TEXT,
  personality  TEXT,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS persona_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent        TEXT    NOT NULL,
  personality  TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  eval_json    TEXT,
  status       TEXT    NOT NULL DEFAULT 'proposed', -- proposed | active | rejected
  created_at   INTEGER NOT NULL
);

-- Founder feedback (reactions) and the lessons agents distil from it.
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL,
  agent       TEXT    NOT NULL,
  message_id  INTEGER NOT NULL,
  reaction    TEXT    NOT NULL,
  score       INTEGER NOT NULL, -- +1 / -1 / 0
  created_at  INTEGER NOT NULL,
  UNIQUE (conv_id, message_id, reaction)
);

CREATE TABLE IF NOT EXISTS playbook (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT    NOT NULL,
  lesson      TEXT    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playbook_agent ON playbook (agent, active, id DESC);

-- Missions: goals that run for days.
CREATE TABLE IF NOT EXISTS missions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id           INTEGER NOT NULL,
  chat_id           INTEGER NOT NULL,
  dm_agent          TEXT,
  goal              TEXT    NOT NULL,
  success_criteria  TEXT    NOT NULL DEFAULT '',
  token_budget      INTEGER NOT NULL,
  deadline_at       INTEGER NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'planning', -- planning | running | blocked | done | failed | stopped
  instance_id       TEXT,
  result            TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id   INTEGER NOT NULL,
  key          TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  detail       TEXT    NOT NULL DEFAULT '',
  assignee     TEXT    NOT NULL,
  depends_on   TEXT    NOT NULL DEFAULT '[]',
  status       TEXT    NOT NULL DEFAULT 'pending', -- pending | done | blocked | failed
  result       TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mission_tasks ON mission_tasks (mission_id);

-- Background jobs (research, design loop, evals, reflection, scouting).
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id      INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  params_json  TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'running',
  result       TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Watchers and the digest of things worth mentioning later.
CREATE TABLE IF NOT EXISTS watchers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id          INTEGER NOT NULL,
  chat_id          INTEGER NOT NULL,
  agent            TEXT    NOT NULL,
  kind             TEXT    NOT NULL, -- url | rss | github
  target           TEXT    NOT NULL,
  every_minutes    INTEGER NOT NULL,
  state_json       TEXT    NOT NULL DEFAULT '{}',
  last_checked_at  INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  created_by       TEXT    NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS digest_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL,
  agent       TEXT    NOT NULL,
  summary     TEXT    NOT NULL,
  importance  REAL    NOT NULL,
  delivered   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Decision records (ADR-style), revisited on a date.
CREATE TABLE IF NOT EXISTS decisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  context     TEXT    NOT NULL DEFAULT '',
  options     TEXT    NOT NULL DEFAULT '[]',
  chosen      TEXT    NOT NULL,
  dissent     TEXT    NOT NULL DEFAULT '',
  rationale   TEXT    NOT NULL DEFAULT '',
  review_at   INTEGER,
  status      TEXT    NOT NULL DEFAULT 'active', -- active | worked | failed | revised
  outcome     TEXT,
  recorded_by TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Argument maps extracted from debates (crux finding).
CREATE TABLE IF NOT EXISTS argument_maps (
  discussion_id  INTEGER PRIMARY KEY,
  conv_id        INTEGER NOT NULL,
  map_json       TEXT    NOT NULL,
  created_at     INTEGER NOT NULL
);

-- Knowledge graph.
CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  summary     TEXT    NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL,
  UNIQUE (conv_id, name)
);

CREATE TABLE IF NOT EXISTS entity_facts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id     INTEGER NOT NULL,
  attribute     TEXT    NOT NULL,
  value         TEXT    NOT NULL,
  source        TEXT    NOT NULL DEFAULT '',
  current       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_facts ON entity_facts (entity_id, attribute, current);

CREATE TABLE IF NOT EXISTS relations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL,
  subject_id  INTEGER NOT NULL,
  predicate   TEXT    NOT NULL,
  object_id   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (subject_id, predicate, object_id)
);

CREATE TABLE IF NOT EXISTS fact_conflicts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id       INTEGER NOT NULL,
  entity_id     INTEGER NOT NULL,
  attribute     TEXT    NOT NULL,
  old_fact_id   INTEGER NOT NULL,
  new_value     TEXT    NOT NULL,
  source        TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'open', -- open | kept_old | used_new
  created_at    INTEGER NOT NULL
);

-- Tools the council writes for itself.
CREATE TABLE IF NOT EXISTS custom_tools (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL UNIQUE,
  description      TEXT    NOT NULL,
  parameters_json  TEXT    NOT NULL,
  code             TEXT    NOT NULL,
  allowed_domains  TEXT    NOT NULL DEFAULT '[]',
  agents           TEXT    NOT NULL DEFAULT '[]',
  version          INTEGER NOT NULL DEFAULT 1,
  status           TEXT    NOT NULL DEFAULT 'review', -- review | pending_approval | active | rejected
  review_notes     TEXT,
  created_by       TEXT    NOT NULL,
  created_at       INTEGER NOT NULL
);

-- Model scouting and evals.
CREATE TABLE IF NOT EXISTS seen_models (
  id          TEXT PRIMARY KEY,
  first_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent        TEXT    NOT NULL,
  model        TEXT    NOT NULL,
  personality  TEXT,
  score        REAL    NOT NULL,
  metrics_json TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_runs ON eval_runs (agent, model, id DESC);
