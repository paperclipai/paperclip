---
phase: 1
title: Scaffold package
status: completed
priority: P2
effort: 2h
dependencies: []
---

# Phase 1: Scaffold package

## Overview

Create empty `packages/adapters/qwen-local` workspace package with TS config, exports, and stub entrypoints. No logic yet — just the skeleton matching `opencode-local`.

## Requirements

- Functional: pnpm workspace recognizes the package; `tsc -b` passes; `pnpm -F @paperclipai/adapter-qwen-local build` succeeds (no-op build OK).
- Non-functional: zero runtime deps beyond `@paperclipai/adapter-utils`, `@paperclipai/shared`.

## Architecture

Mirror `packages/adapters/opencode-local`. Same `exports` map (`.`, `./server`, `./ui`, `./cli`). Same dist build pattern. Re-uses adapter-utils execution-target plumbing — do not invent a parallel runner.

## Related Code Files

- Create:
  - `packages/adapters/qwen-local/package.json`
  - `packages/adapters/qwen-local/tsconfig.json`
  - `packages/adapters/qwen-local/src/index.ts` (constants only — full content in Phase 3)
  - `packages/adapters/qwen-local/src/server/index.ts` (re-exports)
  - `packages/adapters/qwen-local/src/cli/index.ts` (empty re-export)
  - `packages/adapters/qwen-local/src/ui/index.ts` (empty re-export)
  - `packages/adapters/qwen-local/README.md` (one paragraph)
- Modify:
  - `pnpm-workspace.yaml` — verify `packages/adapters/*` glob already includes new package (likely no change needed).
  - Root `tsconfig.json` references if explicit project refs exist (mirror opencode-local entry).

## Implementation Steps

1. `cp -R packages/adapters/opencode-local packages/adapters/qwen-local` then strip `src/server/*.ts` bodies to empty re-exports.
2. Edit `package.json`: rename `name` → `@paperclipai/adapter-qwen-local`, reset `version` to `0.1.0`, drop OpenCode-specific scripts if any. Keep `exports` map identical in shape.
3. Edit `tsconfig.json` references to match new path.
4. Stub `src/index.ts` exports: `type = "qwen_local"`, `label = "Qwen (local / vLLM)"`, `SANDBOX_INSTALL_COMMAND = "npm install -g @qwen-code/qwen-code"` (verify exact npm name during impl), `DEFAULT_QWEN_LOCAL_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8"`, empty `models` and `modelProfiles` arrays, empty `agentConfigurationDoc` string. Real content in Phase 3.
5. Run `pnpm install` at repo root, then `pnpm -F @paperclipai/adapter-qwen-local build`.

## Success Criteria

- [x] `pnpm install` clean.
- [x] `pnpm -F @paperclipai/adapter-qwen-local build` succeeds.
- [x] `tsc -b` at repo root green.
- [x] No new lint errors.

## Risk Assessment

- Risk: forgetting a TS project reference → cascading build break. Mitigation: copy all references from opencode-local entry verbatim.
- Risk: stale OpenCode strings left in copied files. Mitigation: grep `opencode|OpenCode|OPENCODE` in new package after copy; only `qwen` should remain.
