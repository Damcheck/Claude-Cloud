-- Council OS: persistent project worlds, social dynamics, reputation, replay and simulations.

CREATE TABLE IF NOT EXISTS project_worlds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'active', -- active | archived
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (conv_id, name)
);

CREATE TABLE IF NOT EXISTS project_world_state (
  conv_id     INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_relationships (
  conv_id       INTEGER NOT NULL,
  project_id    INTEGER NOT NULL,
  source_agent  TEXT    NOT NULL,
  target_agent  TEXT    NOT NULL,
  trust         REAL    NOT NULL DEFAULT 50,
  respect       REAL    NOT NULL DEFAULT 50,
  tension       REAL    NOT NULL DEFAULT 10,
  interactions  INTEGER NOT NULL DEFAULT 0,
  last_reason   TEXT    NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (conv_id, project_id, source_agent, target_agent)
);

CREATE TABLE IF NOT EXISTS agent_reputation (
  conv_id       INTEGER NOT NULL,
  project_id    INTEGER NOT NULL,
  agent         TEXT    NOT NULL,
  accuracy      REAL    NOT NULL DEFAULT 50,
  usefulness    REAL    NOT NULL DEFAULT 50,
  creativity    REAL    NOT NULL DEFAULT 50,
  reliability   REAL    NOT NULL DEFAULT 50,
  founder_score INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (conv_id, project_id, agent)
);

CREATE TABLE IF NOT EXISTS reputation_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL,
  project_id  INTEGER NOT NULL,
  agent       TEXT    NOT NULL,
  dimension   TEXT    NOT NULL,
  delta       REAL    NOT NULL,
  reason      TEXT    NOT NULL,
  ref_type    TEXT,
  ref_id      INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reputation_events ON reputation_events (conv_id, project_id, id DESC);

CREATE TABLE IF NOT EXISTS meeting_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id        INTEGER NOT NULL,
  project_id     INTEGER NOT NULL,
  discussion_id  INTEGER,
  kind           TEXT    NOT NULL, -- message | decision | claim | reaction | state | action
  actor          TEXT    NOT NULL,
  target         TEXT,
  text           TEXT    NOT NULL DEFAULT '',
  metadata_json  TEXT    NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meeting_events ON meeting_events (conv_id, project_id, id DESC);

CREATE TABLE IF NOT EXISTS simulations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id      INTEGER NOT NULL,
  project_id   INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  question     TEXT    NOT NULL,
  scenario     TEXT    NOT NULL DEFAULT 'war_room',
  status       TEXT    NOT NULL DEFAULT 'running', -- running | complete | stopped
  result_json  TEXT    NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS founder_profile (
  conv_id       INTEGER NOT NULL,
  key           TEXT    NOT NULL,
  value         TEXT    NOT NULL,
  confidence    REAL    NOT NULL DEFAULT 1,
  source        TEXT    NOT NULL DEFAULT 'founder',
  approved      INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (conv_id, key)
);

CREATE TABLE IF NOT EXISTS council_elections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id      INTEGER NOT NULL,
  project_id   INTEGER NOT NULL,
  office       TEXT    NOT NULL,
  candidates   TEXT    NOT NULL DEFAULT '[]',
  votes_json   TEXT    NOT NULL DEFAULT '{}',
  winner       TEXT,
  status       TEXT    NOT NULL DEFAULT 'open',
  closes_at    INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS local_operator_devices (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id           INTEGER NOT NULL,
  name              TEXT    NOT NULL,
  public_key         TEXT    NOT NULL,
  permissions_json  TEXT    NOT NULL DEFAULT '[]',
  status            TEXT    NOT NULL DEFAULT 'pending', -- pending | active | revoked
  last_seen_at       INTEGER,
  created_at         INTEGER NOT NULL
);
