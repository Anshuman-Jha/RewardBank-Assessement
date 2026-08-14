import Database from "better-sqlite3";
import { newId, nowIso } from "../utils/id";
import { nextSeq } from "../db/db";
import {
  Task,
  LedgerEntry,
  LedgerType,
  UsageSessionInput,
  UsageSessionResult,
} from "../types";

/**
 * WHY THIS FILE IS STRUCTURED THIS WAY
 * -------------------------------------
 * better-sqlite3 is synchronous. Combined with wrapping every mutation in
 * db.transaction(...), this means: within one Node process, there is no way
 * for two requests to interleave in the middle of a balance read-modify-write.
 * Request B literally cannot start its transaction until request A's has
 * committed. That is what makes the ledger invariant hold under concurrent
 * requests without any manual locking — the "serialize writes per child"
 * guarantee from the design falls out of this for free at single-process
 * scale. (At multi-process/100k-child scale this stops being true and you'd
 * need row-level locking or per-child sharding — see WRITEUP.md.)
 *
 * Balance is never trusted from children.balance_cache alone — it's written
 * transactionally alongside every ledger insert, and getBalance() below reads
 * it back plus we provide verifyInvariant() for tests to independently prove
 * balance_cache == SUM(ledger_entries.amount) at any point in time.
 */

export class LedgerError extends Error { }

function insertLedgerEntry(
  db: Database.Database,
  childId: string,
  type: LedgerType,
  amount: number,
  causedBy: string
): LedgerEntry {
  const child = db.prepare("SELECT balance_cache FROM children WHERE id = ?").get(childId) as
    | { balance_cache: number }
    | undefined;
  if (!child) throw new LedgerError(`Unknown child ${childId}`);

  const resultingBalance = child.balance_cache + amount;
  const entry: LedgerEntry = {
    id: newId("ledger"),
    child_id: childId,
    type,
    amount,
    caused_by: causedBy,
    resulting_balance: resultingBalance,
    created_at: nowIso(),
    seq: nextSeq(db),
  };

  db.prepare(
    `INSERT INTO ledger_entries (id, child_id, type, amount, caused_by, resulting_balance, created_at, seq)
     VALUES (@id, @child_id, @type, @amount, @caused_by, @resulting_balance, @created_at, @seq)`
  ).run(entry);

  db.prepare("UPDATE children SET balance_cache = ? WHERE id = ?").run(resultingBalance, childId);

  return entry;
}

export function getBalance(db: Database.Database, childId: string): number {
  const row = db.prepare("SELECT balance_cache FROM children WHERE id = ?").get(childId) as
    | { balance_cache: number }
    | undefined;
  if (!row) throw new LedgerError(`Unknown child ${childId}`);
  return row.balance_cache;
}

export function getLedger(db: Database.Database, childId: string): LedgerEntry[] {
  return db
    .prepare("SELECT * FROM ledger_entries WHERE child_id = ? ORDER BY seq ASC")
    .all(childId) as LedgerEntry[];
}

/** Independently proves the invariant: cached balance must equal SUM of ledger amounts. Used by tests. */
export function verifyInvariant(db: Database.Database, childId: string): { cached: number; summed: number; holds: boolean } {
  const cached = getBalance(db, childId);
  const row = db
    .prepare("SELECT COALESCE(SUM(amount), 0) as total FROM ledger_entries WHERE child_id = ?")
    .get(childId) as { total: number };
  return { cached, summed: row.total, holds: cached === row.total };
}

// Tasks

