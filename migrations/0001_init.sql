-- AI Council v1 schema

CREATE TABLE IF NOT EXISTS discussions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  mode        TEXT    NOT NULL,
  topic       TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'running', -- running | done | stopped | interrupted
  posts       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_discussions_chat ON discussions (chat_id, id DESC);

-- Level 1: conversation memory (every human and agent message)
CREATE TABLE IF NOT EXISTS messages (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id              INTEGER NOT NULL,
  discussion_id        INTEGER,
  speaker              TEXT    NOT NULL, -- 'human' or agent id
  speaker_name         TEXT    NOT NULL,
  text                 TEXT    NOT NULL,
  telegram_message_id  INTEGER,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, id DESC);

-- Level 2: group memory (facts every agent sees)
CREATE TABLE IF NOT EXISTS group_facts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  fact        TEXT    NOT NULL,
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_facts_chat ON group_facts (chat_id, id DESC);

-- Level 3: private agent memory (only the owning agent sees these)
CREATE TABLE IF NOT EXISTS agent_memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  agent       TEXT    NOT NULL,
  memory      TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_memories ON agent_memories (chat_id, agent, id DESC);

-- Level 4 (semantic memory) lives in Vectorize; see docs/SPEC.md phase 8.
