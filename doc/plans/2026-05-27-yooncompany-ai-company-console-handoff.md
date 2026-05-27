# YoonCompany AI Company Console Handoff - 2026-05-27

## Purpose

This handoff records the current YoonCompany integration work that turns Paperclip into an AI company operating console:

- Paperclip is the control plane and screen manager.
- Codex is the main development worker.
- Hermes is the research/log/sub-worker.
- YoonCompany uses 6002-style small-unit execution as the default operating discipline.

This document is intended for the next Codex session before continuing the second-stage advanced improvements.

## Current Local Surface

- Workspace: `C:\yooncompany\external\paperclip`
- Local board: `http://127.0.0.1:3100/YOO/dashboard`
- API base used for smoke tests: `http://127.0.0.1:3100/api`
- Company prefix: `YOO`
- Company id: `a01eddd0-d750-43ea-8858-d1cb087c4de2`
- Main worker: `Codex Lead Engineer`
- Hermes worker id: `be227544-1898-4146-847c-19c3c40f98cc`

Use `corepack pnpm ...` for package commands. Do not use bare `pnpm` in this Windows environment unless the PATH issue has been fixed.

## Development Status Snapshot

Current status:

- Stage 1 local advanced-console integration is implemented and smoke-tested.
- The work is local only. It has not been committed, pushed, opened as a PR, or merged.
- The local dev board is reachable at `http://127.0.0.1:3100/YOO/dashboard`.
- The effective API base is `http://127.0.0.1:3100/api`; do not assume `3101` is active.
- Hermes is connected through Paperclip and can execute a real assigned smoke issue.
- Hermes model/provider configuration is confirmed as `gpt-5.5` through OpenAI Codex OAuth.
- Codex remains the intended main development worker; Hermes remains the research/sub-worker.
- Paperclip is currently the integration screen/control plane, not yet a complete finished product console.

Confirmed complete in this slice:

- Hermes OAuth diagnostic no longer blocks on missing API keys.
- Hermes E2E assignment path works on a fresh issue.
- Run-authored Hermes comments no longer cause the observed repeated `issue_commented` follow-up loop.
- Global YoonCompany question panel opens from the dashboard.
- Skills detail shows read/apply/connection state.
- Costs view distinguishes subscription-included runs from API-billed spend.
- Hermes settings make Telegram readiness explicit instead of implying that Telegram commands are already connected.
- Quick command plugin creates safer Codex/Hermes task templates.

Not complete yet:

- Full body-text Koreanization across every view.
- Free-form input inside the global question panel.
- Automatic current-screen capture/attachment into created issues.
- Telegram-to-Hermes gateway/bot dispatch.
- GitHub branch/PR connection workflow inside the UI.
- Unified Codex/Hermes log and decision search.
- Backup/restore/update-stability operation flow.
- Final branch, commit, PR, and merge.

## Completed Work

### 1. Hermes OpenAI Codex OAuth diagnostic

Hermes environment checks now treat OpenAI Codex OAuth as API-key optional.

Changed:

- `server/src/adapters/registry.ts`
- `server/src/__tests__/adapter-registry.test.ts`

Verified API result:

- `adapterType`: `hermes_local`
- `status`: `pass`
- `code`: `hermes_codex_oauth_api_key_not_required`
- `message`: OpenAI Codex OAuth provider selected; Hermes does not require an LLM API key for this Paperclip run.
- Model shown: `gpt-5.5`

### 2. Hermes E2E smoke path

Added a repeatable smoke test script:

- `scripts/yooncompany-hermes-e2e-smoke.ps1`

The script:

- resolves the `YOO` company,
- finds the Hermes agent,
- creates an assigned smoke issue,
- invokes the Hermes heartbeat run,
- waits for completion,
- verifies run success, issue status `done`, and at least one issue comment.

Latest passing run:

- Issue: `YOO-46`
- Issue id: `cf4c6b32-9be0-4ca9-ace1-66df84d02d6c`
- Run id: `8e64d12a-f302-4e0b-ad7d-b94ff117b544`
- Result: `passed=true`, `runStatus=succeeded`, `issueStatus=done`, `commentCount=1`

