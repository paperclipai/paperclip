# Virtual Office PR Final Review

Use this file for the final pass before opening the PR. It separates the current Virtual Office open-source trial package into files that should enter the PR, local-only files, and items that still need a human look.

## Files That Belong In The PR

### 1. Virtual Office UI

- `ui/src/pages/VirtualOffice.tsx`
- `ui/src/App.tsx`
- `ui/src/App.test.tsx`
- `ui/src/components/AppHealthErrorPage.tsx`
- `ui/src/components/CloudAccessGate.tsx`
- `ui/src/components/RoutineRunVariablesDialog.tsx`
- `ui/src/components/Sidebar.tsx`
- `ui/src/pages/NewAgent.tsx`
- `ui/src/pages/ProjectDetail.tsx`
- `ui/src/pages/RoutineDetail.tsx`
- `ui/src/pages/Routines.tsx`
- `ui/src/lib/project-workflow-map.ts`
- `ui/src/lib/project-workflow-map.test.ts`
- `ui/src/lib/virtual-office-routine.ts`
- `ui/src/lib/virtual-office-routine.test.ts`
- `ui/public/virtual-office/office-reference.png`

### 2. Backend Safety And Local-Model Gates

- `packages/adapter-utils/src/server-utils.ts`
- `packages/adapter-utils/src/server-utils.test.ts`
- `packages/adapters/claude-local/src/server/prompt-cache.ts`
- `packages/db/src/migration-runtime.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/validators/agent.ts`
- `server/src/adapters/registry.ts`
- `server/src/index.ts`
- `server/src/routes/agents.ts`
- `server/src/routes/issues.ts`
- `server/src/services/heartbeat.ts`
- `server/src/services/recovery/service.ts`
- `server/src/__tests__/*.test.ts`

### 3. Preview, Verification, And Hermes Bridge Tooling

- `package.json`
- `.gitignore`
- `scripts/open-virtual-office.cmd`
- `scripts/start-virtual-office-preview.ps1`
- `scripts/watch-virtual-office-preview.ps1`
- `scripts/check-virtual-office-acceptance.mjs`
- `scripts/check-virtual-office-doc-links.mjs`
- `scripts/check-virtual-office-render-smoke.mjs`
- `scripts/capture-virtual-office-pr-screenshots.mjs`
- `scripts/check-hermes-production-wakeup-preflight.ts`
- `scripts/check-hermes-runtime-skill-preflight.ts`
- `scripts/hermes-ollama-bridge.mjs`
- `scripts/start-hermes-ollama-bridge.ps1`
- `scripts/hermes-wsl-bridge.cs`
- `scripts/hermes-wsl-query-helper.py`
- `scripts/hermes-wsl.cmd`
- `scripts/build-hermes-wsl-bridge.ps1`

### 4. Public Docs And GitHub Entry Points

- `README.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/ISSUE_TEMPLATE/virtual-office.yml`
- `docs/virtual-office-*.md`

## Do Not Include

Keep these local or ignored:

- `VIRTUAL_OFFICE_PROGRESS.md`
- `docs/virtual-office-current-handoff.zh-TW.md`
- `.paperclip-dev-config.json`
- `.virtual-office-preview-status.json`
- `.virtual-office-stability-report.json`
- `.hermes-ollama-bridge-status.json`
- `.paperclip-dev*.log`
- `paperclip-dev*.log`
- `.hermes-ollama-bridge*.log`
- `.paperclip-local/`
- `scripts/hermes-wsl.exe`
- `docs/virtual-office-screenshots/`
- Any `.env`, API key, token, password, full log, private URL, production data, or unauthorized data.

If `docs/virtual-office-screenshots/` appears again, screenshots were written to the wrong place. Move them to `.paperclip-local/virtual-office-pr-screenshots/` or delete them.

## Needs A Human Look

### Screenshots

- `pnpm run office:pr-screenshots` can now generate a full Office workbench screenshot.
- Screenshots must still be reviewed manually before attaching them to a PR.
- If the sidebar shows `live` badges, private employee names, or private task names, do not attach the raw screenshot. Use a crop or prepare clean demo data.
- The PR body should say screenshots are local preview evidence, not production data.

### English Docs

- English docs pass automated link and basic readability checks.
- A native or fluent English reader should still review them before the English-doc gate is described as fully complete.

### ROADMAP Relationship

`ROADMAP.md` has been reviewed. This PR touches areas related to Skills Manager, Scheduled Routines, local / bring-your-own agents, and agent operations, but the PR should be positioned as:

- an open-source trial workbench,
- a beginner-friendly visual operating layer,
- safety gates and documentation,
- Sandbox/Test evidence.

Do not claim that this PR completes the core roadmap features.

### PR Size

This is a large PR. If reviewers ask for a split, split in this order:

1. UI workbench.
2. Backend / Hermes safety gates.
3. Preview and verification tools.
4. Open-source docs and GitHub templates.

The first draft can still present it as one package because the UI, safety gates, docs, and acceptance checks support each other.

## Final Commands Before Opening The PR

```powershell
pnpm run office:verify
pnpm run office:pr-screenshots
git status --short
git status --ignored --short
```

For public-file safety checks, follow `docs/virtual-office-public-commit-scope.en.md`.

## Stop Lines

Opening a PR, attaching screenshots, answering reviewer comments, or updating docs is not authorization to:

- Install Hermes.
- Press Run now.
- Enable schedule triggers.
- Enable the heartbeat scheduler.
- Wake Hermes or a local model.
- Auto-retry, create a recovery issue, or open a continuation.
- Read secrets, a full `.env`, production data, or unauthorized data.
