# Phase 15: Identity Shell Hardening - Summary

**Completed:** 2026-04-25
**Status:** Complete

## What Changed

- Product-facing shell/navigation copy now uses RealTycoon2, Jarvis, 작업, 프로젝트, 실행 환경 terminology.
- Command palette no longer exposes Paperclip-shaped action/group labels such as `Agents` or `Create new agent`.
- New task dialog wraps legacy issue behavior as Task/Sub-Task and uses execution environment wording instead of workspace wording.
- Jarvis management, dashboard, auth, company import/export/settings, routine, project environment, and runtime control copy were hardened away from Paperclip product identity.
- Attachment buttons use file icons instead of a paperclip-shaped icon in main task/comment surfaces.

## Verification

```sh
pnpm --filter @paperclipai/ui typecheck
pnpm exec vitest run src/components/CommandPalette.test.tsx src/components/NewIssueDialog.test.tsx src/components/WorkspaceRuntimeControls.test.tsx src/components/ProjectWorkspaceSummaryCard.test.tsx
```

Both checks passed.

## Remaining Work

- Internal `@paperclipai/*`, `issuesApi`, `/issues`, `/agents`, and related DB/API identifiers remain as compatibility and engine layer names.
- Phase 16 should convert the main workflow into a Trello-based RealTycoon2 task board instead of relying on legacy issue-shaped routes.