Command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\yooncompany-hermes-e2e-smoke.ps1 -TimeoutSec 420
```

### 3. Comment wakeup loop fix

Root cause found during E2E:

- Hermes run completed successfully and posted a completion/proposal comment.
- The comment had `createdByRunId`, but was still attributed as a board/user comment.
- The issue comment route treated it like a human comment and triggered `issue_commented` automation.
- That caused repeated Hermes follow-up runs on the same finished issue.

Fix:

- Comments carrying `actor.runId` are treated as run-authored output for implicit reopen/retry/wakeup decisions.
- Human board comments still wake assigned agents.
- Run-authored comments no longer implicitly reopen closed work or wake the assignee.

Changed:

- `server/src/routes/issues.ts`
- `server/src/__tests__/issue-comment-reopen-routes.test.ts`

Regression tests added:

- `does not reopen closed issues from board-authenticated run comments`
- `does not wake the assignee from board-authenticated run comments`

### 4. Global YoonCompany question panel

Added a fixed bottom-right global assistant panel available across the board UI.

Changed:

- `ui/src/components/YoonCompanyAssistantPanel.tsx`
- `ui/src/components/Layout.tsx`

Panel actions:

- `Codex에게 묻기`
- `화면 사용법`
- `현재 화면 분석`
- `Hermes 조사`

The panel creates Paperclip issues instead of directly performing risky actions. It includes current route context, document title, Codex 6002 operating guidance, and safe-work constraints.

Verified by browser at:

- `http://127.0.0.1:3100/YOO/dashboard`

Screenshot:

- `C:\Users\USER\AppData\Local\Temp\yooncompany-assistant-panel.png`

### 5. Korean UI and run-status improvements

Changed:

- `ui/src/components/LiveRunWidget.tsx`
- `ui/src/components/IssueChatThread.tsx`
- `ui/src/components/ActiveAgentsPanel.tsx`

Improvements:

- localized live-run labels,
- localized issue run labels,
- added status badges and liveness/progress descriptions in active agent cards.

### 6. Skills screen state clarity

Changed:

- `ui/src/pages/CompanySkills.tsx`

Added detail-state blocks:

- `읽기`
- `적용`
- `연결`

The screen now shows whether a skill is readable, editable/read-only, and attached to any agents.

### 7. Costs subscription/API distinction

Changed:

- `ui/src/pages/Costs.tsx`

Added a `구독/API 과금 구분` panel so GPT Max-style subscription usage is not confused with direct API spend.

Verified text:

- `구독형 포함 실행은 API 과금 지출과 분리해 표시하므로 GPT Max형 사용량을 직접 API 비용으로 오해하지 않습니다.`

### 8. Telegram Hermes readiness label

Changed:

- `ui/src/adapters/hermes-local/config-fields.tsx`

Added an explicit notice:

- Paperclip can run Hermes now.
- Telegram work commands require a separate Hermes gateway/bot configuration before dispatching work safely.

### 9. YoonCompany quick command plugin

Changed:

- `packages/plugins/examples/plugin-yooncompany-command/src/worker.ts`
- `packages/plugins/examples/plugin-yooncompany-command/src/ui/index.tsx`

Improvements:

- `new_task` now routes to Codex, not Hermes.
- Codex templates include 6002 small-unit verified execution guidance.
- The guide mentions the global right-side question panel.
- The guide clarifies that GitHub branch/PR organization is a later handoff/organization step.

### 10. Codex 6002 rule hardening follow-up

Changed:

- `ui/src/components/YoonCompanyAssistantPanel.tsx`
- `ui/src/components/YoonCompanyAssistantPanel.test.tsx`
- `packages/plugins/examples/plugin-yooncompany-command/src/worker.ts`
- `packages/plugins/examples/plugin-yooncompany-command/src/ui/index.tsx`
- `packages/plugins/examples/plugin-yooncompany-command/tests/worker.spec.ts`
- `packages/plugins/examples/plugin-yooncompany-command/vitest.config.ts`

Improvements:

