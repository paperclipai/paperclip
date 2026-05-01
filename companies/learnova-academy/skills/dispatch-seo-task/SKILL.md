---
name: dispatch-seo-task
description: >
  Chief Marketing's dispatch skill — route SEO work to seo-optimizer (pre-publish
  audits + weekly Search Console pulls + content-gap reports). Use when ticket
  lands assigned to chief-marketing.
---

# Dispatch SEO Task

You dispatch; SEO Optimizer audits.

## Scope

- Pre-publish audit tickets (triggered on G0-passed content)
- Weekly Search Console anomaly tickets
- Content-gap analysis tickets (when CEO requests)
- llms.txt regen tickets (weekly cron)

## Inputs

- Chief-Content G0-passed ticket → pre-publish audit
- Weekly cron → Search Console pull
- CEO request → content gap

## Workflow

### 1. Identify ticket type

| Trigger | Ticket type | Budget | Deadline |
|---|---|---|---|
| G0 passed content | pre-publish-audit | $0.20 | 2h before publish |
| Mon 06:00 cron | weekly-sc-pull | $0.50 | EOD Mon |
| CEO request | content-gap | $1.00 | 48h |
| Sun 00:00 cron | llms-txt-regen | $0.30 | EOD Sun |

### 2. Dispatch to seo-optimizer

```yaml
title: "[<type>] <one-liner>"
assignee: seo-optimizer
status: ready-to-audit | ready-to-pull | ready-to-analyze | ready-to-regen
deadline: <ISO>
budget: $<X>
context:
  - vault_target: vault/<path> (for content audits)
  - search_console_period: <days>
  - parent_ticket: KOE-<id> (if pre-publish)
```

### 3. Pre-publish audit handoff rules

- Block publish if seo-optimizer BLOCKs
- Pass routing to G3 if PASSes

### 4. Comment on parent ticket (pre-publish only)

```
✅ SEO audit dispatched · KOE-<id>
- @seo-optimizer (deadline <ISO>)
- Will route to G3 on PASS or back to @content-author on BLOCK
```

## Output

Paperclip ticket + parent comment.

## Notes

- SEO never modifies markdown. They suggest; Author edits.
- Page-speed regressions are engineering work — don't try to fix from marketing side.
- Pre-publish audit must run AFTER G0, BEFORE G3.

## Escalation

- Top page drops >10 positions → escalate to CEO same heartbeat
- Lighthouse regressed on Home → engineering ticket via Chief Engineering


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
