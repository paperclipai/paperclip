# TSMC-20345 — Two-tier QA modelProfile routing (Child A)

**Status:** implemented in paperclip source (awaiting receipt-gated promote)  
**Policy:** TSKB0404 · ladder TSKB0042 · floors TSKB0055/VA1  
**Parent:** TSMC-20243  
**Baseline:** `work-products/TSMC-20243/baseline-14d-2026-08-07.md`

## What shipped (source)

| Surface | Path | Role |
|---|---|---|
| Classifier + mint + escalate helpers | `server/src/services/two-tier-qa-routing.ts` | Tier-1 cheap eligibility, floors, tier-2 override builder |
| Unit tests | `server/src/services/two-tier-qa-routing.test.ts` | 11 cases: mint cheap, visual-truth strong, eng skip, residual close-evidence, escalate fail fixture |
| Mint stamp | `server/src/services/issues.ts` `create` | `assigneeAdapterOverrides.modelProfile=cheap` + `twoTierQa` meta when eligible |
| Run routing | `server/src/services/heartbeat.ts` execute path | `resolveTwoTierQaIssueModelProfile` → `context.modelProfile` / `paperclipModelProfile` |
| Tier-2 on fail | `server/src/services/heartbeat.ts` `releaseIssueExecutionAndPromote` | On failed cheap product-QA run: stamp strong, system comment, re-queue with `modelProfile: strong` |

## Floors (unchanged — path cites)

| Floor | Mechanism | Code cite |
|---|---|---|
| No visual-truth on weak lane | `VISUAL_TRUTH_RE` → `requestedModelProfile=strong`, mint not applied | `two-tier-qa-routing.ts` `classifyTwoTierQa` |
| G-class money/publish/identity/delivery | `G_CLASS_RE` → strong | same |
| K25/K26 deterministic | **Not model-judged here** — still `measureCloseEvidence` / close-contract guards | `server/src/services/issue-close-evidence.ts` |
| Engineering cards mentioning QA | `ENGINEERING_NOT_QA_PASS_RE` skips cheap pin | classifier |
| close_evidence default | deterministic-only unless residual-narrative marker | classifier |
| G-class platform recovery siblings | origin allowlist leaves productivity/routine/recovery pins alone | `ORIGIN_ALREADY_CHEAP` |
| Deploy tree | receipt-gated READ-ONLY — this change is in allowed source workspace only | TSMC-20221 / TSKB0403 |

## Verification

```text
pnpm exec vitest run \
  server/src/services/two-tier-qa-routing.test.ts \
  server/src/__tests__/heartbeat-model-profile.test.ts
# Test Files  2 passed (2)
# Tests  28 passed (28)
```

Fail-fixture (unit): mint cheap on assembly QA title → `shouldEscalateTwoTierQaAfterFailedRun({ runStatus: "failed", runModelProfile: "cheap" })` → true → `buildTwoTierQaEscalateOverrides` → `modelProfile: "strong"`, `twoTierQa.tier: 2`.

## Remeasure (post-promote)

Re-run `work-products/TSMC-20243/baseline-queries.sql` with window ending ≥7d after live promote. Target: eligible product QA classes ≥80% `cheap_pct` vs baseline ~10–13%.

Pre-promote snapshot (same 14d baseline file):

| qa_class | baseline cheap_pct |
|---|---:|
| deck_video_assembly_qa | 10.0 |
| pack_lint_review | 12.9 |
| close_evidence_checks | 12.5 |
| other_qa_review_verify | 12.6 |
| platform_review_recovery | 91.2 (already) |
| productivity_review | 91.4 (already) |

**Child A does not claim ≥80% until promote + remeasure.** Parent TSMC-20243 stays open for Child B + remeasure.

## Promote path

1. Land commit on allowed paperclip source branch.
2. Promote via existing receipt-gated deploy pipeline (do not write deploy tree by hand).
3. After ≥7d live traffic, remeasure SQL → attach comparison table on parent.