- Codex issue templates now include the explicit `observe -> plan -> implement -> verify -> risk-report` sequence.
- The sequence tells Codex to inspect real documents/status/code/logs/screen first, plan small units, implement only the approved scope, verify with real command/browser/API/log evidence, and report files/commands/results/risks/next action.
- The global panel keeps Codex-created issues in `backlog`.
- The quick command plugin now also creates assigned issues as `backlog`, not `todo`, so quick actions no longer wake Codex/Hermes immediately.
- The quick command UI labels were changed from immediate action language to draft language: `작업 초안`, `Codex 질문 초안`, `Hermes 조사 초안`, `새 작업 초안`.

## Verification Completed

Passing:

```powershell
corepack pnpm --filter @paperclipai/ui typecheck
corepack pnpm --filter @paperclipai/server exec tsc --noEmit
corepack pnpm --filter @paperclipai/server exec vitest run src/__tests__/adapter-routes.test.ts
corepack pnpm --filter @paperclipai/server exec vitest run src/__tests__/adapter-registry.test.ts
corepack pnpm --filter @paperclipai/server exec vitest run src/__tests__/issue-comment-reopen-routes.test.ts
corepack pnpm --filter @yooncompany/paperclip-command-plugin typecheck
corepack pnpm --filter @yooncompany/paperclip-command-plugin build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\yooncompany-hermes-e2e-smoke.ps1 -TimeoutSec 420
```

Also verified:

- Browser DOM and screenshot for global question panel.
- Skills screen Korean status blocks.
- Costs screen subscription/API distinction.
- Hermes adapter diagnostic API returns `pass`.

Known test note:

- Running `adapter-registry.test.ts`, `adapter-routes.test.ts`, and `issue-comment-reopen-routes.test.ts` together once produced an `adapter-routes` beforeEach timeout and cleanup error.
- Each file passed when run independently.
- Treat this as a test isolation/timing note, not as a confirmed product regression.

## Problems, Constraints, and Risks

### Fixed in this slice

1. Hermes completion comment loop
   - Confirmed problem: a Hermes run completed and posted a comment with `createdByRunId`, but the route treated it as a human board comment.
   - Impact: the finished issue was woken again through `issue_commented`, producing repeated Hermes follow-up runs.
   - Fix: route decisions now suppress implicit reopen/retry/assignee wakeups when the actor has a run id.
   - Evidence: fresh smoke issue `YOO-46` ended with one run, one comment, and status `done`.

2. Hermes Codex OAuth warning
   - Confirmed problem: OpenAI Codex OAuth mode was still surfaced like an API-key-required path.
   - Fix: Hermes adapter diagnostics normalize the no-API-key warning to an info check in `openai-codex` mode.
   - Evidence: adapter diagnostic API returns `status=pass` with `hermes_codex_oauth_api_key_not_required`.

### Still open

1. Large dirty worktree
   - The repo contains many modified files outside this YoonCompany slice.
   - Risk: an accidental commit could include unrelated changes.
   - Required control: stage only intended YoonCompany files after reviewing `git status --short` and `git diff`.

2. Grouped server test instability
   - Observed once when three server test files were run together.
   - Each test file passed independently.
   - Current classification: test isolation/timing risk, not confirmed product failure.

3. UI author attribution nuance
   - Hermes run comments may still display as board/user authored when the request is board-authenticated, but `createdByRunId` is preserved.
   - Current fix relies on `actor.runId` for wakeup suppression.
   - Future improvement can clarify UI attribution as "run output" when `createdByRunId` is present.

4. Telegram is not connected
   - Current state is readiness labeling only.
   - Real Telegram dispatch requires a gateway/bot, auth checks, command parsing, and safe issue creation.

5. Koreanization is partial
   - Sidebar and several target surfaces are improved.
   - 2026-05-27 follow-up: additional issue detail, agent detail, and layout text was wrapped with localized copy.
   - Some body text and bundled skill content may remain English.
   - Bundled skill markdown is read-only by design; translate UI chrome first, then decide whether to add translated summaries.

6. Global question panel v2 is still an issue-draft launcher, not an execution surface
   - 2026-05-27 follow-up: it now accepts custom user text inline.
   - 2026-05-27 follow-up: it separates Codex development/decision requests from Hermes research/memory requests.
   - 2026-05-27 follow-up: generated issues default to `backlog` so assignees are not woken until a board operator changes execution status.
   - It now attaches company, route, page label, visible heading/tab/selection, browser title, and route resource identifiers as text context.
   - It does not yet attach screenshots or DOM summaries as structured attachments.

