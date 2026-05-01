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


## 2026-05-01 ADDENDUM — sibling-check is mandatory before fan-out (LOCKED)

Before creating ANY child ticket from this dispatch flow, you MUST call the
`check-sibling-tickets` skill first. This is the de-dup contract that prevents
the parent-fan-out duplication pattern that produced the April Claude Security
Beta cluster (11 child tickets under 3 different parent IDs in a 30-min window,
no sibling check anywhere).

**Procedure (insert at the top of step "Workflow"):**

```
Step 0 — Pre-fan-out sibling check
  spec = {
    vendor_tag: <ticket vendor>,
    topic_slug: slugify(first 4 keywords of candidate title),
    content_type: <blog|course|chapter|code|research|seo|image-gen|...>,
    parent_id: <current parent>,
    candidate_assignee: <agent>,
  }
  result = invoke check-sibling-tickets(spec)

  if result.should_create_new_ticket == false:
    # canonical sibling found — DO NOT create
    POST /api/issues/<canonical_id>/comments with:
      "Re-prioritized via this dispatch. Original request: <ticket title>.
       Reason new request matters: <why>. (No new ticket — folding into canonical.)"
    return  # stop the dispatch flow

  if result.canonical_warning:
    # multiple siblings exist — surface to chief BEFORE creating
    return BLOCKED with the warning
```

**Decision matrix the skill returns** (already documented in
`skills/check-sibling-tickets/SKILL.md` — quoted here for reference):

| Found | Action |
|---|---|
| 0 siblings | Create the new ticket. Stamp `metadata.dedup_key` for future siblings. |
| 1 sibling, same chief, healthy (last activity < 4h) | DO NOT create. Comment on existing. |
| 1 sibling, different chief | Cross-team conflict. Create + add `metadata.coordinate_with`. |
| 1 sibling, same chief, stuck (no activity > 4h) | Run `recover-stuck-tickets` first, then re-evaluate. |
| 2+ siblings | DO NOT create. Mark oldest canonical, cancel rest as `superseded_by`. |

**Audit log:** every check (regardless of decision) is appended to
`vault/_audit/sibling-dedup-log.jsonl` so Vardaan can see the volume of dupes
the system would have created without this gate.

**Why this is mandatory now:** the routine-de-duplication landed earlier today
(killed dual CEO TitleCase/kebab-case routines) but only fixed dupes at the
cron-fire level. Fan-out dupes (parent → multiple children with overlapping
scope) are a separate vector and live entirely inside the chief's dispatch
flow. This addendum closes that vector.
