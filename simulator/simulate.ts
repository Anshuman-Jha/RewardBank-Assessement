
import { createDb } from "../src/db/db";
import { createApp } from "../src/app";
import { seedParentAndChild } from "../src/db/seed";

async function main() {
  const db = createDb(); // fresh in-memory DB each run
  const { parentToken, childId, childToken } = seedParentAndChild(db, "Sam (Parent)", "Alex (Kid)");
  const app = createApp(db);
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://localhost:${port}`;

  const asParent = (path: string, opts: RequestInit = {}): Promise<any> =>
    fetch(`${base}${path}`, { ...opts, headers: { Authorization: `Bearer ${parentToken}`, "Content-Type": "application/json", ...(opts.headers || {}) } }).then((r) => r.json());

  const asChild = (path: string, opts: RequestInit = {}): Promise<any> =>
    fetch(`${base}${path}`, { ...opts, headers: { Authorization: `Bearer ${childToken}`, "Content-Type": "application/json", ...(opts.headers || {}) } }).then((r) => r.json());

  const log = (msg: string) => console.log(`\n### ${msg}`);
  const showBalance = async () => console.log("  balance ->", (await asChild(`/children/${childId}/balance`)).balance);

  // ---------------------------------------------------------------------
  log("SCENARIO 1: Normal day");
  // ---------------------------------------------------------------------
  const homework = await asParent(`/children/${childId}/tasks`, { method: "POST", body: JSON.stringify({ title: "Finish homework", reward: 30 }) });
  const chores = await asParent(`/children/${childId}/tasks`, { method: "POST", body: JSON.stringify({ title: "Clean room", reward: 20 }) });

  await asChild(`/tasks/${homework.id}/mark-done`, { method: "POST" });
  await asParent(`/tasks/${homework.id}/approve`, { method: "POST" });
  console.log("  approved homework (+30)"); await showBalance();

  await asChild(`/tasks/${chores.id}/mark-done`, { method: "POST" });
  await asParent(`/tasks/${chores.id}/reject`, { method: "POST" }); // parent says room wasn't actually clean
  console.log("  rejected chores (no credit)"); await showBalance();

  const usage1 = await asChild(`/children/${childId}/usage`, {
    method: "POST",
    body: JSON.stringify({ sessions: [{ clientSessionId: "yt-1", appId: "YouTube", start: "2026-01-01T16:00:00.000Z", end: "2026-01-01T16:20:00.000Z" }] }),
  });
  console.log("  used YouTube for 20 min:", usage1.results[0]); await showBalance();

  // ---------------------------------------------------------------------
  log("SCENARIO 2: Everything goes wrong");
  // ---------------------------------------------------------------------

  // 2a. Parent double-clicks Approve on a new task, 200ms apart.
  const bigTask = await asParent(`/children/${childId}/tasks`, { method: "POST", body: JSON.stringify({ title: "Mow the lawn", reward: 40 }) });
  await asChild(`/tasks/${bigTask.id}/mark-done`, { method: "POST" });
  const [approveA, approveB] = await Promise.all([
    asParent(`/tasks/${bigTask.id}/approve`, { method: "POST" }),
    new Promise<any>((resolve) => setTimeout(() => resolve(asParent(`/tasks/${bigTask.id}/approve`, { method: "POST" })), 200)),
  ]);
  console.log("  double-clicked approve twice — credited once:", approveA.ledgerEntry?.amount, approveB.ledgerEntry?.amount);
  await showBalance();

  // 2b. Device goes offline, comes back with a stale + a duplicate-retry session.
  const lateSessionId = "offline-session-1";
  const lateSession = { clientSessionId: lateSessionId, appId: "Minecraft", start: "2026-01-01T09:10:00.000Z", end: "2026-01-01T09:45:00.000Z" };
  const first = await asChild(`/children/${childId}/usage`, { method: "POST", body: JSON.stringify({ sessions: [lateSession] }) });
  console.log("  late offline session (35 min) arrives now:", first.results[0]);
  const retry = await asChild(`/children/${childId}/usage`, { method: "POST", body: JSON.stringify({ sessions: [lateSession] }) }); // device retries same session
  console.log("  device retried same session (no double-charge):", retry.results[0]);
  await showBalance();

  // 2c. Two overlapping sessions reported together that exceed remaining balance.
  const before = (await asChild(`/children/${childId}/balance`)).balance;
  console.log(`  balance before overlap test: ${before}`);
  const overlap = await asChild(`/children/${childId}/usage`, {
    method: "POST",
    body: JSON.stringify({
      sessions: [
        { clientSessionId: "overlap-a", appId: "YouTube", start: "2026-01-01T18:00:00.000Z", end: "2026-01-01T18:30:00.000Z" },
        { clientSessionId: "overlap-b", appId: "TikTok", start: "2026-01-01T18:00:00.000Z", end: "2026-01-01T18:30:00.000Z" },
      ],
    }),
  });
  console.log("  overlapping sessions result:", overlap.results);
  await showBalance();

  // 2d. Parent undoes an old approval after minutes were already spent -> negative balance / debt.
  const undo = await asParent(`/tasks/${homework.id}/undo-approval`, { method: "POST" });
  console.log("  undid homework approval after minutes spent:", undo.ledgerEntry);
  await showBalance();

  // 2e. New usage attempted while balance is negative — must be fully blocked.
  const blocked = await asChild(`/children/${childId}/usage`, {
    method: "POST",
    body: JSON.stringify({ sessions: [{ clientSessionId: "blocked-1", appId: "Roblox", start: "2026-01-01T19:00:00.000Z", end: "2026-01-01T19:10:00.000Z" }] }),
  });
  console.log("  usage attempted while in debt (should be 0 covered):", blocked.results[0]);
  await showBalance();

  // 2f. CORRUPTED RETRY: device reuses "offline-session-1"'s ID but with totally
  // different content (a real device bug or tampering) — must be flagged as a
  // conflict and NOT charged, unlike a genuine retry.
  const corrupted = await asChild(`/children/${childId}/usage`, {
    method: "POST",
    body: JSON.stringify({ sessions: [{ clientSessionId: lateSessionId, appId: "Fortnite", start: "2026-01-01T20:00:00.000Z", end: "2026-01-01T20:45:00.000Z" }] }),
  });
  console.log("  CORRUPTED retry (same id, different app/time):", corrupted.results[0]);
  await showBalance(); // must be unchanged from before this call

  // 2g. MALFORMED SESSION: device clock skew sends end BEFORE start.
  const malformed = await asChild(`/children/${childId}/usage`, {
    method: "POST",
    body: JSON.stringify({ sessions: [{ clientSessionId: "backwards-clock", appId: "Chrome", start: "2026-01-01T21:00:00.000Z", end: "2026-01-01T20:30:00.000Z" }] }),
  });
  console.log("  malformed session (end before start):", malformed.results[0]);
  await showBalance(); // must be unchanged

  // 2h. INVALID STATE TRANSITIONS, hammered on purpose — every one of these must
  // fail cleanly with a 4xx, never crash the server.
  const rejectAlreadyApprovedRes = await fetch(`${base}/tasks/${homework.id}/reject`, {
    method: "POST", headers: { Authorization: `Bearer ${parentToken}` },
  });
  console.log(`  reject an already-undone task -> HTTP ${rejectAlreadyApprovedRes.status} (expected 4xx, not a crash)`);

  const reapproveUndoneRes = await fetch(`${base}/tasks/${homework.id}/approve`, {
    method: "POST", headers: { Authorization: `Bearer ${parentToken}` },
  });
  console.log(`  re-approve an already-undone task -> HTTP ${reapproveUndoneRes.status} (expected 4xx, not a double-credit)`);

  // 2i. TRUE CONCURRENCY: fire an undo-approval and a usage report for the SAME
  // task/child at the literal same instant — the real test of whether writes
  // are actually serialized per child, not just "usually fine in practice".
  const raceTask = await asParent(`/children/${childId}/tasks`, { method: "POST", body: JSON.stringify({ title: "Race condition bait", reward: 15 }) });
  await asChild(`/tasks/${raceTask.id}/mark-done`, { method: "POST" });
  await asParent(`/tasks/${raceTask.id}/approve`, { method: "POST" });
  const balanceBeforeRace = (await asChild(`/children/${childId}/balance`)).balance;
  await Promise.all([
    asParent(`/tasks/${raceTask.id}/undo-approval`, { method: "POST" }),
    asChild(`/children/${childId}/usage`, {
      method: "POST",
      body: JSON.stringify({ sessions: [{ clientSessionId: "race-session", appId: "Spotify", start: "2026-01-01T22:00:00.000Z", end: "2026-01-01T22:05:00.000Z" }] }),
    }),
  ]);
  console.log(`  fired undo-approval + usage-report simultaneously (balance was ${balanceBeforeRace} before)`);
  await showBalance();

  // 2j. MEGA-BATCH: one single request mixing a duplicate, an overlap, a
  // malformed session, and a post-exhaustion session all at once.
  const megaBatch = await asChild(`/children/${childId}/usage`, {
    method: "POST",
    body: JSON.stringify({
      sessions: [
        { clientSessionId: "mega-a", appId: "YouTube", start: "2026-01-02T09:00:00.000Z", end: "2026-01-02T09:05:00.000Z" },
        { clientSessionId: "mega-a", appId: "YouTube", start: "2026-01-02T09:00:00.000Z", end: "2026-01-02T09:05:00.000Z" }, // dup within same request
        { clientSessionId: "mega-b", appId: "Minecraft", start: "2026-01-02T09:00:00.000Z", end: "2026-01-02T09:10:00.000Z" }, // overlaps mega-a
        { clientSessionId: "mega-c", appId: "Roblox", start: "2026-01-02T10:00:00.000Z", end: "2026-01-02T09:55:00.000Z" }, // malformed
      ],
    }),
  });
  console.log("  mega-batch (dup + overlap + malformed, one request):", megaBatch.results);
  await showBalance();

  // 2f (final). Final proof: full ledger dump, human-checkable that it sums to the balance shown.
  log("Final ledger for audit");
  const ledger = await asChild(`/children/${childId}/ledger`);
  console.table(ledger.ledger.map((e: any) => ({ type: e.type, amount: e.amount, resulting_balance: e.resulting_balance, caused_by: e.caused_by })));
  const sum = ledger.ledger.reduce((acc: number, e: any) => acc + e.amount, 0);
  const finalBalance = (await asChild(`/children/${childId}/balance`)).balance;
  console.log(`\nSUM(ledger) = ${sum}, live balance = ${finalBalance}, invariant holds: ${sum === finalBalance}`);

  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});