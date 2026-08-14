import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { Server } from "http";
import { createDb } from "../src/db/db";
import { createApp } from "../src/app";
import { seedParentAndChild } from "../src/db/seed";

describe("Authorization boundaries", () => {
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  let parentAToken: string, childAId: string, childAToken: string;
  let parentBToken: string, childBId: string;

  beforeAll(async () => {
    db = createDb();
    const familyA = seedParentAndChild(db, "Parent A", "Child A");
    const familyB = seedParentAndChild(db, "Parent B", "Child B");
    parentAToken = familyA.parentToken;
    childAId = familyA.childId;
    childAToken = familyA.childToken;
    parentBToken = familyB.parentToken;
    childBId = familyB.childId;

    const app = createApp(db);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => server.close());

  const call = (path: string, token: string, opts: RequestInit = {}): Promise<any> =>
    fetch(`${baseUrl}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
    });

  it("rejects requests with no token", async () => {
    const res = await fetch(`${baseUrl}/children/${childAId}/balance`);
    expect(res.status).toBe(401);
  });

  it("rejects requests with a garbage token", async () => {
    const res = await call(`/children/${childAId}/balance`, "not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("a parent cannot create a task for another parent's child", async () => {
    const res = await call(`/children/${childBId}/tasks`, parentAToken, {
      method: "POST",
      body: JSON.stringify({ title: "Sneaky task", reward: 100 }),
    });
    expect(res.status).toBe(403);
  });

  it("a child cannot read another child's balance", async () => {
    const res = await call(`/children/${childBId}/balance`, childAToken);
    expect(res.status).toBe(403);
  });

  it("a child token cannot approve a task (parent-only action)", async () => {
    const createRes = await call(`/children/${childAId}/tasks`, parentAToken, {
      method: "POST",
      body: JSON.stringify({ title: "Homework", reward: 20 }),
    });
    const task = await createRes.json();

    await call(`/tasks/${task.id}/mark-done`, childAToken, { method: "POST" });

    const approveRes = await call(`/tasks/${task.id}/approve`, childAToken, { method: "POST" });
    expect(approveRes.status).toBe(403);
  });

  it("a parent cannot mark done / report usage (child-only actions)", async () => {
    const createRes = await call(`/children/${childAId}/tasks`, parentAToken, {
      method: "POST",
      body: JSON.stringify({ title: "Chores", reward: 20 }),
    });
    const task = await createRes.json();

    const markDoneRes = await call(`/tasks/${task.id}/mark-done`, parentAToken, { method: "POST" });
    expect(markDoneRes.status).toBe(403);

    const usageRes = await call(`/children/${childAId}/usage`, parentAToken, {
      method: "POST",
      body: JSON.stringify({ sessions: [{ clientSessionId: "x", appId: "YouTube", start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T10:05:00.000Z" }] }),
    });
    expect(usageRes.status).toBe(403);
  });

  it("full happy path works end-to-end with correct tokens", async () => {
    const createRes = await call(`/children/${childAId}/tasks`, parentAToken, {
      method: "POST",
      body: JSON.stringify({ title: "Read a book", reward: 25 }),
    });
    expect(createRes.status).toBe(201);
    const task = await createRes.json();

    expect((await call(`/tasks/${task.id}/mark-done`, childAToken, { method: "POST" })).status).toBe(200);
    expect((await call(`/tasks/${task.id}/approve`, parentAToken, { method: "POST" })).status).toBe(200);

    const balanceRes = await call(`/children/${childAId}/balance`, childAToken);
    expect((await balanceRes.json()).balance).toBe(25);
  });
});
