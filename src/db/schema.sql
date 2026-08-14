-- RewardBank schema
-- Design notes (see WRITEUP.md for full reasoning):
--  * ledger_entries is append-only. Application code never UPDATEs or DELETEs a row here.
--  * balance is NEVER stored as a mutable counter. It is always derived from ledger_entries.
--    (children.balance_cache exists purely as a fast-read optimization; it is only ever
--    written inside the same transaction as the ledger insert that justifies it, so it can
--    never drift from SUM(ledger_entries.amount) — and our invariant test checks this directly.)
--  * usage_sessions has a UNIQUE(child_id, client_session_id) constraint. This is what makes
--    duplicate usage reports (device retries after a network error) a no-op instead of a
--    double-charge — see PART C of the writeup / README.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS parents (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS children (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT NOT NULL REFERENCES parents(id),
  name          TEXT NOT NULL,
  token         TEXT NOT NULL UNIQUE,
  balance_cache INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  child_id   TEXT NOT NULL REFERENCES children(id),
  title      TEXT NOT NULL,
  reward     INTEGER NOT NULL CHECK (reward > 0),
  status     TEXT NOT NULL CHECK (status IN ('pending','done','approved','rejected','undone')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_sessions (
  id                TEXT PRIMARY KEY,
  client_session_id TEXT NOT NULL,
  child_id          TEXT NOT NULL REFERENCES children(id),
  app_id            TEXT NOT NULL,
  start_ts          TEXT NOT NULL,
  end_ts            TEXT NOT NULL,
  received_at       TEXT NOT NULL,
  minutes_covered   INTEGER NOT NULL,       -- how many of the requested minutes were actually spendable
  exhausted_at      TEXT,                   -- NULL if balance fully covered the session
  UNIQUE (child_id, client_session_id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                 TEXT PRIMARY KEY,
  child_id           TEXT NOT NULL REFERENCES children(id),
  type               TEXT NOT NULL CHECK (type IN ('task_approved','usage_spent','approval_reversed')),
  amount             INTEGER NOT NULL,      -- positive = credit, negative = debit
  caused_by          TEXT NOT NULL,         -- task id, usage_session id, or parent id (for reversal)
  resulting_balance  INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  seq                INTEGER                -- monotonically increasing, set by trigger below; used for stable ordering
);

CREATE INDEX IF NOT EXISTS idx_ledger_child ON ledger_entries(child_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_child ON tasks(child_id);
CREATE INDEX IF NOT EXISTS idx_usage_child ON usage_sessions(child_id);

-- seq gives us a reliable "arrival order" independent of created_at string collisions
CREATE TABLE IF NOT EXISTS ledger_seq (n INTEGER NOT NULL);
INSERT INTO ledger_seq (n) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM ledger_seq);

-- Enforce true immutability at the DB layer, not just "please don't" in app code.
CREATE TRIGGER IF NOT EXISTS forbid_ledger_update
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER IF NOT EXISTS forbid_ledger_delete
BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only: DELETE is forbidden');
END;
