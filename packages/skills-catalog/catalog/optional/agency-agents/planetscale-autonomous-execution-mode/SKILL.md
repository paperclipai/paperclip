---
name: "planetscale-autonomous-execution-mode"
description: "Execute approved PlanetScale changes end-to-end without per-step approval when the operator has explicitly acknowledged the risk."
key: "paperclipai/optional/agency-agents/planetscale-autonomous-execution-mode"
recommendedForRoles:
  - "generalist"
tags:
  - "agency-agents"
  - "generalist"
  - "planetscale"
  - "autonomous"
  - "execution"
  - "mode"
defaultInstall: false
---
# Autonomous execution mode

## Purpose

Let an operator who has explicitly accepted the risk hand the whole job to the agent: plan, execute, verify, and report — with live status the entire way — instead of approving each change one by one. This mode removes the per-step approval friction. It does not remove any verification, ordering, rollback, or halt discipline. Autonomy changes who clicks "go", never how carefully the work is done.

## Activation contract

Autonomous mode activates only when the operator's message contains all three:

1. **Explicit risk acknowledgment.** An unambiguous statement such as "I understand the risk", "I accept the risk", "I know this can affect production". Softer phrasings — "go ahead", "sounds good", "do it" — do NOT activate autonomous mode; they remain per-change approvals under the change-gates skill.
2. **A named scope.** One of:
   - Named change IDs ("VIT-1, VIT-3, WEB-1"), or
   - A named database or org with a change-class ceiling ("everything in the report for storefront-demo"), or
   - "All recommendations in the report" — valid in this mode only, because the report already names every change.
3. **A production statement.** Whether production-affecting (Class D) changes are included. If the operator does not say, ask once; if still unstated, run at `auto-safe` (Class D excluded).

Record the acknowledgment verbatim in the run log before executing anything.

### Autonomy levels

| Level | Unlocks | Requires |
|---|---|---|
| `auto-safe` | Class B + Class C within scope | Risk acknowledgment + scope |
| `auto-production` | Adds Class D within scope | Risk acknowledgment + scope + explicit production statement |
| — | Class E | Never available. No phrasing unlocks it. |

Class E operations (dropping production databases/tables, disabling all safety mechanisms simultaneously, exposing secrets, removing private-only network posture) are refused in every mode. If a requested change set contains a Class E item, execute the rest and report the exclusion — do not silently skip and do not ask the operator to "confirm harder".

### Acknowledgment lifetime

- Applies to **this run only**. A new session, a new report, or a materially changed database state requires re-acknowledgment.
- Applies to **the named scope only**. Discovering a new problem mid-run does not authorize fixing it — add it to the report and continue.
- The operator can say **"stop"** at any time; halt after the current atomic step and produce the partial-run report.

### Standing authorization (scheduled automation)

Interactive acknowledgment is single-run. Scheduled agents (cron, Cursor
Automations, webhook-triggered runs) instead operate under a **standing
authorization**: a written artifact, committed where the agent reads its
instructions (an `AGENTS.md` section or a dedicated authorization file),
containing:

- Automation name and owner.
- Scope: organization, database, branches.
- Class ceiling: B, C, or D. Class E is not authorizable.
- Operation allowlist, stated as bounded operations, not intents.
  Valid: "open deploy requests for additive DDL from open schema
  recommendations; deploy with revert window; additive only (ADD INDEX,
  ADD COLUMN NULL)". Invalid: "keep the schema optimized".
- Numeric bounds where applicable: max changes per run, max branch age
  for deletion, budget modes permitted (warn only vs enforce).
- Expiry date. Expired authorization = report-only mode. Recommended
  review interval: 90 days.

Per-run rules for standing authorization:

- The agent re-reads the authorization at the start of every run;
  execution is bounded by the artifact as written, not by memory of it.
- Everything outside the allowlist is report-only for that run.
- All halt conditions apply unchanged. A halted scheduled run does not
  self-resume; it reports and waits for the owner.
- Status streams to a configured delivery channel (webhook, Slack,
  issue tracker) since no operator is watching an interactive session.
  A scheduled run with no delivery channel must not execute mutations —
  status with no reader is not status.
- The run log is persisted per run and referenced in the delivery
  channel message.

## Sensible execution: the plan

Before the first mutation, produce and show an **execution plan**:

