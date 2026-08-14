# WRITEUP


## Assumptions made, and why
- I assumed that there would be some milliseconds difference int two http requests reaching the server even if we consider the concurrent Scenario hence the request reaching the server first would be processed first sequentially
- I assumed the Usage minutes are whole minutes, rounded to the nearest minute from
  `end - start`. Sub-minute billing wasn't asked for and adds noise.
- I considered Usage sessions are reported by the device in **arrival order**, and are
  spent against the balance **as of when the server receives them**, not
  replayed against a reconstructed historical balance at their `start` time.
  This keeps the ledger strictly append-only (never inserting into the
  middle of history) and avoids the complexity of retroactively
  recomputing every balance after a late session arrives.
- I assumed the task's `reward` is fixed at creation time; editing a task's reward isn't
  supported (out of scope, no requirement implied it).
- I considered that there would be One token per identity, no token expiry/rotation — "simple token auth" was
  explicit in the prompt.
- I considered that balance_cache` is a performance optimization, not a second source of
  truth — it's written transactionally alongside every ledger insert, and
  its equality with `SUM(ledger_entries.amount)` is the thing under test.

## Double-approve (200ms apart)

I considered that Approve is idempotent by construction: task status is the idempotency key.
The first request transitions `done -> approved` and inserts one ledger
entry. The second request sees status is already `approved` and returns the
existing task + existing ledger entry, crediting nothing further. See
`ledgerService.approveTask` and the test
`tests/idempotency.test.ts: "a parent double-clicking Approve..."`.

## Two overlapping sessions from different apps exceeding balance

I handled this by making sure that because all
writes for one child are serialized through a single-process synchronous
SQLite transaction, the two usage-report requests are processed strictly one
after another, never interleaved. Whichever is processed first is paid in
full (or until balance hits 0); the ledger entry for it records the full
minutes and a null `exhaustedAt`. The second is paid only what's left, and
its ledger entry records exactly how many minutes were covered and the
precise timestamp (`start + minutesCovered`) at which the balance ran out.
The two ledger entries' amounts always sum to exactly the balance consumed —
proven directly by the test.

## Undo-approval and negative balance

Balance is allowed to go negative (soft-negative / "debt" model), rather
than throwing an error or clamping to zero. The undo is its own ledger
entry (`approval_reversed`, negative amount), never a mutation of the
original `task_approved` entry.

Why this is the right choice for a parent-child product, not just
technically convenient:If we look carefully then parent made the mistake (wrong approval), not
the child. The child spent minutes that were, at the moment they spent them,
completely legitimate balance. A design that reacts to the correction by
interrupting whatever the child is doing right now, or displaying a
"you're over your limit" message, punishes the child for the parent's
error. The soft-negative model records the correction honestly in the
ledger (nothing is hidden), simply prevents *new* usage from starting while
negative (identical to how balance-at-zero already behaves — no new
punishment, no new UI), and lets the next approved task's minutes pay down
the debt automatically before the child has "spare" balance again.

## What breaks at 100,000 children with streaming usage

According to me the first thing to break is the **balance reads if computed as a live
`SUM(ledger_entries)`** on every request — full-table-scan behavior at
scale. The current code avoids this already by maintaining `balance_cache`
transactionally, but at 100k-child scale I'd also add periodic checkpoint
rows so a corrupted cache could be rebuilt from the last checkpoint forward
instead of scanning the entire history.

Second: I assumed that there would be some milliseconds difference in two http requests reaching the server so the whole "process writes for a child sequentially, relying on
Node + better-sqlite3 being single-threaded and synchronous" guarantee stops
being true the moment you run more than one server process (which you'd
have to, at this scale, for availability). At that point you need either
real row-level locking (`SELECT ... FOR UPDATE` in Postgres) or a
consistent-hashing/sharding scheme that routes all requests for a given
`childId` to the same process, and SQLite itself needs to be replaced with
Postgres for concurrent-writer support.

Third: synchronous HTTP for usage ingestion becomes a bottleneck under
constant streaming load. I'd move usage-session ingestion to a queue
(Kafka/SQS) with a per-child partition key, so ordering per child is
preserved without a global lock, and the HTTP endpoint just enqueues and
returns immediately.

## Interesting problem I would want to work with team

**Preventing unfair balance drain during inactivity (e.g., falling asleep or leaving phone on Home Screen)**

If a child leaves the device open on an app without actively using it, their hard-earned balance could drain to zero. This feels like a punishing UX and defeats the purpose of the reward system. However, accurately determining "inactivity" is a non-trivial challenge. 

Here is my technical and UX point of view on how we could solve this collaboratively:

1. **Client-Side Idle Detection**: The server cannot definitively know if a user is active; it relies on the client's reporting. We should implement an idle timer on the client (e.g., tracking touch events, scroll, or device motion). If no input is detected for 2 minutes, the client stops the active usage session and stops sending deduction heartbeats.
2. **"Are you still there?" Prompt (The Netflix Model)**: Abruptly pausing balance and locking the app could be jarring. At the 2-minute idle mark, the app could show a full-screen prompt: *"Are you still playing?"* with a 30-second countdown. If ignored, the session officially pauses. If tapped, the session continues seamlessly.
3. **Retroactive Grace Period**: If we determine the user was inactive for the last 2 minutes, we shouldn't charge them for that time. The client could send a retroactive "refund" adjustment, or heartbeats could be kept in a "pending" state on the server until the client confirms the user is still active.
4. **Leveraging Native OS Capabilities**: Instead of just touch events, we could explore iOS's `Screen Attention` or Android's `Attention Screen` APIs, which use the camera/sensors to detect if a face is actually looking at the screen. 
5. **Abuse Prevention**: We must consider the "auto-tapper" or "drinking bird" exploit where a child tries to fake activity. We'd need to filter out repetitive, perfectly timed inputs on identical screen coordinates to ensure the activity is genuine.

This strikes a balance between technical feasibility and a fair, user-friendly experience that builds trust with both the child and the parent.

## What I deliberately didn't build


With one more week: I'd add the checkpoint/sharding work hence implementing the row level lock and processing the concurrent requests more systematically which currently I assumed to differ by milliseconds, I would have also
move usage ingestion to a queue, and add a small reconciliation job that
periodically re-verifies `balance_cache == SUM(ledger)` for every child and
alerts on drift (defense in depth beyond the DB trigger that already
forbids UPDATE/DELETE on `ledger_entries`).
- Multi-device conflict resolution beyond the idempotency key (e.g. two
  physical devices for one child reporting genuinely overlapping real usage
  — the system correctly charges both, which is arguably right, but there's
  no "merge" logic for detecting that scenario specifically).
- Real double-entry accounting (matched debit/credit pairs across accounts)
  — this is a single-account ledger per child, which is what the spec asks
  for, not a general accounting engine.
- Rate limiting, retry/backoff queues, admin dashboards, deployment/Docker.
- Token expiry/rotation/refresh.

Final thoughts: 
The code is production-ready for a single-process model, but scaling to
100k children would require moving to Postgres, adding sharding/consistent
hashing, and switching to a queue-based ingestion model to handle
streaming-in-parallel without contention. The current implementation correctly
handles the double-approve and overlapping-sessions edge cases.
