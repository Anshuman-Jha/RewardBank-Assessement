import { Request, Response, NextFunction } from "express";
import Database from "better-sqlite3";
import { Parent, Child } from "../types";


export function authenticate(db: Database.Database) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : header;

    if (!token) {
      return res.status(401).json({ error: "Missing bearer token" });
    }

    const parent = db.prepare("SELECT * FROM parents WHERE token = ?").get(token) as Parent | undefined;
    if (parent) {
      req.auth = { role: "parent", parentId: parent.id };
      return next();
    }

    const child = db.prepare("SELECT * FROM children WHERE token = ?").get(token) as Child | undefined;
    if (child) {
      req.auth = { role: "child", childId: child.id };
      return next();
    }

    return res.status(401).json({ error: "Invalid token" });
  };
}

export function requireParent(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.role !== "parent") {
    return res.status(403).json({ error: "Parent token required" });
  }
  next();
}

export function requireChild(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.role !== "child") {
    return res.status(403).json({ error: "Child token required" });
  }
  next();
}


export function requireOwnsChild(db: Database.Database, childIdParam = "childId") {
  return (req: Request, res: Response, next: NextFunction) => {
    const childId = req.params[childIdParam];

    if (req.auth?.role === "child") {
      if (req.auth.childId !== childId) {
        return res.status(403).json({ error: "Cannot access another child's data" });
      }
      return next();
    }

    if (req.auth?.role === "parent") {
      const child = db
        .prepare("SELECT id FROM children WHERE id = ? AND parent_id = ?")
        .get(childId, req.auth.parentId);
      if (!child) {
        return res.status(403).json({ error: "Not your child" });
      }
      return next();
    }

    return res.status(403).json({ error: "Forbidden" });
  };
}


export function requireOwnsTask(db: Database.Database) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.auth?.role !== "parent") {
      return res.status(403).json({ error: "Parent token required" });
    }
    const task = db
      .prepare(
        `SELECT t.id FROM tasks t
         JOIN children c ON c.id = t.child_id
         WHERE t.id = ? AND c.parent_id = ?`
      )
      .get(req.params.taskId, req.auth.parentId);
    if (!task) {
      return res.status(403).json({ error: "Not your task" });
    }
    next();
  };
}
