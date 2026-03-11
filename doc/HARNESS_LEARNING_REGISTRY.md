---
Owner: Engineering
Last Verified: 2026-03-11
Applies To: paperclip monorepo
Links: [HARNESS_SCORECARD](HARNESS_SCORECARD.md), [QUALITY_SCORE](QUALITY_SCORE.md)
---

# Harness Learning Registry

Track unknowns as explicit experiments with metrics, owners, and decisions.

## Active Experiments

| # | Hypothesis | Metric | Owner | Window | Decision | Follow-up |
|---|-----------|--------|-------|--------|----------|-----------|
| 1 | Import boundary linter catches real violations before merge | Violations caught per month | Platform | 2026-Q2 | Pending | - |
| 2 | Risk-tier classification reduces high-risk merge incidents | High-risk policy violations/month | Engineering | 2026-Q2 | Pending | - |
| 3 | Agent PR evidence sections improve first-review quality | PR revision rate for agent PRs | Engineering | 2026-Q2 | Pending | - |
| 4 | Weekly entropy cleanup reduces stale code accumulation | Entropy scan candidate count trend | Engineering | 2026-Q2 | Pending | - |
| 5 | Contract tests prevent cross-company access regressions | Contract test failures in CI | Server | 2026-Q2 | Pending | - |
| 6 | Docs:lint prevents documentation drift | Doc freshness compliance rate | Platform | 2026-Q2 | Pending | - |
| 7 | Harness runner improves CI failure diagnosis time | Time-to-diagnosis for CI failures | Platform | 2026-Q2 | Pending | - |
| 8 | Shared validator drift guard catches API shape changes | Validator export stability failures | Server | 2026-Q2 | Pending | - |
| 9 | Fast lane for low-risk PRs reduces median cycle time | Median PR cycle time (low-risk) | Engineering | 2026-Q2 | Pending | - |
| 10 | Scorecard weekly updates maintain team awareness | Consecutive weeks with scorecard update | Engineering | 2026-Q2 | Pending | - |

## Completed Experiments

| # | Hypothesis | Decision | Date | Outcome |
|---|-----------|----------|------|---------|
| - | - | - | - | - |

## Template

When adding a new experiment:
- **Hypothesis**: What you believe will happen
- **Metric**: How you will measure it (must be observable)
- **Owner**: Who tracks and decides
- **Window**: When the experiment ends
- **Decision**: Accept/reject/extend (filled at window end)
- **Follow-up**: Next action after decision
