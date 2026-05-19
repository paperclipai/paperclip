# Virtual Office PR Submission Plan

Use this file before opening the actual PR. It turns the current Virtual Office open-source trial work into a reviewable submission package: file scope, PR body draft, verification, and safety stop lines.

## Suggested PR Title

```text
Add Virtual Office open-source trial workbench and safety gates
```

## Suggested Commit Scope

### UI And Frontend Flow

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
- `ui/public/virtual-office/`

### Backend And Safety Gates

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
- `server/src/__tests__/adapter-registry.test.ts`
- `server/src/__tests__/claude-local-execute.test.ts`
- `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
- `server/src/__tests__/heartbeat-process-recovery.test.ts`
- `server/src/__tests__/issue-comment-reopen-routes.test.ts`
- `server/src/__tests__/issue-update-comment-wakeup-routes.test.ts`

### Preview, Hermes, And Verification Tooling

- `package.json`
- `.gitignore`
- `scripts/open-virtual-office.cmd`
- `scripts/start-virtual-office-preview.ps1`
- `scripts/watch-virtual-office-preview.ps1`
- `scripts/check-virtual-office-acceptance.mjs`
- `scripts/check-virtual-office-doc-links.mjs`
- `scripts/check-virtual-office-render-smoke.mjs`
- `scripts/check-hermes-production-wakeup-preflight.ts`
- `scripts/check-hermes-runtime-skill-preflight.ts`
- `scripts/hermes-ollama-bridge.mjs`
- `scripts/start-hermes-ollama-bridge.ps1`
- `scripts/hermes-wsl-bridge.cs`
- `scripts/hermes-wsl-query-helper.py`
- `scripts/hermes-wsl.cmd`
- `scripts/build-hermes-wsl-bridge.ps1`

### Public Docs And GitHub Entry Points

- `README.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/ISSUE_TEMPLATE/virtual-office.yml`
- `.github/ISSUE_TEMPLATE/config.yml`
- `docs/virtual-office-*.md`

## Do Not Include

- `VIRTUAL_OFFICE_PROGRESS.md`
- `docs/virtual-office-current-handoff.zh-TW.md`
- `.paperclip-dev-config.json`
- `.virtual-office-preview-status.json`
- `.virtual-office-stability-report.json`
- `.hermes-ollama-bridge-status.json`
- `.paperclip-dev*.log`
- `paperclip-dev*.log`
- `.hermes-ollama-bridge*.log`
- `scripts/hermes-wsl.exe`
- Any `.env`, API key, token, password, full log, private path, production data, or unauthorized data.

## PR Body Draft

```markdown
## Thinking Path

> - Paperclip orchestrates AI agents for zero-human companies.
> - Virtual Office makes that orchestration understandable for beginners by presenting agents, skills, projects, workflows, meetings, routines, and safety status in one workbench.
> - The previous raw model was powerful but difficult for local-model beginners to operate safely.
> - This PR adds the Virtual Office trial workbench, preview recovery tooling, open-source onboarding docs, and Hermes/local-model safety gates.
> - It keeps Hermes wake-up, Run now, schedule triggers, heartbeat scheduler, recovery, continuation, and production data behind explicit stop lines.
> - The benefit is a safer open-source trial path for people who want to learn agent orchestration without accidentally starting real work.

## What Changed

- Added the Virtual Office UI, including 2.5D office view, employee/skill/project/workflow/checklist surfaces, routine safety affordances, and beginner-oriented copy actions.
- Added backend and adapter safety guards for one-time local-model wake-up, transient-error handling, recovery issue recursion, comment wake routing, and prompt/session handling.
- Added preview recovery, render smoke, acceptance sync, documentation link, and stability tooling.
- Added Hermes/Ollama and Hermes Windows/WSL bridge support with a source-first bridge build flow.
- Added Traditional Chinese and English open-source onboarding docs, release checklist, PR review SOP, feedback routing, public commit scope, and safety boundaries.
- Added GitHub issue and PR templates with sensitive-information and local-model stop lines.

## Verification

- `pnpm run office:verify`
- Public-file safety scan for local paths and inline secret assignments.
- Confirmed backend health OK, frontend OK, render smoke OK, and heartbeat scheduler `false`.

### Virtual Office verification, if applicable

- [x] I ran `pnpm run office:verify`
- [x] I checked the Office page or relevant docs manually
- [x] I updated the Virtual Office acceptance checklist / docs when behavior changed
- [x] I did not install Hermes, press Run now, enable schedule triggers, wake a local model, or include secrets in issues/docs/logs
- [x] I reviewed `docs/virtual-office-pr-review.en.md` because this PR changes Virtual Office release, onboarding, checklist, and safety flow

## Risks

- Large PR: UI, backend safety, scripts, and docs are bundled because the trial workbench depends on the safety and onboarding layers.
- Hermes/local-model production wake-up is intentionally not enabled by this PR; it still requires a specific issue, specific agent, explicit allowed scope, and a new verbatim one-time authorization.
- English documentation still benefits from fluent English reader feedback before broader public promotion.

## Model Used

- Codex in the local development environment, with tool use for filesystem edits, verification commands, and local preview checks.

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used
- [ ] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [ ] If this change affects the UI, I have included before/after screenshots
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented risks above
- [ ] I will address all Greptile and reviewer comments before requesting merge
```

## Final Check Before Opening The PR

1. Run `pnpm run office:verify` again.
2. Run `git status --short` and confirm every staged file belongs to the scope above.
3. Run `git status --ignored --short` and confirm local status files and `scripts/hermes-wsl.exe` are not staged.
4. Check README, release notes, and public status still say production Hermes/local-model wake-up requires a new verbatim one-time authorization.
5. Use `docs/virtual-office-pr-screenshot-evidence.zh-TW.md` or `docs/virtual-office-pr-screenshot-evidence.en.md` to add UI screenshots or a short recording before requesting review, because this is a visual workbench.
6. Use `docs/virtual-office-pr-final-review.zh-TW.md` or `docs/virtual-office-pr-final-review.en.md` for the final commit-scope, local-only exclusion, and human-review pass.
