import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createDb } from "../src/db/db";
import { seedParentAndChild } from "../src/db/seed";
import { createTask, markDone, approveTask, undoApproval, rejectTask, reportUsageBatch, getBalance, LedgerError } from "../src/services/ledgerService";

describe("Balance exhaustion", () => {
  let db: Database.Database;
  let childId: string;

  beforeEach(() => {
    db = createDb();
    childId = seedParentAndChild(db).childId;
  });

  it("reports the exact timestamp within the session where balance ran out", () => {
    const t = createTask(db, childId, "Chores", 10);
    markDone(db, t.id);
    approveTask(db, t.id); // balance 10

    const [result] = reportUsageBatch(db, childId, [
      { clientSessionId: "s1", appId: "YouTube", start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T10:20:00.000Z" }, // wants 20, has 10
    ]);

    expect(result.minutesCovered).toBe(10);
    expect(result.exhaustedAt).toBe("2026-01-01T10:10:00.000Z"); // start + 10 min
  });

  it("a session requested after balance is already 0 is entirely uncovered, exhausted at its own start", () => {
    const [result] = reportUsageBatch(db, childId, [
      { clientSessionId: "s1", appId: "YouTube", start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T10:20:00.000Z" },
    ]);
    expect(result.minutesCovered).toBe(0);
    expect(result.exhaustedAt).toBe("2026-01-01T10:00:00.000Z");
  });

  it("two overlapping sessions together exceeding balance split it deterministically in arrival order", () => {
    const t = createTask(db, childId, "Chores", 20);
    markDone(db, t.id);
    approveTask(db, t.id); // balance 20

    const results = reportUsageBatch(db, childId, [
      { clientSessionId: "youtube-1", appId: "YouTube", start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T10:15:00.000Z" }, // 15
      { clientSessionId: "minecraft-1", appId: "Minecraft", start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T10:15:00.000Z" }, // 15, only 5 left
    ]);

    expect(results[0].minutesCovered).toBe(15); // processed first, fully covered
    expect(results[0].exhaustedAt).toBeNull();
    expect(results[1].minutesCovered).toBe(5); // only 5 of balance remained
    expect(results[1].exhaustedAt).toBe("2026-01-01T10:05:00.000Z");
    expect(getBalance(db, childId)).toBe(0);
  });
});

describe("Undo approval / debt behavior", () => {
  let db: Database.Database;
  let childId: string;

  beforeEach(() => {
    db = createDb();
    childId = seedParentAndChild(db).childId;
  });

  it("undo after minutes already spent drives balance negative rather than throwing", () => {
    const t = createTask(db, childId, "Chores", 30);
    markDone(db, t.id);
    approveTask(db, t.id); // balance 30

    reportUsageBatch(db, childId, [
      { clientSessionId: "s1", appId: "YouTube", start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T10:20:00.000Z" }, // -20, balance 10
    ]);

    undoApproval(db, t.id, "parent-1"); // -30, balance -20
    expect(getBalance(db, childId)).toBe(-20);
  });

  it("while balance is negative, no new usage is covered (blocked, not crashed)", () => {
    const t = createTask(db, childId, "Chores", 10);
    markDone(db, t.id);
    approveTask(db, t.id); // balance 10

    // Spend the 10 minutes down to 0 BEFORE undoing, so the undo actually has
    // something to push negative (undoing an untouched approval just returns
    // to 0, not negative — that's correct behavior, not a bug).
    reportUsageBatch(db, childId, [
      { clientSessionId: "spend-1", appId: "YouTube", start: "2026-01-01T09:00:00.000Z", end: "2026-01-01T09:10:00.000Z" },
    ]); // balance 0

    undoApproval(db, t.id, "parent-1"); // balance -10

    const [result] = reportUsageBatch(db, childId, [
      { clientSessionId: "s1", appId: "YouTube", start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T10:05:00.000Z" },
    ]);
    expect(result.minutesCovered).toBe(0);
    expect(getBalance(db, childId)).toBe(-10); // debt untouched, not made worse
  });

  it("undo is idempotent — undoing twice does not double-reverse", () => {
    const t = createTask(db, childId, "Chores", 10);
    markDone(db, t.id);
    approveTask(db, t.id); // balance 10

    reportUsageBatch(db, childId, [
      { clientSessionId: "spend-1", appId: "YouTube", start: "2026-01-01T09:00:00.000Z", end: "2026-01-01T09:10:00.000Z" },
    ]); // balance 0

    undoApproval(db, t.id, "parent-1"); // balance -10
    undoApproval(db, t.id, "parent-1"); // idempotent — must NOT reverse again
    expect(getBalance(db, childId)).toBe(-10); // not -20
  });

  it("cannot undo a task that was never approved", () => {
    const t = createTask(db, childId, "Chores", 10);
    markDone(db, t.id);
    rejectTask(db, t.id);
    expect(() => undoApproval(db, t.id, "parent-1")).toThrow(LedgerError);
  });

  it("cannot approve a task that is still pending (not marked done)", () => {
    const t = createTask(db, childId, "Chores", 10);
    expect(() => approveTask(db, t.id)).toThrow(LedgerError);
  });
});