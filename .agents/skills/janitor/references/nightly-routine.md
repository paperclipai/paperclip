# Janitor Nightly Routine

This file defines the intended daily overnight routine for the Janitor agent.

## Schedule

- Cadence: daily
- Window: 02:00-03:00 server-local time
- Preferred start: 02:15 server-local time
- Source: `timer`
- Trigger: `callback`
- Normal timeout: 300000 ms
- Heavy first-run timeout: 900000 ms

## Agent Settings

| Field | Value |
|-------|-------|
| Name | `janitor` |
| Role | `janitor` |
| Skill | `janitor` |
| Adapter | Cheapest reliable local adapter available; prefer `minimax_local` if configured |
| Description | Daily overnight cleanup and operational hygiene for the Paperclip instance |

## CEO Hiring Prompt

Use this prompt when asking the CEO to hire the agent:

```text
Please hire a new Paperclip agent named `janitor`.

Role: janitor
Skill: janitor
Adapter: minimax_local, using the cheapest reliable model available
Schedule: daily overnight routine, once per day between 02:00 and 03:00 server-local time, preferred start 02:15
Trigger: timer/callback
Timeout: 300000 ms after first verification

Mission:
Keep the Paperclip instance clean and healthy. Every night, run a dry-run-first cleanup of stale heartbeat artifacts, orphaned workspaces, old Codex temp homes, stale lock files, and safe database maintenance signals. Never delete company data, agent records, projects, issues, approvals, documents, comments, activity logs, or active heartbeat data. Report all cleanup actions and open a `needs-review` issue for anomalies.

First action:
Run one on-demand verification heartbeat before enabling the overnight schedule. The verification should perform a dry run, apply only safe cleanup if candidates pass all gates, and post the final Janitor report.
```

## Verification Run

After hiring, run one manual verification heartbeat:

```bash
paperclipai heartbeat run \
  --agent-id <janitor-agent-id> \
  --source ondemand \
  --trigger manual \
  --timeout-ms 300000
```

Expected result:

- The Janitor reads policy files
- The Janitor produces a dry-run manifest
- The Janitor reports cleanup counts
- No active runs are pruned
- Any unsupported cleanup command is reported instead of guessed
- The final status is one of `clean`, `cleaned`, `skipped`, or `needs-review`

## Enable Schedule

Enable the nightly schedule only after the manual verification run succeeds.

Record:

- Agent ID
- Schedule ID or routine ID
- First scheduled run time
- Verification run ID
- Final verification status
