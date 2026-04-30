---
phase: 61
slug: release-channels-and-signed-updater
status: passed
verified: 2026-04-30
requirements_verified:
  - DIST-04
  - DIST-05
plans_verified:
  - 61-01-PLAN.md
---

# Phase 61 Verification: Release Channels and Signed Updater

## Result

Status: `passed`

Phase 61 delivered a release channel and signed updater evidence gate that validates `internal`, `beta`, and `stable` channel metadata, per-platform artifact URLs/checksums/signatures, rollout policy, rollback candidate, installed build identity, update lifecycle state, Phase 60 signing prerequisites, and updater secret hygiene. Missing or invalid evidence produces stable blockers and a non-zero command exit.

## Requirement Evidence

| Requirement | Evidence | Status |
|-------------|----------|--------|
| DIST-04 | `scripts/rt2-release-channel-gate.mjs` requires all three native release channels, version/build identity, artifact URL, SHA-256 checksum, updater signature content, rollout policy, rollback candidate, and per-platform metadata. Focused tests cover complete fixtures, missing stable channel, missing rollback candidate, and local artifact checksum mismatch. | passed |
| DIST-05 | `scripts/rt2-release-channel-gate.mjs` validates updater feed fields, installed channel/build identity, update state vocabulary, signature content that is not a path/URL, Phase 60 signing summary references, and secret hygiene. Focused tests cover blocked signing summaries, signature path rejection, raw secret rejection, and CLI JSON execution. | passed |

## Automated Checks

| Command | Result |
|---------|--------|
| `node scripts/rt2-release-channel-gate.test.mjs` before implementation | failed as expected because `scripts/rt2-release-channel-gate.mjs` did not exist |
| `pnpm run test:release-channel-gate` | passed |
| `pnpm typecheck` | passed |
| `pnpm test` | failed with one timeout in `server/src/__tests__/workspace-runtime.test.ts` |
| `pnpm --filter @paperclipai/server exec vitest run src/__tests__/workspace-runtime.test.ts -t "runs a configured provision command inside the derived worktree"` | passed |
| `git diff -- pnpm-lock.yaml` | clean |

## Workspace Check Note

After Phase 61 completion, `pnpm test` was run as a broader workspace check. It failed with one timeout in `server/src/__tests__/workspace-runtime.test.ts` for `runs a configured provision command inside the derived worktree`; the failing test passed when rerun directly with `pnpm --filter @paperclipai/server exec vitest run src/__tests__/workspace-runtime.test.ts -t "runs a configured provision command inside the derived worktree"`. No Phase 61 files were implicated by that timeout.

## Coverage Notes

- Complete fixture manifests pass and write durable `summary.json` plus `report.md` evidence.
- Missing `stable` channel produces a blocker.
- Missing rollback candidate produces a blocker.
- Signature paths and URLs are blocked because updater signatures must be signature content.
- Local artifact checksum mismatches are blocked when an `artifact` path is provided.
- Phase 60 signing summary references must exist, be `passed`, and match the platform.
- Raw updater private key, token, password, and private-key text are rejected.
- Operator docs describe manifest shape, output directory, rollout/rollback policy, Phase 60 prerequisite, and secret hygiene.

## Residual Risk

- This phase validates release channel and updater evidence contracts. It does not build a native app, host an update server, or publish real updater feeds.
- Real macOS/Windows release artifacts and updater signatures remain operator-provided evidence inputs.
- Phase 64 should aggregate this updater/channel gate with signing, resident/tray, push, and v2.9 capture regression gates.

## Self-Check

PASSED - all Phase 61 must-haves and success criteria are represented in code, tests, docs, and planning artifacts.
