---
name: janitor
description: >
  Keeps the Paperclip instance clean and healthy on a daily overnight schedule.
  Performs dry-run-first cleanup of stale heartbeat artifacts, orphaned
  workspaces, expired runtime leftovers, stale lock files, and oversized temp
  data. Reports what changed and opens a review issue for anomalies.
---

# Janitor Skill

Keep the Paperclip instance lean, safe, and boring. The Janitor runs daily overnight, cleans only approved artifact classes, and reports anything unusual instead of guessing.

## When to Use

- Daily overnight routine, preferably between 02:00 and 03:00 server-local time
- After a burst of failed, cancelled, or timed-out heartbeat runs
- When disk usage is climbing or logs/workspaces are accumulating
- When the CEO asks for an instance cleanup or health sweep

## Operating Principles

- Dry-run first, prune second, report always
- Prefer skipping over deleting when ownership or freshness is unclear
- Never delete business/domain data as part of cleanup
- Make the smallest safe cleanup action that restores headroom
- Escalate anomalies as Paperclip issues instead of trying to self-repair risky state

## Scope

| Target | Cleanup rule | Default retention |
|--------|--------------|-------------------|
| Heartbeat run logs/artifacts | Completed terminal runs only; preserve run records | 14 days |
| Orphaned workspaces | Workspace dirs with no active run or project reference | 48 hours |
| Codex temp homes | `/tmp/codex-*` and `/tmp/codex-test-*` dirs only | 24 hours |
| Stale lock files | Known Paperclip/Codex lock files with no owning process | 10 minutes |
| Oversized workspace dirs | Report if larger than threshold; do not delete unless orphaned | 5 GB |
| Embedded Postgres WAL | Report and request/trigger safe checkpoint/vacuum if supported | 512 MB |

## Never Touch

- Agent records
- Company records
- Projects, issues, approvals, documents, comments, goals, activity logs, or feedback
- Runs in `pending`, `running`, or otherwise non-terminal status
- Any workspace with an active run, active project reference, or modified files newer than the retention window
- Any file outside the approved path allowlist in `references/pruning-policy.md`

## Daily Overnight Routine

Run once per day during the overnight window:

- Preferred time: 02:15 server-local time
- Acceptable window: 02:00-03:00 server-local time
- Source: `timer`
- Trigger: `callback`
- Timeout: 300000 ms for normal runs; 900000 ms only for first setup or heavy cleanup

## Workflow

### 1. Load policy

Read these files before taking action:

- `references/pruning-policy.md`
- `references/dry-run-checklist.md`
- `references/anomaly-rules.md`
- `references/report-template.md`

### 2. Build dry-run manifest

Create a manifest of candidate cleanup actions. Do not delete anything in this step.

Capture:

- Disk usage before cleanup
- Active heartbeat runs
- Candidate stale heartbeat logs/artifacts
- Candidate orphaned workspaces
- Candidate temp homes
- Candidate stale locks
- Candidate anomaly findings

Use paths and thresholds from `references/pruning-policy.md`.

### 3. Run safety gates

Before deleting, confirm:

- No candidate belongs to an active run
- No candidate is newer than its retention threshold
- No candidate points outside an allowlisted cleanup path
- No delete operation targets a parent directory such as `/tmp`, `/paperclip`, `/paperclip/instances`, or a company data root
- Disk usage and candidate sizes were measured successfully

If any safety gate fails, skip that candidate and include it in the report.

### 4. Prune approved artifacts

Delete only items that passed the dry-run and safety gates.

Allowed actions:

- Remove stale temp dirs matched by the allowlist
- Remove stale lock files with no owning process
- Remove orphaned workspace directories after confirming no active run/project reference
- Prune heartbeat log/artifact payloads through a Paperclip API/CLI command if available; otherwise report that API support is missing
- Request or run safe DB maintenance only when the CLI/server exposes a supported command

### 5. Detect anomalies

Apply `references/anomaly-rules.md` after cleanup.

Open a Paperclip issue tagged `needs-review` if any anomaly is found.

### 6. Report

Write the final report using `references/report-template.md`.

The report must include:

- Start/end time
- Cleanup counts by category
- Estimated size freed by category
- Disk before/after
- Skipped candidates and reasons
- Anomalies found
- Issue links created
- Final status: `clean`, `cleaned`, `skipped`, or `needs-review`

## Success Criteria

A successful run either:

- Performs no cleanup because nothing qualifies and reports `clean`, or
- Cleans approved artifacts, reports exactly what changed, and leaves no unresolved safety failure.

If anomalies are found, the run can still be operationally successful, but final status should be `needs-review` and a Paperclip issue must be opened.

## Output

When complete, report:

- `status`
- `items_pruned`
- `bytes_freed_estimate`
- `disk_before`
- `disk_after`
- `skipped_items`
- `anomalies`
- `issues_opened`
