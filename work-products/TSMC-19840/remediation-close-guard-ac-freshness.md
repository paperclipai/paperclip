# TSMC-19840 — Close-guard AC freshness (fleet)

## Class
TSMC-18738 §3 AC freshness false-tripped when:
1. `resolveIssueRunForCloseGate` excluded the actor close-out run whenever any prior issue-scoped run existed, anchoring freshness to an older pack-delivery run.
2. `acceptanceCriteriaChangedAfterRunStart` treated bare board/user substring `acceptance` (e.g. `Acceptance: NEW providerMessageId…`) as an AC mutation.

Instance: TSR-5007 / TSR-5106 / TSKB0385.

## Fix (served tree)
- `server/src/services/issue-close-evidence.ts`
  - `selectFreshestCloseGateRun` — prefer fresher of issue-scoped latest vs actor run by `startedAt`/`createdAt`.
  - `commentSignalsAcceptanceCriteriaChange` — require stronger AC-edit signals; bare `Acceptance:` receipts do not count.
  - `acceptanceCriteriaChangedAfterRunStart` uses the tightened detector.
- `server/src/routes/issues.ts`
  - `resolveIssueRunForCloseGate`: §2 still excludes self for OTHER-active block; §3 includes actor via `selectFreshestCloseGateRun`; latest scoped ordered by `coalesce(startedAt, createdAt)`.

## Verification
```text
pnpm exec vitest run server/src/services/issue-close-evidence.test.ts
# 11 tests passed (2026-08-05)
```

Regression coverage:
- actor fresher than prior pack run wins
- bare board `Acceptance: NEW providerMessageId…` is not AC mutation
- later close-out after those receipts is allowed
- real “updated acceptance criteria” / AC document updates after run start still block

## Out of scope this patch
- Optional board force-done escape for stranded completed pilots (remediation item 4) — not required for AC.

## Deploy note
Dirty-tree fix lands on served paperclip `live`. OpCo stranded pilots (e.g. TSR-5007) can retry done after this process serves the new gate.
