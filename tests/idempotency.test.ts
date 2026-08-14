import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createDb } from "../src/db/db";
import { seedParentAndChild } from "../src/db/seed";
import { createTask, markDone, approveTask, reportUsageBatch, getBalance, getLedger } from "../src/services/ledgerService";

describe("Idempotency", () => {
  let db: Database.Database;
  let childId: string;

  beforeEach(() => {
    db = createDb();
    childId = seedParentAndChild(db).childId;
  });

  it("a parent double-clicking Approve (two identical requests) credits the balance only once", () => {
    const t = createTask(db, childId, "Homework", 30);
    markDone(db, t.id);

    const first = approveTask(db, t.id);
    const second = approveTask(db, t.id); // simulates the second click 200ms later

    expect(first.ledgerEntry?.id).toBeTruthy();
    expect(second.ledgerEntry?.id).toBe(first.ledgerEntry?.id); // same entry returned, not a new one
    expect(getBalance(db, childId)).toBe(30); // credited exactly once

    const ledger = getLedger(db, childId);
    expect(ledger.filter((e) => e.caused_by === t.id)).toHaveLength(1);
  });

  it("a device retrying a usage report (lost response, same clientSessionId) does not double-spend", () => {
    const t = createTask(db, childId, "Homework", 30);
    markDone(db, t.id);
    approveTask(db, t.id); // balance 30

    const session = { clientSessionId: "abc-123", appId: "YouTube", start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T10:15:00.000Z" };

    const first = reportUsageBatch(db, childId, [session]);
    const retry = reportUsageBatch(db, childId, [session]); // exact same request, resent

    expect(first[0].minutesCovered).toBe(15);
    expect(retry[0].duplicate).toBe(true);
    expect(retry[0].minutesCovered).toBe(15); // reports the SAME result, doesn't spend again
    expect(getBalance(db, childId)).toBe(15); // only charged once
  });

  it("two DIFFERENT sessions with identical timestamps are NOT treated as duplicates of each other", () => {
    const t = createTask(db, childId, "Homework", 30);
    markDone(db, t.id);
    approveTask(db, t.id); // balance 30

    const results = reportUsageBatch(db, childId, [
      { clientSessionId: "session-a", appId: "YouTube", start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T10:10:00.000Z" },
      { clientSessionId: "session-b", appId: "Chrome", start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T10:10:00.000Z" },
    ]);

    expect(results[0].minutesCovered).toBe(10);
    expect(results[1].minutesCovered).toBe(10); // both charged — different real sessions
    expect(getBalance(db, childId)).toBe(10); // 30 - 10 - 10
  });
});
