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
