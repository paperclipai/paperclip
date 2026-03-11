---
Owner: Server + UI + Platform
Last Verified: 2026-03-11
Applies To: paperclip monorepo
Links: [Adoption Plan](plans/2026-03-11-harness-engineering-adoption-plan.md)
Update Cadence: Weekly
---

# Harness Engineering Scorecard

## Parameters

| # | Parameter | Baseline | Target | Current | Metric Source |
|---|-----------|----------|--------|---------|---------------|
| 1 | Agent-first bootstrap | 25 | 80 | 25 | Manual review of new subsystem creation flow |
| 2 | Engineer role redefinition (steer > hand-code) | 55 | 90 | 55 | AGENTS.md completeness + escalation policy existence |
| 3 | Application legibility | 65 | 95 | 65 | Harness runner existence + artifact collector + deterministic output |
| 4 | Repo knowledge as system of record | 70 | 95 | 70 | CI docs:lint pass rate + doc freshness check |
| 5 | Agent legibility as explicit objective | 60 | 95 | 60 | ADR count + invariant doc coverage + contract test count |
| 6 | Enforce architecture and taste mechanically | 58 | 92 | 58 | arch:lint pass + import boundary rule count |
| 7 | Throughput-driven merge philosophy | 45 | 90 | 45 | PR cycle time by risk tier + fast-lane usage rate |
| 8 | Clarify what agent-generated means | 35 | 88 | 35 | PR evidence checker pass rate |
| 9 | Increase autonomy levels | 40 | 85 | 40 | Single-command harness success rate |
| 10 | Entropy and garbage collection | 52 | 90 | 52 | Cleanup backlog size + weekly burn-down |
| 11 | Institutionalize learning loop | 68 | 90 | 68 | Learning registry entry count + experiment completion rate |

**Overall Score:** 52 (baseline) / Target: >=85

## Scoring Method

Each parameter is scored 0-100 based on its metric source. The overall score is the unweighted average of all 11 parameters rounded to the nearest integer.

## Update History

| Date | Overall Score | Updated By | Notes |
|------|---------------|------------|-------|
| 2026-03-11 | 52 | Harness adoption plan | Baseline measurement |

## Quarterly Delta

| Quarter | Score | Delta | Key Changes |
|---------|-------|-------|-------------|
| 2026-Q1 | 52 | - | Baseline |

## Quarterly Recalibration Process

At the end of each quarter:

1. Re-score all 11 parameters against their metric sources
2. Update the Current column in the Parameters table
3. Calculate new overall score
4. Add row to Quarterly Delta table
5. Review Learning Registry experiments that ended this quarter
6. Update targets if any parameter has structurally changed scope
7. Present delta to team in quarterly review
