---
schema: agentcompanies/v1
kind: skill
slug: dispatch-vendor-watch
name: Dispatch Vendor Watch
description: Chief Research's morning routine — wake at 05:55 IST, fan out per-vendor research tickets to the 4 researchers + the editor, and wait for synthesis.
version: 0.1.0
license: MIT
sources: []
---

# Dispatch Vendor Watch

Used by `chief-research`. Runs at 05:55 IST as a pre-cron warmup so the 06:00 researcher heartbeats land cleanly.

## Procedure

1. **Verify researchers are alive** — `GET /api/companies/learnova-academy/agents` filtered to researchers. If any are paused/erroring, skip them; ping CEO.
2. **Verify yesterday's brief landed** — `ls vault/research/_daily/<yesterday>.md`. If missing, escalate (research-editor blocked).
3. **Dispatch 4 parallel tickets** — one per vendor researcher. Title: `Daily research · <vendor> · <date>`. Body references the vendor-watcher skill + per-vendor source list.
4. **Dispatch editor ticket** — title: `Daily synthesis · <date>`. Trigger time: 06:30 IST. Depends on all 4 researcher tickets.
5. **Hand control to cron** — researchers run at 06:00, editor at 06:30. You don't poll.

## Inputs

- Today's date (UTC + IST conversion)
- Live agent health status

## Outputs

- 5 Paperclip tickets created (4 researchers + 1 editor)
- One comment on the chief-research meta-task: `dispatched 4 researcher tickets, 1 editor ticket`

## Never do

- Never wait/poll for researcher completion — that's what cron is for
- Never re-dispatch a vendor that's already running
- Never assume yesterday's brief exists — verify

## Escalation

- 2+ researchers down → CEO same heartbeat
- Editor's prior brief missing → CEO same heartbeat (today's triage will be blind)

## Budget

Per-task cap $1 (reasoning is light; mostly API calls).
