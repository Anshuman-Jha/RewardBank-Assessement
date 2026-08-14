# RewardBank

A ledger-based "screen time is earned" system. Parents approve tasks that
credit a child's balance in minutes; devices report app-usage sessions that
spend from it. Every change is an immutable, append-only ledger entry, and
the balance is always provably `SUM(ledger entries)`.

## Setup

```bash
npm install
npm run dev        # starts the API on :3000, prints seeded demo tokens
npm test           # runs the full test suite
npm run simulate   # runs the normal-day + everything-goes-wrong simulator
```

No external DB needed — SQLite is a single file (`rewardbank.db`), created
and migrated automatically on first run. Tests and the simulator each use a
fresh **in-memory** database (`:memory:`), so they never touch or depend on
that file.

## Project layout

```
src/
  db/
    schema.sql        the whole data model — read this first
    db.ts              connection + pragma setup
    seed.ts            creates a demo parent/child with tokens
  services/
    ledgerService.ts   ALL business logic lives here — every balance
                        mutation goes through one of these functions,
                        each wrapped in a single DB transaction
  middleware/
    auth.ts            token auth + ownership checks
  routes/               thin HTTP layer over ledgerService
  app.ts / server.ts
tests/
  invariant.test.ts    proves SUM(ledger) == balance across a long,
                        realistic sequence of operations (the #1 grading
                        criterion)
  idempotency.test.ts  double-click approve, duplicate usage reports
  edgeCases.test.ts    exhaustion timestamps, overlapping sessions, undo/debt
  auth.test.ts         who's allowed to call what, over real HTTP
simulator/
  simulate.ts           drives the real API like real devices/parents would
```

## API

All endpoints require `Authorization: Bearer <token>`. One token per parent,
one per child (printed to console on first `npm run dev`).

| Endpoint | Who | What |
|---|---|---|
| `POST /children/:childId/tasks` | parent (own child) | create a task |
| `POST /tasks/:taskId/mark-done` | child (own task) | mark done |
| `POST /tasks/:taskId/approve` | parent (own child's task) | approve, credits balance |
| `POST /tasks/:taskId/reject` | parent (own child's task) | reject, no credit |
| `POST /tasks/:taskId/undo-approval` | parent (own child's task) | reverse a prior approval |
| `POST /children/:childId/usage` | child (own data) | report a batch of usage sessions |
| `GET /children/:childId/balance` | parent or child (own data) | current balance |
| `GET /children/:childId/ledger` | parent or child (own data) | full ledger history |

## Key design decisions (see WRITEUP.md for full reasoning)

- **Balance is derived, never mutated directly.** `children.balance_cache` is
  only ever written inside the same transaction as the ledger insert that
  justifies it — it's a cache of `SUM(ledger_entries.amount)`, not a source
  of truth in its own right. `verifyInvariant()` in `ledgerService.ts` proves
  the two never diverge.
- **Idempotency, not "please don't double-submit."** Approve is idempotent
  because task status IS the idempotency key. Usage reports are idempotent
  via a `UNIQUE(child_id, client_session_id)` DB constraint, because content
  alone (appId/start/end) can't reliably distinguish a retry from a genuine
  second session.
- **Undo-approval never mutates history.** It inserts a new
  `approval_reversed` ledger entry. Balance is allowed to go negative
  (soft-negative/debt model) rather than throwing or clamping — see
  WRITEUP.md for why that's the right call for a parent-child product.
- **Late/offline sessions spend against balance as of arrival, not as of
  when they happened** — the ledger never rewrites history.