1. **Order by dependency, then by risk.** Prerequisites first (e.g. stop the app's boot-time DDL before enabling safe migrations, add an index before dropping the one it replaces). Among independent changes, lowest-risk first so early failures cost the least.
2. **Pre-flight each change.** Re-read the live state immediately before mutating (branch flags, recommendation state, webhook config). If the state no longer matches the report evidence, the change is **stale**: skip it, mark it `BLOCKED — state drift`, and continue with independent changes.
3. **Safety prerequisites are steps, not assumptions.** Before any Class D DDL: confirm a backup completed within the retention window, confirm safe migrations or a deploy request is the vehicle where the engine supports it, and prefer revertible mechanisms (deploy requests with revert window, warn-mode before enforce-mode for Traffic Control).
4. **One atomic change at a time.** Never batch unrelated mutations into one command. Never parallelize Class D steps.
5. **Verify after each step.** Read the state back and confirm the expected effect before moving on. A change is not "done" when the command exits 0; it is done when the read-back matches the expected state.

## Status protocol

The operator handed over control; visibility is what they get in return. Emit status at every stage:

- **Plan announcement** — numbered steps, each with target, exact command/interface, expected effect, rollback mechanism, and class. This is the last thing shown before execution begins.
- **Per-step, before**: `[step 3/7] STARTING VIT-3a — deploy request: add idx_orders_on_user_id to storefront-demo/main (Class D, revert window available)`
- **Per-step, after**: `[step 3/7] DONE — deploy request #4 deployed, index visible in schema read-back (took 2m 10s)`
- **Long-running operations** (deploy requests, migrations, restores): poll and report progress at a sensible cadence, not just at completion. Include queue position/state transitions.
- **Skips and blocks**: report immediately with the reason (`BLOCKED — state drift`, `EXCLUDED — Class E`, `SKIPPED — prerequisite failed`), never silently.
- **Run summary** — the post-execution report from the change-gates skill: what changed, when, evidence of success, warnings, rollback state, follow-up monitoring. Plus the acknowledgment quote and the autonomy level used.

Status lines must be specific enough that an operator reading only the status stream could reconstruct the run: name the change ID, the target, and the mechanism every time.

Status is plain text, emitted in the agent's normal output stream as each step happens. It must not depend on any host-specific rendering surface (canvas, HTML, TUI widgets) — those may supplement the stream, never replace it. The plain-text stream and the run log are the record of the run in every agent.

## Halt conditions

Stop-the-line rules. When any of these fires, finish or safely abort the current atomic step, execute the pre-staged rollback if the step half-applied, and report:

1. **Any Class D step fails or verifies incorrectly** → halt the entire run.
2. **A Class B/C step fails** → halt that change's dependency chain; independent changes may continue; say so in status.
3. **An anomaly begins firing on a target database mid-run** → pause the run, report the anomaly, wait for the operator.
4. **State drift on a production target** (someone else changed it mid-run) → halt the run.
5. **Scope pressure** — anything needed that is outside the acknowledged scope → do not do it; report it.
6. **Error on a destructive step** → never auto-retry. Retries are permitted only for idempotent reads and transient network failures on non-destructive calls.

After a halt: report state of every step (done / rolled back / blocked / not started), current database state, and what re-acknowledgment would be needed to resume. Never resume a halted run on the original acknowledgment.

## Rollback discipline

- Before each step, stage the concrete rollback: the exact command or mechanism (deploy request revert, budget back to warn, webhook disable, restore point).
- Auto-rollback without asking when a step half-applies and the rollback is itself non-destructive and pre-declared in the plan.
- Never auto-rollback with a destructive operation (e.g. never auto-restore over data); report and wait instead.

## Run log

Maintain an append-only run log for the whole session: timestamp, step ID, command, result, read-back evidence. Include it (or its path) in the run summary. The log is the audit trail that makes "the agent did it autonomously" reviewable.

## Interaction with other skills

- `../11-change-gates-and-approval-contract/SKILL.md` — the class definitions and pre/post-execution checklists still apply verbatim; a valid risk acknowledgment substitutes for per-change approval within scope. Class E rules are unchanged.
- `../00-safe-orchestrator/SKILL.md` — when a valid acknowledgment accompanies the assessment request ("run the audit and fix what you find, I accept the risk"), run the full assessment first, present the report and execution plan, then proceed directly into execution under this skill without stopping for approval.
- `../07-schema-recommendations-agent-loop/SKILL.md` — in autonomous mode the loop may carry recommendations all the way through branch, deploy request, and deploy, using gated deployments where cutover timing matters.

## Required refusal behavior

If the operator asks for full autonomy without the acknowledgment elements, do not negotiate ambiguity. Reply:

"Autonomous mode needs an explicit risk acknowledgment, a named scope, and whether production changes are included. For example: 'I accept the risk — apply all report recommendations to storefront-demo, production included.'"

Then wait.
