# TSMC-18607 closeout evidence

## Matcher change
Commit: `29863320a` on `live`
- `server/src/services/issue-capability-routing.ts`
- Bare prose `image_gen` / `video_gen` / Designer-Media / "generate an image|video" → `suggestedToolsets` only
- Hard require retained for `requires:` / `needs:` / `toolset:` / `required-skill:` prefixes and labels
- Ranking uses soft suggestions when no hard requirements

## Fixture tests
```
pnpm exec vitest run \
  src/__tests__/issue-capability-routing-prose-mentions.test.ts \
  src/__tests__/issue-capability-routing-code-fences.test.ts \
  src/__tests__/issue-capability-routing.test.ts
```
Result (2026-07-31): Test Files 3 passed; Tests 20 passed

## Live dispatch (served tree via tsx src/index.ts, cwd paperclip/server, started after commit)
1. FP: bare prose `image_gen` assigned to Astra-Codex (`e3f66845…`) → **HTTP 201** → [TSMC-18734](/TSMC/issues/TSMC-18734) (created cancelled smoke)
2. TP: `requires: image_gen` assigned to Astra-Codex → **HTTP 422** with `requiredToolsets: [image_gen]`, `suggestedAgentIds: [Designer-Media]`

## Gates
- TSMC-18601 done
- TSMC-18564 done

## Recurrence layer
Platform guard in `inferIssueToolRequirements` (hard vs soft signal split). Complements 2026-07-25 `stripCodeFences` half-fix.