7. GitHub workflow is not complete
   - The UI does not yet guide local folder, branch, PR, and merge state.
   - Commit, push, PR, and merge remain manual/approval-controlled.

8. Hermes role/permission audit requires approval before mutation
   - Confirmed by API: Hermes is configured as `Research, memory, and report worker - repo write prohibited`, heartbeat disabled, and `repoWrite=prohibited` metadata is present.
   - Confirmed by API: Hermes currently has `permissions.canCreateAgents=true`, `permissions.canAssignTasks=true`, and an explicit `tasks:assign` grant.
   - Confirmed by API: Hermes adapter config includes `toolsets=terminal,memory,session_search,skills,web` and `extraArgs` includes `--yolo`.
   - Current control: promptTemplate forbids repo writes, deploy, merge, push, delete, DB write, email, external publish, payment, and persistent rule/memory changes.
   - Risk: prompt-only constraints are weaker than permission/config constraints.
   - Required approval before action: changing Hermes permissions, grants, adapter config, toolsets, `--yolo`, heartbeat policy, or persistent prompt/rule settings is L3.

9. Browser verification caveat: dashboard quick actions execute immediately
   - 2026-05-27 follow-up: while validating the UI, clicking the dashboard quick action `Codex에게 묻기` created Paperclip issue `YOO-47` and woke Codex.
   - Observed result: the created issue used the quick-run template; Codex found no actionable user request and created a pending `ask_user_questions` interaction asking what kind of request should be handled.
   - No deletion, status edit, or DB cleanup was performed afterward.
   - 2026-05-27 follow-up: quick command plugin code now creates `backlog` drafts and labels the buttons as drafts, but existing issue `YOO-47` remains as historical data.
   - Future verification should use the floating button `aria-label="YoonCompany 질문 패널"` for panel v2 checks, and should avoid submitting the final new-issue dialog unless explicitly testing DB writes.

## Current Git/PR Guidance

Commit, push, PR, and merge are not required yet for local continuation.

### 2026-05-27 tree cleanup status

Generated plugin artifacts and workspace links were excluded from the git source set:

- `packages/plugins/examples/plugin-yooncompany-command/node_modules/` is a pnpm workspace link directory required for local typecheck/test. It may exist locally but must stay ignored and unstaged.
- Local `dist/` is build output. It may be removed during cleanup and regenerated by `corepack pnpm --filter @yooncompany/paperclip-command-plugin build`; in either case it must stay ignored and unstaged.
- Root `.gitignore` already ignores `dist/` and `node_modules/`, so regenerated build output should remain untracked.
- Operational caveat: do not remove `dist/` while the plugin is enabled in a running Paperclip instance. During this cleanup, Paperclip observed the transient missing manifest and marked plugin `05834e61-eb70-49ba-a7d2-ed74fb1f16c2` / `yooncompany-command` as `error`.
- Current plugin files are rebuilt and present again, but lifecycle recovery requires an explicit approval before running `POST /api/plugins/05834e61-eb70-49ba-a7d2-ed74fb1f16c2/enable`.

First PR candidate should include only the YoonCompany console scope:

- `doc/plans/2026-05-27-yooncompany-ai-company-console-handoff.md`
- `packages/plugins/examples/plugin-yooncompany-command/README.md`
- `packages/plugins/examples/plugin-yooncompany-command/package.json`
- `packages/plugins/examples/plugin-yooncompany-command/src/**`
- `packages/plugins/examples/plugin-yooncompany-command/tests/**`
- `packages/plugins/examples/plugin-yooncompany-command/tsconfig.json`
- `packages/plugins/examples/plugin-yooncompany-command/vitest.config.ts`
- `ui/src/components/YoonCompanyAssistantPanel.tsx`
- `ui/src/components/YoonCompanyAssistantPanel.test.tsx`
- Koreanization/i18n files intentionally related to the console slice.

Do not include these in the first console PR without a separate review:

- `pnpm-lock.yaml`
- broad server route/middleware/service changes
- broad codex-local adapter changes
- DB backup changes
- unrelated UI Koreanization files outside the selected console slice
- generated `dist/` or `node_modules/`

