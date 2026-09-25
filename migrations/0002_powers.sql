-- AI Council v2: hardening, agent powers, voice

-- Telegram may deliver the same update twice; each (bot, update_id) is processed once.
CREATE TABLE IF NOT EXISTS seen_updates (
  bot         TEXT    NOT NULL,
  update_id   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (bot, update_id)
);

-- Chats the council is active in (daily brief, voice-reply preference).
CREATE TABLE IF NOT EXISTS chats (
  conv_id        INTEGER PRIMARY KEY,
  chat_id        INTEGER NOT NULL,
  dm_agent       TEXT,
  brief_enabled  INTEGER NOT NULL DEFAULT 0,
  voice_replies  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

-- Token usage per agent turn (cost tracking and daily budgets).
CREATE TABLE IF NOT EXISTS usage (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id            INTEGER NOT NULL,
  agent              TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  day                TEXT    NOT NULL, -- YYYY-MM-DD (UTC)
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage (day, agent);

-- Risky skill calls waiting for the founder's ✅ / ❌.
CREATE TABLE IF NOT EXISTS approvals (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id              INTEGER NOT NULL,
  chat_id              INTEGER NOT NULL,
  agent                TEXT    NOT NULL,
  skill                TEXT    NOT NULL,
  args_json            TEXT    NOT NULL,
  summary              TEXT    NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'pending', -- pending | approved | rejected | failed
  result               TEXT,
  telegram_message_id  INTEGER,
  created_at           INTEGER NOT NULL,
  decided_at           INTEGER
);

-- Things agents scheduled for themselves.
CREATE TABLE IF NOT EXISTS followups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL,
  agent       TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'followup', -- followup | prediction_review | action_check | pr_review
  note        TEXT    NOT NULL,
  ref_id      INTEGER,
  due_at      INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending', -- pending | done | cancelled
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followups_due ON followups (conv_id, status, due_at);

-- Track record: predictions and positions agents commit to.
CREATE TABLE IF NOT EXISTS predictions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id       INTEGER NOT NULL,
  agent         TEXT    NOT NULL,
  claim         TEXT    NOT NULL,
  confidence    REAL    NOT NULL DEFAULT 0.5,
  check_at      INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'open', -- open | right | wrong | unclear
  outcome_note  TEXT,
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_predictions_agent ON predictions (agent, status);

-- Sage's claim ledger.
CREATE TABLE IF NOT EXISTS claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL,
  checked_by  TEXT    NOT NULL,
  claim       TEXT    NOT NULL,
  claimed_by  TEXT    NOT NULL,
  verdict     TEXT    NOT NULL, -- true | false | unclear
  source      TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_conv ON claims (conv_id, id DESC);

-- Nova's idea bank.
CREATE TABLE IF NOT EXISTS ideas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL,
  agent       TEXT    NOT NULL,
  idea        TEXT    NOT NULL,
  tags        TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- Nexus's action items.
CREATE TABLE IF NOT EXISTS action_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL,
  text        TEXT    NOT NULL,
  owner       TEXT    NOT NULL DEFAULT 'founder',
  due_at      INTEGER,
  status      TEXT    NOT NULL DEFAULT 'open', -- open | done
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  done_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_actions_conv ON action_items (conv_id, status);

-- Condensed memory of finished discussions.
CREATE TABLE IF NOT EXISTS discussion_summaries (
  discussion_id  INTEGER PRIMARY KEY,
  conv_id        INTEGER NOT NULL,
  summary        TEXT    NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_conv ON discussion_summaries (conv_id, created_at DESC);

-- Documents the founder sent (converted to markdown).
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  markdown    TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
