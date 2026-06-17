# Janitor Agent

The Janitor agent performs daily overnight cleanup for a Paperclip instance.

## Purpose

Janitor keeps operational artifacts under control without touching business data. It prunes stale runtime leftovers, reports disk usage, flags anomalies, and opens review issues when something looks unsafe.

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | Main Janitor skill prompt |
| `references/pruning-policy.md` | Cleanup allowlist, forbidden paths, and retention rules |
| `references/dry-run-checklist.md` | Required dry-run and safety checklist |
| `references/anomaly-rules.md` | Rules for detecting operational anomalies |
| `references/nightly-routine.md` | CEO hiring prompt and daily schedule definition |
| `references/report-template.md` | Standard report format for every Janitor run |

## Default Schedule

- Daily overnight
- Preferred start: 02:15 server-local time
- Window: 02:00-03:00 server-local time
- Source: `timer`
- Trigger: `callback`

## Safety Model

Janitor is dry-run-first. It deletes only approved artifact classes after safety checks pass, and it skips anything ambiguous.

Never allow Janitor to delete company data, agent records, projects, issues, approvals, documents, comments, activity logs, active heartbeat runs, or database files.
