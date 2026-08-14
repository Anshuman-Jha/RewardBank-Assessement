import { z } from "zod";

export const createTaskSchema = z.object({
  title: z.string().min(1),
  reward: z.number().int().positive(),
});

export const usageSessionSchema = z.object({
  clientSessionId: z.string().min(1),
  appId: z.string().min(1),
  start: z.string().datetime(),
  end: z.string().datetime(),
});

export const usageBatchSchema = z.object({
  sessions: z.array(usageSessionSchema).min(1),
});
