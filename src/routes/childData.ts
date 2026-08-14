import { Router } from "express";
import Database from "better-sqlite3";
import { requireChild, requireOwnsChild } from "../middleware/auth";
import { reportUsageBatch, getBalance, getLedger } from "../services/ledgerService";
import { usageBatchSchema } from "./schemas";

export function childDataRoutes(db: Database.Database): Router {
  const router = Router();

  // Only the device (acting as the child) reports usage — a parent doesn't report usage.
  router.post("/children/:childId/usage", requireChild, requireOwnsChild(db), (req, res) => {
    const parsed = usageBatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const results = reportUsageBatch(db, req.params.childId, parsed.data.sessions);
    res.json({ results });
  });

  // Either the child themself, or their parent, can read balance/ledger.
  router.get("/children/:childId/balance", requireOwnsChild(db), (req, res) => {
    res.json({ childId: req.params.childId, balance: getBalance(db, req.params.childId) });
  });

  router.get("/children/:childId/ledger", requireOwnsChild(db), (req, res) => {
    res.json({ childId: req.params.childId, ledger: getLedger(db, req.params.childId) });
  });

  return router;
}
