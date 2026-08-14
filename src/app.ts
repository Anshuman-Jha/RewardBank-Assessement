import express, { Express, Request, Response, NextFunction } from "express";
import Database from "better-sqlite3";
import { authenticate } from "./middleware/auth";
import { taskRoutes } from "./routes/tasks";
import { childDataRoutes } from "./routes/childData";

export function createApp(db: Database.Database): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use(authenticate(db));
  app.use(taskRoutes(db));
  app.use(childDataRoutes(db));

  // Central error handler — keeps route handlers free of repetitive try/catch noise.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
