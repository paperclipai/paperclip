# Negotiated domain deadlines

The `domain_deadlines_v1` catalog extends the existing owned idle-sleep handoff.
Cloud requests `scheduledWake=domain-deadlines-v1` and signs the fixed catalog in
`idleCapabilities.deadlineCatalog` on its stack-bound `task-drain:read` assertion.
A query parameter or an ordinary credential cannot grant this capability.
The response uses idle-safety version 3 with a scheduled proof of version 2,
kind `domain_deadlines`, catalog `domain_deadlines_v1`, opaque generation and
canonical UTC `nextWakeAt`. Legacy requests and versions keep their prior rules.

The proof combines existing routine and issue-monitor obligations with:

- Eligible agent interval timers, using the same actionable-work, organization,
  daily-run and daily-cost policy as ordinary heartbeat dispatch. Inspection
  does not claim a timer or advance `lastHeartbeatAt`. Restore and worktree
  scheduling overrides remain conservative blockers.
- Plugin jobs with a valid future `nextRunAt`, matching current declaration and
  an exact worker-owned quiet catalog. An explicitly manual-only declaration
  adds no timer. Missing worker/deadline, unfamiliar status, unfinished run or
  settlement, and catalog changes refuse sleep.
- Retained finalized provider traces at their original 24-hour expiry. Active
  capture/import, expired data and unfinished object deletion remain work.
  Capture expiry and deletion retain their ordinary owner; sleep never extends
  retention or changes reveal authorization.
- Personal GitHub grant continuity, using the owner's token-expiry-minus-one-hour
  and 30-day access-refresh rules. Broker enrollment alone is insufficient:
  exact ingress binding and actual grant deadline must both be proven. Missing
  credentials, refresh leases, binding synchronization and unresolved retry
  records remain blockers.

Pending watchdog first-run grace (15 seconds) and automatic merge-confirmation
checks (five minutes) remain awake. They provide no useful safe sleep window
under the unchanged Cloud minimum of five minutes. Their cadence is preserved;
there is no merge observation migration or invented future timestamp. Grok
bindings and unfinished Grok routine recovery remain outside this catalog.
`grok-bot/routine.ts` owns `recoveryRequiredAt`, stale `sending` dispatches
(after 30 seconds), and accepted dispatch `expiresAt` (created with a ten-minute
lifetime). These are authorization/recovery obligations, not ordinary recurring
routine timestamps, and their bindings remain blocked. No alarm exemption is
inferred from the shared table name or a revoked UI connection.

Each inspection reads one repeatable-read snapshot under the owned admission
hold. Its generation binds the process, owner and expiry, passive state,
ordinary routine/monitor proof, exact domain rows and plugin worker identities.
Any changed state, cancellation, moved deadline, owner replacement or restart
invalidates the old proof. Unknown or malformed states fail closed.

The additional domain projection is bounded to 64 SQL reads, two seconds of
monotonic inspection time, 128 eligible timer candidates and 10,000 rows per
family, while reserving 60 seconds of hold headroom. Overflow refuses sleep;
it never truncates the proof or changes a schedule. These limits supplement the
transaction's statement timeout. A query already in progress remains bounded
by that timeout, and no subsequent query starts after budget exhaustion.

Cloud persists one existing registry alarm under its current sleep lease before
final proof validation and provider stop. It compares every proof field on the
final read and checks the time window again. The worker wakes 120 seconds before
the actual obligation, retries failed/deferred wakes after 30 seconds and keeps
its existing expiring claims and replacement fences. No tenant timer definitions
or new per-timer tables are stored in Cloud.

After wake, ordinary domain services retain authorization, budgets, concurrency,
atomic claims, cancellation and missed-work policy. Cloud wakes the stack; it
does not dispatch a business effect. Disable new registrations for rollback
while continuing to serve existing alarms, or wake their stacks before removing
the alarm service. Host support must precede enabling app exemptions. Local
unit/PostgreSQL evidence establishes the handoff logic, not deployed host or
Neon suspension, measured startup margins or fleet savings.
