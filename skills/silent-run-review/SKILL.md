---
name: silent-run-review
description: Fast triage checklist for system-generated run-health review issues. Use whenever the wake issue title starts with "Review silent active run for" (stale active-run watchdog) or "Review productivity for" (productivity review). Classifies the run in ~5 minutes — limit/auth failure, hung process, benign long-runner, routine noise, or an expected run-loop brake (issue_rewake_throttled / no_external_activity) — and closes the review issue with the right disposition. Not for whole-tree stall forensics; that is the diagnose-why-work-stopped skill.
---

# Silent Run Review

Paperclip's recovery service files `Review silent active run for <Agent>` when an active run stops producing output, and `Review productivity for <ISSUE-ID>` when a source issue shows unusual progression (no-comment run streaks, long active duration, high churn). These are bounded triage tasks, not investigations. The contract behind them is `doc/execution-semantics.md` §11 "Silent Active-Run Watchdog" (silence levels, watchdog decisions, source-aware folding) — read it if any step below is ambiguous.

## Cheap-lane review + escalate-after-3 (the routing contract)

Recovery / failed-status / silent-run / productivity reviews are CHEAP triage, not leadership work, and are routed accordingly:

- **Cheap lane owns the review.** These review issues are now assigned to the company's deterministic shell-handler Compiler — `MC-Compiler` (TSMC), `KISS-Compiler` (KISS), or each OpCo's `Fallback-Compiler` — NOT to the CEO/CTO. The reviewer triages with the tree below and sets the case to a disposition (`done`/`cancelled`, or `blocked` with a named owner). The CEO/CTO chain remains only as a fallback when no cheap reviewer exists.
- **Escalate only after 3 consecutive reviews on the SAME case.** Each new review for the same run/source is one "review cycle". A consecutive-review counter is tracked on the review issue (a `Recovery review cycle tracker.` marker comment). Cycles 1–2 stay on the cheap lane. On the **3rd** consecutive unresolved cycle the review escalates to the leadership chain ONCE (titled `Escalated: silent active run ... (review cycle N)`, priority high). It does NOT re-page leadership on cycle 4, 5, … — escalation fires once per unresolved case.
- **Resolution resets.** If the underlying case resolves (review closed clean / source healthy), the counter resets to 0, so a later unrelated silence starts fresh from cycle 1.
- **Dedup + cadence.** One open review issue per run/source at a time. The watchdog/productivity scans run on a widened, deduped cadence (~20 min, `RECOVERY_REVIEW_SCAN_INTERVAL_MS`) rather than every operational tick, so a single unresolved case cannot spawn a storm of review issues.
- **Dormancy.** Companies intentionally outside their activity window are "dormant" — their agents are sleeping, not failing. The recovery scans skip dormant companies entirely, so no silent-run / productivity churn is generated while a company is asleep.

Both issue types arrive with the evidence already collected in the description (run id, silence age, last-output timestamp, source issue link, latest runs/comments, thresholds). Read that first; only fetch more when the description is insufficient.

## 5-minute classification tree

Work down; stop at the first match.

**1. Source issue already terminal?** If the linked source issue is `done`/`cancelled` with durable same-run evidence after the silence point, this is a stale run handle, not a work problem. Close the review (`done`, or `cancelled` if it self-resolved) noting the fold: run id, terminal source status, evidence timestamp. Best-effort kill of any leftover process; if cleanup fails, record that on the review before closing — do not reopen the source issue.