export function createTask(db: Database.Database, childId: string, title: string, reward: number): Task {
  const task: Task = {
    id: newId("task"),
    child_id: childId,
    title,
    reward,
    status: "pending",
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO tasks (id, child_id, title, reward, status, created_at, updated_at)
     VALUES (@id, @child_id, @title, @reward, @status, @created_at, @updated_at)`
  ).run(task);
  return task;
}

export function markDone(db: Database.Database, taskId: string): Task {
  return db.transaction(() => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task | undefined;
    if (!task) throw new LedgerError("Task not found");
    if (task.status !== "pending") {
      // Idempotent-ish: marking an already-done task done again is a no-op, not an error.
      if (task.status === "done") return task;
      throw new LedgerError(`Cannot mark done: task is '${task.status}'`);
    }
    db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").run(nowIso(), taskId);
    return { ...task, status: "done" as const };
  })();
}

/**
 * Approve is idempotent BY DESIGN: task.status is itself the idempotency key.
 * A double-click that sends two identical approve requests 200ms apart hits
 * this function twice; the second call sees status is already 'approved' and
 * returns the existing task/ledger state WITHOUT crediting again.
 */
export function approveTask(db: Database.Database, taskId: string): { task: Task; ledgerEntry: LedgerEntry | null } {
  return db.transaction(() => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task | undefined;
    if (!task) throw new LedgerError("Task not found");

    if (task.status === "approved") {
      // Already approved — this is the double-click case. Return prior state, no new credit.
      const existingEntry = db
        .prepare("SELECT * FROM ledger_entries WHERE caused_by = ? AND type = 'task_approved'")
        .get(taskId) as LedgerEntry | undefined;
      return { task, ledgerEntry: existingEntry ?? null };
    }

    if (task.status !== "done") {
      throw new LedgerError(`Cannot approve: task is '${task.status}', must be 'done'`);
    }

    const entry = insertLedgerEntry(db, task.child_id, "task_approved", task.reward, taskId);
    db.prepare("UPDATE tasks SET status = 'approved', updated_at = ? WHERE id = ?").run(nowIso(), taskId);

    return { task: { ...task, status: "approved" as const }, ledgerEntry: entry };
  })();
}

export function rejectTask(db: Database.Database, taskId: string): Task {
  return db.transaction(() => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task | undefined;
    if (!task) throw new LedgerError("Task not found");
    if (task.status === "rejected") return task; // idempotent
    if (task.status !== "done") {
      throw new LedgerError(`Cannot reject: task is '${task.status}', must be 'done'`);
    }
    db.prepare("UPDATE tasks SET status = 'rejected', updated_at = ? WHERE id = ?").run(nowIso(), taskId);
    return { ...task, status: "rejected" as const };
  })();
}

/**
 * Undo approval — see WRITEUP.md for the full "debt / soft-negative" reasoning.
 * We ALWAYS insert a new reversal ledger entry (never touch the original
 * 'task_approved' entry — the ledger is immutable). Balance is allowed to go
 * negative here; we do NOT block or throw just because it would. Blocking new
 * usage while negative is enforced separately, in reportUsageBatch.
 */
export function undoApproval(db: Database.Database, taskId: string, parentId: string): { task: Task; ledgerEntry: LedgerEntry | null } {
  return db.transaction(() => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task | undefined;
    if (!task) throw new LedgerError("Task not found");

    if (task.status === "undone") {
      const existingEntry = db
        .prepare("SELECT * FROM ledger_entries WHERE caused_by = ? AND type = 'approval_reversed'")
        .get(taskId) as LedgerEntry | undefined;
      return { task, ledgerEntry: existingEntry ?? null };
    }

    if (task.status !== "approved") {
      throw new LedgerError(`Cannot undo: task is '${task.status}', must be 'approved'`);
    }

    const entry = insertLedgerEntry(db, task.child_id, "approval_reversed", -task.reward, taskId);
    db.prepare("UPDATE tasks SET status = 'undone', updated_at = ? WHERE id = ?").run(nowIso(), taskId);

    return { task: { ...task, status: "undone" as const }, ledgerEntry: entry };
  })();
}

// ---------------------------------------------------------------------------
// Usage sessions
// ---------------------------------------------------------------------------

function minutesBetween(startIso: string, endIso: string): number {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Math.max(0, Math.round(ms / 60000));
}

/**
 * Reports ONE usage session. Idempotent via UNIQUE(child_id, client_session_id):
 * if this exact session was already processed (device retry after a lost
 * response), the INSERT into usage_sessions fails on the unique constraint and
 * we return the ORIGINAL result without spending anything a second time.
 *
 * If balance is negative or zero (see undoApproval), no new usage is covered
 * at all — minutesCovered = 0, exhaustedAt = the session's own start time.
 */
function reportOneSession(db: Database.Database, childId: string, session: UsageSessionInput): UsageSessionResult {
  return db.transaction(() => {
    const requestedMinutes = minutesBetween(session.start, session.end);

    // Idempotency check first — cheapest path, and avoids re-deriving anything.
    const existing = db
      .prepare("SELECT * FROM usage_sessions WHERE child_id = ? AND client_session_id = ?")
      .get(childId, session.clientSessionId) as
      | { minutes_covered: number; exhausted_at: string | null; app_id: string }
      | undefined;

    if (existing) {
      return {
        clientSessionId: session.clientSessionId,
        appId: existing.app_id,
        requestedMinutes,
        minutesCovered: existing.minutes_covered,
        exhaustedAt: existing.exhausted_at,
        duplicate: true,
      };
    }

    const balance = getBalance(db, childId);
    const receivedAt = nowIso();
    const sessionRowId = newId("session");

    if (balance <= 0 || requestedMinutes === 0) {
      db.prepare(
        `INSERT INTO usage_sessions
           (id, client_session_id, child_id, app_id, start_ts, end_ts, received_at, minutes_covered, exhausted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
      ).run(sessionRowId, session.clientSessionId, childId, session.appId, session.start, session.end, receivedAt, session.start);

      return {
        clientSessionId: session.clientSessionId,
        appId: session.appId,
        requestedMinutes,
        minutesCovered: 0,
        exhaustedAt: session.start,
        duplicate: false,
      };
    }

    const minutesCovered = Math.min(balance, requestedMinutes);
    const fullyCovered = minutesCovered === requestedMinutes;

    // Exact timestamp the balance ran out, within THIS session's own window —
    // start + however many minutes were actually payable.
    const exhaustedAt = fullyCovered
      ? null
      : new Date(new Date(session.start).getTime() + minutesCovered * 60000).toISOString();

    insertLedgerEntry(db, childId, "usage_spent", -minutesCovered, sessionRowId);

    db.prepare(
      `INSERT INTO usage_sessions
         (id, client_session_id, child_id, app_id, start_ts, end_ts, received_at, minutes_covered, exhausted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionRowId, session.clientSessionId, childId, session.appId, session.start, session.end, receivedAt, minutesCovered, exhaustedAt);

    return {
      clientSessionId: session.clientSessionId,
      appId: session.appId,
      requestedMinutes,
      minutesCovered,
      exhaustedAt,
      duplicate: false,
    };
  })();
}

/**
 * Processes a batch in ARRIVAL ORDER (array order = the order the device/API
 * client sent them), not sorted by start/end time. See WRITEUP.md for why:
 * late-arriving offline sessions spend against balance as of now, not as of
 * when they happened, so the ledger never has to rewrite history.
 * Each session is its own transaction, so a failure partway through a batch
 * doesn't roll back sessions already successfully processed.
 */
export function reportUsageBatch(db: Database.Database, childId: string, sessions: UsageSessionInput[]): UsageSessionResult[] {
  return sessions.map((s) => reportOneSession(db, childId, s));
}