Recommended order:

1. Keep this as local work until the user confirms the next stage is ready.
2. Before any PR, review the dirty worktree and separate unrelated changes.
3. Commit only the YoonCompany integration scope in a dedicated branch.
4. Open a PR for review.
5. Merge only after the user approves the final diff and smoke result.

Important:

- The worktree has many pre-existing modified files outside this YoonCompany scope.
- Do not revert unrelated files.
- If committing later, stage only the intended YoonCompany integration files.

## Next Improvement Plan

Proceed in small verified units. Do not combine unrelated UI, gateway, and Git workflow changes in one slice.

1. Residual Koreanization
   - Goal: remove confusing English from main YoonCompany operation screens.
   - Scope: dashboard, issue detail, agent detail, org, skills, costs, activity, settings.
   - Verification: browser check on desktop width; confirm no layout overlap.

2. Global question panel v2
   - Goal: make the panel usable as the default operator entry point.
   - Scope: add direct text input, task type selector, current route title, and optional current-screen context.
   - Verification: create a Codex issue and a Hermes issue from the panel without direct execution.

3. Screen context capture
   - Goal: let Codex answer "what do I do on this screen?" with better context.
   - Scope: include route, visible page title, selected entity id, and optional screenshot reference.
   - Verification: created issue body includes screen metadata and does not leak secrets.

4. Codex 6002 rule hardening
   - Goal: make Codex-created tasks consistently follow small-unit implementation and verification.
   - Scope: update templates and agent/skill attachment guidance.
   - 2026-05-27 follow-up: global panel and quick command plugin templates now include the explicit `observe -> plan -> implement -> verify -> risk-report` sequence.
   - 2026-05-27 follow-up: quick command plugin drafts remain `backlog` even when a target agent is found.
   - Verification: new Codex task body includes observe-plan-implement-verify-risk-report sequence.

5. Run/progress explanation
   - Goal: make "running, queued, failed, blocked, completed" understandable to the user.
   - Scope: timeline labels, failure-cause summaries, liveness reason display.
   - Verification: inspect active/recent run cards and issue thread run rows.

6. Skills-to-agent operation flow
   - Goal: make it clear whether bundled/custom skills can be used and which agent uses them.
   - Scope: attach/detach affordance clarity, read-only explanation, "used by" state.
   - Verification: skills detail and agent detail both show consistent attachment state.

7. Local/GitHub/PR guidance screen
   - Goal: prevent confusion between local folder, GitHub repository, branch, PR, and merge.
   - Scope: project/workspace guidance panel and safe handoff text.
   - Verification: no mutation of git state unless explicitly approved.

8. Cost reporting v2
   - Goal: separate subscription usage, direct API spend, and unknown/no-cost runs.
   - Scope: per-agent mode summary, model/provider labels, clearer empty states.
   - Verification: costs page shows subscription/API split and does not imply false billing precision.

9. Unified work log and decision search
   - Goal: search Codex/Hermes runs, comments, decisions, and issue outcomes from one place.
   - Scope: read-only search first; no automatic mutation.
   - Verification: search returns issue id, run id, agent, status, and comment/summary snippets.

10. Telegram-to-Hermes gateway
   - Goal: allow Telegram commands to create safe Paperclip issues for Hermes.
   - Scope: gateway design, auth, command mapping, rate limits, audit log, dry-run first.
   - Verification: local dry run creates a Paperclip issue but does not execute work until policy allows.

11. Backup/restore/update stability
   - Goal: make the local YoonCompany console recoverable before heavier automation.
   - Scope: database backup, config export, plugin/version notes, restore drill.
   - Verification: documented restore command or dry-run drill.

12. PR-ready cleanup
   - Goal: produce a reviewable change set.
   - Scope: inspect dirty worktree, isolate YoonCompany files, run focused checks, then commit/PR only after user approval.
   - Verification: staged diff contains only intended files.

## Next Session Start Procedure

Start the next session by reading this file first, then run:

```powershell
git status --short
corepack pnpm --filter @paperclipai/ui typecheck
corepack pnpm --filter @paperclipai/server exec tsc --noEmit
```

Then continue with the next small improvement, starting from item 1 or item 2 depending on the user's priority.
