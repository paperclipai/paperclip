# Status-card evaluation deadlines

Baseline: `76fde891ccc29283b3f5c8dcdce089c5b3d937d1`.

Status-card ownership covers evaluation policy, card claims, generation, ordinary assignment wakeups, and failed-assignment cancellation. `index.ts` registers a typed capability. Shared delivery/deadline infrastructure owns transaction settlement, coalescing, admission/drain, retries and shutdown. Existing cards, updates and issues remain durable truth; no timer table or sleep-safety exemption is introduced.

Manual cards have no automatic obligation. Interval cards retain their requested evaluation cadence. Reactive cards evaluate committed source changes, retain the actual debounce/rate/budget/active-hours deadline while relevant changes remain, and disarm once unchanged. Saved relative-search windows retain their actual membership expiry; the duration interpretation stays with company search. Startup reconstructs existing work without advancing business timestamps.

Scheduled reactive source events can preempt a future evaluation. A feature-owned transaction advisory lock serializes scheduler evaluation across connections while existing card/issue services perform their own committed writes. The lock holder has no card row lock, avoiding self-deadlock. Existing next-evaluation CAS, generating-issue ownership and issue idempotency keys remain required, including for manual refreshes and older server instances that do not use the advisory lock. The persisted five-minute claim remains the failure retry after a scheduled refresh cannot finish. Internal timers do not establish a Cloud wake alarm.

## Producer audit (in progress)

| Source | Owning committed boundary | State |
| --- | --- | --- |
| Card create/config/archive/delete, compile, query/summary writeback, evaluation | status-card mutation transactions | wired; ordinary lifecycle exercised |
| Experimental feature flag | instance settings update transaction | wired; disable exercised |
| Company pause/archive/reactivate/delete | company owning transactions | wired; lifecycle acceptance remains |
| Ordinary issue create/update/remove | issue service transactions | wired; create/change exercised |
| Comments create/delete/tombstone | common insert and issue mutation transactions | wired; comment acceptance remains |
| Review state / chat-run milestones | issue-review-state notification boundary | wired; exact caller coverage audit remains |
| Execution-control writes/run settlement | execution-control transaction helpers | wired; exact caller coverage audit remains |
| Agent deletion/membership reassignment, issue tree transitions, title/prefix | owner transaction | wired; representative acceptance remains |
| Workspace selection/binding, plugin/provider workspace, native recovery/reclaim, active watchdog, retry | owner transactions where uncovered by shared notifications | partially wired; remaining per-write audit required |
| Raw workspace cleanup/routes, conversation activation/settlement, queue paths | direct writes and adjacent owner notifications | exact coverage incomplete; not acceptance-ready |
| Imports/independent writers/replicas | supported service writes and startup reconstruction | full ingress contract audit remains |

Process-local notifications cover writes using the installed database owner. They do not notify an unrelated SQL writer or another server process; those supported paths need explicit ingress or reconstruction coverage. No claim of cross-replica delivery, host suspension, or fleet savings is made by the current tests.

## Acceptance evidence and remaining gates

The original status-card PostgreSQL suite passed25/25. New real PostgreSQL tests exercise ordinary card compilation/writeback, source-change debounce, persisted assignment at a controlled provider boundary, result persistence, quiet SQL after completion, earlier/cancelled deadlines, nested outer commit/rollback and drain/resume. The provider boundary is simulated; no model runs. Additional race, restart, failure, active-hour/rate/budget persistence, multi-company and producer-class coverage remain before PR delivery.

Shared deadline regressions reproduced and corrected a settled-write admission hold during drain. The correction releases only settled holds, retains an in-memory resume wake, and leaves ambiguous transaction intent fenced by the database coordinator. Unit coverage includes first write during drain, failure entering drain, preserved future deadlines, warm standby and ambiguous commit settlement.
