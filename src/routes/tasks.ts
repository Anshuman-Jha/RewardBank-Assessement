import { Router } from "express";
import Database from "better-sqlite3";
import { requireParent, requireChild, requireOwnsChild, requireOwnsTask } from "../middleware/auth";
import { createTask, markDone, approveTask, rejectTask, undoApproval, LedgerError } from "../services/ledgerService";
import { createTaskSchema } from "./schemas";

export function taskRoutes(db: Database.Database): Router {
  const router = Router();

  // Parent creates a task for a specific child. Ownership enforced via requireOwnsChild.
  router.post("/children/:childId/tasks", requireParent, requireOwnsChild(db), (req, res) => {
    const parsed = createTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const task = createTask(db, req.params.childId, parsed.data.title, parsed.data.reward);
    res.status(201).json(task);
  });

  // Child marks their own task as done. A child cannot mark another child's task done —
  // enforced by joining through the task's child_id to req.auth.childId.
  router.post("/tasks/:taskId/mark-done", requireChild, (req, res) => {
    const task = db.prepare("SELECT child_id FROM tasks WHERE id = ?").get(req.params.taskId) as
      | { child_id: string }
      | undefined;
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.child_id !== req.auth!.childId) {
      return res.status(403).json({ error: "Cannot modify another child's task" });
    }
    try {
      res.json(markDone(db, req.params.taskId));
    } catch (e) {
      if (e instanceof LedgerError) return res.status(409).json({ error: e.message });
      throw e;
    }
  });

  router.post("/tasks/:taskId/approve", requireOwnsTask(db), (req, res) => {
    try {
      const result = approveTask(db, req.params.taskId);
      res.json(result);
    } catch (e) {
      if (e instanceof LedgerError) return res.status(409).json({ error: e.message });
      throw e;
    }
  });

  router.post("/tasks/:taskId/reject", requireOwnsTask(db), (req, res) => {
    try {
      res.json(rejectTask(db, req.params.taskId));
    } catch (e) {
      if (e instanceof LedgerError) return res.status(409).json({ error: e.message });
      throw e;
    }
  });

  router.post("/tasks/:taskId/undo-approval", requireOwnsTask(db), (req, res) => {
    try {
      const result = undoApproval(db, req.params.taskId, req.auth!.parentId!);
      res.json(result);
    } catch (e) {
      if (e instanceof LedgerError) return res.status(409).json({ error: e.message });
      throw e;
    }
  });

  return router;
}
