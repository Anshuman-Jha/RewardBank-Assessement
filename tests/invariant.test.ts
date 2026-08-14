import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createDb } from "../src/db/db";
import { seedParentAndChild } from "../src/db/seed";
import {
  createTask, markDone, approveTask, rejectTask, undoApproval,
  reportUsageBatch, getBalance, verifyInvariant,
} from "../src/services/ledgerService";

describe("Ledger invariant: cached balance always equals SUM(ledger_entries)", () => {
  let db: Database.Database;
  let childId: string;

  beforeEach(() => {
    db = createDb();
    childId = seedParentAndChild(db).childId;
  });

  it("holds after a single approve", () => {
    const t = createTask(db, childId, "Homework", 30);
    markDone(db, t.id);
    approveTask(db, t.id);
    const inv = verifyInvariant(db, childId);
    expect(inv.holds).toBe(true);
    expect(inv.cached).toBe(30);
  });

  it("holds across a long, complex, mixed sequence of operations", () => {
    // Approve 3 tasks, spend across several sessions (some duplicated, some
    // exceeding balance), reject one, undo one approval — then check the
    // invariant after EVERY single step, not just at the end.
    const checkAfterEachStep = () => {
      const inv = verifyInvariant(db, childId);
      expect(inv.holds, `invariant broke: cached=${inv.cached} summed=${inv.summed}`).toBe(true);
    };

    const t1 = createTask(db, childId, "Clean room", 30);
    markDone(db, t1.id); checkAfterEachStep();
    approveTask(db, t1.id); checkAfterEachStep(); // balance 30

    const t2 = createTask(db, childId, "Homework", 20);
    markDone(db, t2.id);
    approveTask(db, t2.id); checkAfterEachStep(); // balance 50

    const t3 = createTask(db, childId, "Dishes", 15);
    markDone(db, t3.id);
    rejectTask(db, t3.id); checkAfterEachStep(); // no change, balance 50

    reportUsageBatch(db, childId, [
      { clientSessionId: "s1", appId: "YouTube", start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T10:15:00.000Z" },
    ]); checkAfterEachStep(); // -15, balance 35

    // Duplicate report of s1 (device retry) — must NOT double-spend.
    reportUsageBatch(db, childId, [
      { clientSessionId: "s1", appId: "YouTube", start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T10:15:00.000Z" },
    ]); checkAfterEachStep();
    expect(getBalance(db, childId)).toBe(35);

    // Overlapping sessions that together exceed remaining balance (35 left).
    reportUsageBatch(db, childId, [
      { clientSessionId: "s2", appId: "YouTube", start: "2026-01-01T11:00:00.000Z", end: "2026-01-01T11:20:00.000Z" }, // 20
      { clientSessionId: "s3", appId: "Minecraft", start: "2026-01-01T11:00:00.000Z", end: "2026-01-01T11:25:00.000Z" }, // 25, only 15 left
    ]); checkAfterEachStep();
    expect(getBalance(db, childId)).toBe(0);

    // Undo t2's approval after minutes already spent — balance goes negative.
    undoApproval(db, t2.id, "parent-x"); checkAfterEachStep();
    expect(getBalance(db, childId)).toBe(-20);

    // Further usage while negative must be entirely blocked (0 minutes covered).
    const blocked = reportUsageBatch(db, childId, [
      { clientSessionId: "s4", appId: "Roblox", start: "2026-01-01T12:00:00.000Z", end: "2026-01-01T12:10:00.000Z" },
    ]);
    expect(blocked[0].minutesCovered).toBe(0);
    checkAfterEachStep();
    expect(getBalance(db, childId)).toBe(-20); // unchanged

    // Paying down the debt: approve a new task, minutes go toward the negative balance.
    const t4 = createTask(db, childId, "Vacuum", 25);
    markDone(db, t4.id);
    approveTask(db, t4.id); checkAfterEachStep();
    expect(getBalance(db, childId)).toBe(5); // -20 + 25
  });
});
