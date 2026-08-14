import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

/**
 * Creates a fresh, fully-migrated SQLite database.
 *
 * dbPath defaults to in-memory (":memory:") which is perfect for tests and the
 * simulator — every run starts clean. Pass a file path (e.g. "rewardbank.db")
 * for a persistent server instance.
 */
export function createDb(dbPath: string = ":memory:"): Database.Database {
  const db = new Database(dbPath);

  // WAL mode + a busy timeout make concurrent writers behave sanely instead of
  // throwing SQLITE_BUSY under load. Irrelevant for :memory: but harmless.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);

  return db;
}

/** Returns the next ledger sequence number, incrementing the counter. Call ONLY inside a transaction. */
export function nextSeq(db: Database.Database): number {
  const row = db.prepare("UPDATE ledger_seq SET n = n + 1 RETURNING n").get() as { n: number };
  return row.n;
}
