export interface Parent {
  id: string;
  name: string;
  token: string;
}

export interface Child {
  id: string;
  parent_id: string;
  name: string;
  token: string;
  balance_cache: number;
}

export type TaskStatus = "pending" | "done" | "approved" | "rejected" | "undone";

export interface Task {
  id: string;
  child_id: string;
  title: string;
  reward: number;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export type LedgerType = "task_approved" | "usage_spent" | "approval_reversed";

export interface LedgerEntry {
  id: string;
  child_id: string;
  type: LedgerType;
  amount: number;
  caused_by: string;
  resulting_balance: number;
  created_at: string;
  seq: number;
}

export interface UsageSessionInput {
  clientSessionId: string;
  appId: string;
  start: string; // ISO timestamp
  end: string;   // ISO timestamp
}

export interface UsageSessionResult {
  clientSessionId: string;
  appId: string;
  requestedMinutes: number;
  minutesCovered: number;
  exhaustedAt: string | null;
  duplicate: boolean; // true if this session had already been processed before
}

// Extend Express's Request type with the identity our auth middleware attaches.
declare global {
  namespace Express {
    interface Request {
      auth?: {
        role: "parent" | "child";
        parentId?: string;
        childId?: string;
      };
    }
  }
}
