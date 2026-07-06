# 001 — Fleet Concurrency Governor

## Suggestion

Add a **global admission-control layer** that caps how many agent runs may execute
concurrently across an entire instance and per company — not just per agent.

Today concurrency is enforced *per agent*: `heartbeat.ts` computes
`availableSlots = policy.maxConcurrentRuns - runningCount` for a single agent
(default 20, clamped 1–50). Nothing stops 30 agents from each launching 20 runs at once.
For an operator running "20 simultaneous Claude Code terminals" (a stated use case in the
README), this means unbounded real concurrency — which translates directly into runaway
API spend, machine thrash, and provider rate-limit storms.

A Fleet Concurrency Governor lets an operator say: *"never run more than N agent runs at
once on this machine"* and *"company X gets at most M concurrent runs."* When the cap is
hit, new runs queue instead of launching, and the dashboard shows what's running vs.
waiting.

## How it could be achieved

1. **Settings surface.** Add `instanceMaxConcurrentRuns` to `instance-settings.ts` and a
   per-company `maxConcurrentRuns` column on the companies table (`packages/db`). Expose
   both in the existing settings/company routes.
2. **Central counter.** Introduce a `run-admission` service that holds live counts of
   active runs keyed by `{instance, companyId}`. The plugin job scheduler
   (`plugin-job-scheduler.ts`, `maxConcurrentJobs` gate at line ~298) is a near-exact
   template for the acquire/release pattern.
3. **Gate the launch path.** Before `heartbeat.ts` actually starts a queued run, call
   `runAdmission.tryAcquire(companyId)`. If no slot is free, leave the run in a
   `queued_admission` state instead of starting it, and release the slot on run
   completion/failure (hook the same place watchdogs mark runs finished).
4. **Wakeup on free slot.** When a slot releases, pop the highest-priority waiting run and
   trigger the existing `issue-assignment-wakeup` path so it starts promptly.
5. **UI.** Add a "Running N / Cap M · K waiting" badge to the dashboard and a per-company
   row, reusing the live-events websocket so it updates in real time.

## Perceived complexity

**Medium–High.** The acquire/release primitive is straightforward and has a working
in-repo precedent, but correctness is the hard part: slot accounting must survive crashes,
process recovery (`heartbeat-process-recovery`), and stale runs, or the system will slowly
deadlock as leaked slots accumulate. Needs a reconciler that recomputes live counts from
actual run state on a timer. The DB/settings/UI plumbing is mechanical; the distributed-
counting correctness is where the effort goes.
