---
name: weekly-retrospective
description: >
  CEO's Mon 09:00 IST routine — read all 4 chiefs' team retros from last week,
  synthesize a company-wide retrospective, batch SOUL/skill change proposals
  for G4 human approval. Used by CEO weekly.
---

# Weekly Retrospective

CEO synthesizes the week. Vardaan reads. SOUL updates batch.

## Scope

- Mon 09:00 IST run after Chiefs publish their team retros at 09:30 IST
- Wait — actually Chiefs run their team retros at 09:00 IST, CEO runs THEIRS at 09:30 IST
- One company-wide retro per week

## Inputs

- 4 chief team retros at `vault/retrospectives/_team/<team>-W<n>.md`
- Per-agent retros at `vault/retrospectives/<agent>/*.md` (last 7 days)
- Last week's company retro for trend comparison

## Workflow

### 1. Read all 4 chief team retros

For each team, capture:
- What worked
- What to fix
- SOUL change proposals

### 2. Synthesize company-wide

Identify:
- Cross-team patterns (e.g., "3 chiefs flagged budget pressure → company-wide signal")
- One-off issues (e.g., "Engineering had a flaky-test week")
- Wins (specific praise; pull names from chief retros)

### 3. Compute weekly metrics

```bash
# From Paperclip task API
GET /api/companies/.../tasks?period=last-week
GET /api/costs/summary?period=last-week
```

Capture:
- Total tickets shipped (G4-approved)
- Total tickets in flight
- Total cost vs budget
- Per-team utilization
- 5-gate cycle averages (G0 time, G_code time, G2 time, G3-to-G4 time)

### 4. Write the retro

`vault/retrospectives/_company/W<n>.md`:

```markdown
---
date: 2026-04-30
week: 17
ceo: ceo
total_tickets_shipped: 14
total_tickets_inflight: 4
total_spend_usd: 142.30
budget_utilization: 21%
---

# Company retro · W17 2026

## Highlights
- 14 tickets shipped (3 above target)
- @researcher-community caught the MCP-postgres trend 24h before vendor channels — well done
- New feature: SkillGraph lessons component (G2 PASS first try)

## Cross-team patterns
- Budget pressure on chief-engineering (78% monthly used) — propose raising next month or trimming scope
- Author → Reviewer chain healthy (PASS rate revision 1 = 11/14)

## What we'll fix next week
- engineering tickets running 1.5× plan estimate — Planner will tighten plans (skill update proposed)
- llms.txt drifted by 3 entries — automated freshness check landing W18

## SOUL/skill update proposals (for G4)
- [ ] **plan-mode-harness skill**: add "Verify-before-plan" step where Planner re-checks file paths exist before writing the plan (chief-engineering proposal)
- [ ] **content-review skill**: add explicit per-dimension justification in PASS comments (chief-content proposal, anti-rubber-stamp)
- [ ] **researcher-anthropic SOUL**: raise per-task cap to $0.75 on HOT-flagged days (chief-research proposal)

## Numbers
- 5-gate cycle averages:
  - G0: 28 min (target ≤30)
  - G_code: 41 min (target ≤45)
  - G2: 18 min (target ≤20)
  - G3 → G4: 4h (target ≤4h)
- Top 3 cost agents this week: ceo $19, chief-engineering $32, content-author $24

## Praise
- @planner: 5/5 plans followed without re-plan requests
- @qa-verifier: caught a regression in catalog page nobody else saw
- @researcher-google: NotebookLM API change flagged early; saved slide-audio-producer from breakage
```

### 5. Route SOUL/skill proposals to G4

Single email to Vardaan with:
- Subject: `Weekly SOUL update batch · W<n> · <N> proposals`
- Body: numbered list with rationale + which agent + before/after diff
- Three action buttons: Approve all | Approve selected | Reject batch

### 6. Comment on the weekly meta-task

```
✅ Weekly retro · W<n> · vault/retrospectives/_company/W<n>.md
- <N> SOUL proposals routed to Vardaan (G4)
- 14 ships, 78% budget utilization, all teams healthy
```

## Output

Vault retro + email to Vardaan + meta-task comment.

## Notes

- Run AFTER all 4 chiefs publish their team retros (sequential, not parallel)
- Praise specifically. Vardaan reads this; team morale matters.
- Don't auto-apply SOUL changes — that's G4 (human).

## Escalation

- A chief didn't publish their team retro → ping them; if no response in 30 min, write the company retro without their input + flag the missing input
- Company-wide budget >90% utilization → escalate to Vardaan immediately (don't wait for Mon retro)
