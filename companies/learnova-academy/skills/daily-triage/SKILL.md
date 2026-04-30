---
schema: agentcompanies/v1
kind: skill
slug: daily-triage
name: Daily Triage
description: CEO's 07:00 IST routine — read the daily brief, decide which items become tickets, assign each to the right Chief, set deadlines and success criteria.
version: 0.1.0
license: MIT
sources: []
---

# Daily Triage

Used by `ceo`. Runs once per day at 07:00 IST after the Research Editor's daily brief lands. Output: tickets in Paperclip, one per actionable item.

## Inputs

- `vault/research/_daily/<YYYY-MM-DD>.md` — today's brief (must exist; if missing, escalate to Chief Research)
- Yesterday's `vault/decisions/eod-<date>.md` — what's still in flight from yesterday
- Current company state — which agents are paused, who's at >80% budget, what's queued

## Procedure

1. **Read the daily brief** in full. Pay attention to the `recommendations` table.

2. **Read yesterday's EOD digest** to know what's already in flight (don't queue duplicates).

3. **Read company state** via Paperclip API:
   - `GET /api/companies/learnova-academy/agents` — who's healthy?
   - `GET /api/costs/summary` — who's on track / hot?
   - `GET /api/companies/learnova-academy/tasks?status=in_progress` — current load

4. **For each `recommendation` in the brief**, decide:
   - **Make a ticket** if: actionable, has clear success criteria, fits today's capacity
   - **Defer** if: low signal, or team is full, or an in-flight ticket already covers it
   - **Reject** if: outside V1 vendor scope, or violates a budget constraint

5. **For each new ticket**, write it as:

```yaml
title: <imperative — "Update Module 4 of Claude tool-use with new connectors">
ticket_type: blog | new-course | course-delta | bug | ui | seo | research-deepdive
assigned_chief: <chief-slug>
priority: hot | normal | low
deadline: <ISO date — be conservative; chiefs can ask for extensions>
success_criteria:
  - <observable outcome 1>
  - <observable outcome 2>
context:
  - source: vault/research/_daily/<date>.md
  - section: <heading>
  - related_courses: [<slug>, ...]
budget_estimate: $<USD>   # rough; per-task caps still apply
```

   Save to Paperclip via `POST /api/companies/learnova-academy/tasks`.

6. **Triage capacity**: aim for 1-3 substantial tickets per chief per day. If a chief is already at 3+ in-flight, defer non-hot items to tomorrow.

7. **Communicate**: post your daily triage as a comment on a CEO meta-task `daily-triage-<date>`:

```
07:15 ✅ Daily triage · 2026-04-29
- 3 tickets created:
  • [blog] T-1234: Anthropic 7-connector commentary → chief-content
  • [course-delta] T-1235: Update Claude tool-use Module 4 → chief-content
  • [new-course] T-1236: Stripe + Claude course outline → chief-content
- 1 deferred: "MCP from first principles" course — chief-content already at 3 tickets
- 0 rejected
- Cost guidance: chief-content's load this week is heavy; defer non-hot items to next week if Mon retro suggests budget pressure
```

## Triage heuristics

- **HOT > new > delta > deferred.** A vendor's same-day announcement deserves a same-day blog. Course-deltas can wait a few days.
- **Match worker model to ticket size.** 200-word blogs to Author + Reviewer; 5-chapter courses to full Content team; bug fixes to Engineering.
- **Don't queue 5 tickets to one chief.** Saturate at 2-3, or your chiefs become bottlenecks.
- **Bias to publish.** When in doubt, ship the smaller version (blog over course).
- **Don't over-spec success criteria.** 2-3 bullets max; trust the chief to decompose further.

## Quality gates (self-checks before posting)

- [ ] Every ticket has a clear `assigned_chief`
- [ ] Every ticket has 2-3 success criteria
- [ ] No two tickets to the same chief if either is already at 3+ in-flight
- [ ] Hot items (from brief) are all addressed (either ticketed or explicitly deferred with reason)
- [ ] Total budget estimates are within today's daily target ($30-50/day for the company)

## Failure modes

| Failure | Handling |
|---|---|
| Brief doesn't exist by 07:00 | Wait 5 min; if still missing, escalate to Chief Research; do triage with whatever's in vault/research/<vendor>/ |
| Chief Research escalated a vendor emergency overnight | Hot item gets a same-day ticket regardless of capacity |
| All chiefs at capacity | Defer non-hot items to tomorrow; document in EOD digest tonight |
| Vardaan posted an ad-hoc brief overnight (email/Slack/Paperclip) | Read it; create ticket with `priority: hot`; assign to the right chief |

## After-action

3 lines to `vault/retrospectives/ceo/<date>-daily-triage.md` written by Vardaan (manager) at the weekly retro:

```
What worked: triage decisions held up — chiefs hit deadlines on 3/3 tickets
What to fix: I queued 4 tickets to chief-content; 2 slipped — saturate at 3
SOUL update proposed: yes — change "1-3 tickets per chief" to "max 3 except hot items"
```

## Out of scope

- Writing the EOD digest (separate skill: `eod-digest`)
- Approving content (G3 alignment + G4 routing are separate skills)
- Triaging non-Academy work (this is the V1 product company's CEO; multi-product comes in V2)