**2. Session-limit / auth / quota failure?** Check the run's last output and adapter error string for limit signatures (`You've hit your (session|weekly|daily|5-hour|usage) limit`) or adapter auth/model errors (401/403, `invalid_request_error` on model selection). If found → switch to the **fallback-lane-ops** skill: confirm the takeover/swap-back path is armed for this primary, then close this review with the classification, the error string, and a link to the fallback action taken. Do not leave the review open "until the limit resets".

**3. Hung process — dead or alive?** For a run with a real process handle, check whether the pid is alive (workspace runtime controls or `ps -p <pid>`).
   - **Pid dead** but run still `running`: the run handle is stranded. Note the evidence, let/ask the recovery path re-dispatch the source issue (move it back to `todo` with a next action if you own it), close the review.
   - **Pid alive but silent**: decide harm vs. patience. If it may be mutating external state or is clearly wedged (silent well past the critical threshold with no side-effect evidence), kill it, move the source issue back to `todo` with a precise next action, close the review. If in doubt and the source issue is blocked on this evaluation, prefer recovery over indefinite waiting — the watchdog blocked the source issue precisely so someone decides.

### Codex liveness exit contract

Treat `process_lost` and `codex_output_inactivity_monitor` as deterministic recovery cases, not "maybe rerun it on the same lane until it works":

- **`process_lost`**: allow one bounded retry path only. If the recovery service has not yet spent the single retry, let that retry stand and close the review with the retry evidence. If the same source issue comes back after the one retry, stop same-lane reruns: move the source issue to a healthy next action (`todo` with a restart step, or a sister-lane transfer when the job is long/expensive) and close the review with that transfer/restart decision.
- **`codex_output_inactivity_monitor`**: do not keep rearming the same Codex lane after repeated silent exits on the same case. For long or expensive work, prefer sister-lane transfer via `fallback-lane-ops`; for short work, allow one clean restart with a precise next action, then transfer/block instead of looping.
- The reviewer's job is to force an exit from the liveness loop: one retry if the contract still allows it, otherwise a transfer, reroute, or explicit healthy waiting path.

**4. Benign long-runner?** Builds, big test suites, long agent sessions that are genuinely working. Record an explicit watchdog decision rather than just commenting:
   - `continue` — current evidence is acceptable; does not touch the run; re-arms the watchdog after a 30-minute default window.
   - `snooze` — known time-bounded quiet period; suppresses further scan-created review work until the chosen quiet-until time. Prefer this for known long jobs so the watchdog does not re-file.
   Only the board or the assigned owner of the evaluation issue can record decisions. Then close the review as productive, stating the expected completion signal.

**5. Routine noise during a halt/pause window?** If the run belongs to an agent or routine that is deliberately paused/halted (maintenance, emergency stop, limit window already being handled), cancel the review with the standard comment: `routine watchdog noise during <halt context> — no action needed, see <controlling issue>`.

**6. A run-loop brake fired?** Two skip reasons are *working brakes*, not defects. If the silence is explained by either, the classification is "brake fired as designed" — close the review as productive/noise, do NOT kick the agent, do NOT file a silent-skip defect. See "Run-loop brakes" below for how to confirm and how to tell a brake from a real stall.

For productivity reviews specifically, the manager decision menu is in the issue body: close as productive / continue with a snooze window / request decomposition, reroute, block with an unblock owner, or stop/cancel the source work if it is inefficient. Pick one explicitly.

## Run-loop brakes are EXPECTED, not defects

Paperclip deliberately holds some wakes back. A held wake looks like silence from the outside, so it will land in front of you as a review. **Neither of these is a silent-skip defect. Do not "fix" them by re-kicking the agent or filing a platform bug.**

### `issue_rewake_throttled` — the re-wake throttle (PAP-13775)

`server/src/services/issue-rewake-throttle.ts`. Once the same agent has **2 consecutive `succeeded` runs on the same issue that left no issue-visible progress**, further information-free wakes for that issue are held for an escalating cooldown (2 min, doubling, capped at **30 min**) anchored to the last run's finish time. Purpose: stop external pollers and reconcilers from paying full adapter sessions for zero new information.

**How it surfaces:** a row in `agent_wakeup_requests` with `status = 'skipped'`, `reason = 'issue_rewake_throttled'`, and `payload.heartbeatSkip` carrying `requestedReason`, `noProgressStreak`, `cooldownMs`, `lastRunFinishedAt`, `nextAllowedAt`. **No** `heartbeat_run` is created. That absence is the design, not a lost wake.

**What it applies to:** reason-less on-demand invokes, plus `issue_assigned`, `issue_continuation_needed`, `issue_assignment_recovery`, `issue_graph_liveness_backstop`. Everything else — comment wakes, mentions, blockers-resolved, interactions, approvals, monitors, reviews — passes through untouched. So does any wake carrying `forceFreshSession: true`, an explicit resume, or a wake comment. Server-side recovery retries (process-loss, missing-comment follow-ups) insert runs directly and never reach this gate, so crash recovery is never delayed by it.

**Brake vs. genuine stall:**
- **Brake working** — the streak is real: the last runs `succeeded` and genuinely left no comment/mutation/document/work-product behind, and `nextAllowedAt` is in the near future (≤30 min). The agent will be woken again on its own. Close the review noting the streak and `nextAllowedAt`.
- **Genuine stall underneath** — the throttle is the *messenger*. A 2+ no-progress streak means the agent keeps finishing without moving the issue. That is the defect worth reporting, and it is a **work** problem (bad next action, missing context, wedged agent), not a platform problem. Do not blame the throttle; classify the work.
- **Real red flag** — a wake that should never have been a throttle candidate got held (an event-carrying reason in `requestedReason`), or `nextAllowedAt` has long passed and still nothing ran. Then escalate as a platform defect with the wakeup-request row as evidence.

### `no_external_activity` — the routine activity gate

`server/src/services/routines.ts`. A routine whose `activity_gate_policy` is `require_external_activity` (the column defaults to `always`, so this is opt-in per routine) does **not** fire when nothing external has happened since its last dispatched run. Purpose: stop quiet-period routines from generating work nobody asked for.

**How it surfaces:** a `routine_runs` row with `status = 'skipped'` and `failure_reason = 'no_external_activity'`, routine touched-state `skipped_no_activity`, and a `routine.run_skipped` activity entry whose details carry `activityGate.verdict = 'quiet'` and the window start. The routine's `nextRunAt` still advances normally.

**Brake vs. genuine stall:**
- **Brake working** — the routine is gated, the window really was quiet, and `nextRunAt` advanced. Cancel the review as noise. A gated routine skipping during a quiet period is the feature.
- **Genuine stall** — the window was *not* quiet (there is obvious external activity in the period) and it still skipped, or `nextRunAt` stopped advancing, or the routine is gated but should not be. Those are real; report them with the skipped-run row and the activity you expected it to match.

**Never confuse either brake with:** `paused` (deliberate pause), `worktree_execution_cutoff` (worktree suppression), `issue_terminal_status` coalescing, or a per-agent daily-cap skip. Those are separate reasons with separate remedies — read the `reason` / `failure_reason` verbatim before classifying.

## Required evidence in your closing comment

- Run id (and pid, if a process was involved)
- Last-output timestamp and silence duration at triage time
- Adapter error string verbatim when classification was limit/auth
- The skip `reason` / `failure_reason` verbatim when classification was a run-loop brake, plus `nextAllowedAt` (throttle) or the quiet-window start (activity gate)
- The classification (1–6 above) and the action taken on the source issue

## Disposition rules

- **Never leave the review issue itself `in_progress`** at heartbeat end. It is a triage task: `done` (triaged, action recorded), `cancelled` (noise/self-resolved), or — rarely — `blocked` with a named owner when the unblock genuinely belongs to someone else (e.g. only the board can unpause an agent).
- Do not silently delete or hide review issues; they are the watchdog audit trail.
- Do not edit or remove the `Recovery review cycle tracker.` marker comment by hand — it carries the consecutive-review count and escalation state. Closing the review clean lets the recovery service reset it; tampering breaks the escalate-after-3 contract.
- One review per run is the invariant — if you find duplicates, keep the canonical one and cancel the rest with a link to the keeper.
- Critical-level reviews may have **blocked the source issue** on the evaluation. Closing the review must also restore the source issue's path: clear the blocker and leave the source in a healthy state (`todo` with a next action, an active run, or a real waiting path).
- For `process_lost` or `codex_output_inactivity_monitor`, "healthy state" never means indefinite same-lane rerun churn. Record whether the single retry was consumed, or where the work was transferred next.

## When to escalate instead

Use the **diagnose-why-work-stopped** skill ONLY when a whole tree is stalled — multiple issues with no live path, recovery loops re-waking the same issues, or the review issue is the visible tip of a structural stop. A single silent run with a clear cause never needs tree forensics.
