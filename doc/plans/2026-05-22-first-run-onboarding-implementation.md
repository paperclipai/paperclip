# First-Run Onboarding Implementation Tracker

Date: 2026-05-22
Status: Waves 1-29 implemented locally

## Goal

Replace the first-run onboarding wizard with a safer staged flow:

1. scan a local project directory with deterministic backend safety limits
2. recommend a company, team, workspace, secrets, MCPs, and starter issue
3. apply the accepted setup transactionally
4. support `agy_local` as the canonical Antigravity/Gemini 3.5 Flash adapter for new Google-backed local work

This tracker intentionally keeps implementation state in one repo plan file while the feature is being built.

## Wave 1: Stage 0 Directory Scan

Implementation status: completed locally.

Implemented behavior:

- Added `POST /api/onboarding/scan`.
- The route is board-only and side-effect-free.
- The request requires an absolute path and canonicalizes it with `realpath`.
- Sensitive roots are rejected before traversal, including credential directories, Paperclip state, OS roots, and macOS canonical `/private/etc` and `/private/var` aliases.
- Heavy/generated directories are ignored, including `.git`, `node_modules`, build outputs, cache folders, coverage folders, and `vendor`.
- Symlinks are reported but not followed.
- Scan limits are enforced: max depth `3`, max entries `500`, max stat calls `1000`, timeout `5000ms`.
- Secret-looking files such as `.env`, private keys, certificates, token files, and credential files are never read.
- Safe manifest parsing is bounded to `package.json` dependency names only.
- Empty/readme-only folders return `repoKind: "empty"`.
- Brownfield folders with source files or safe manifests return `repoKind: "brownfield"`.
- Limit/time-stop cases return `repoKind: "too_large"` with warnings.

Implemented files:

- `packages/shared/src/validators/onboarding.ts`
- `server/src/services/onboarding-scan.ts`
- `server/src/routes/onboarding.ts`
- `server/src/__tests__/onboarding-scan.test.ts`
- route/export wiring in shared and server entrypoints

Verification:

- `pnpm exec vitest run server/src/__tests__/onboarding-scan.test.ts`
- `pnpm -r typecheck`

## Wave 2: Stage 0 UI

Implementation status: completed locally.

Implemented behavior:

- Added a small UI onboarding API client for `POST /api/onboarding/scan`.
- Global `/onboarding` now starts at Stage 0 scan.
- Company-prefixed onboarding and explicit add-agent onboarding still start at the existing agent setup step.
- The wizard now accepts an absolute folder path, runs the backend scan, and shows sanitized repo kind, file/dir/ignored counts, detected stack badges, and warnings.
- The Stage 0 screen includes a manual setup escape hatch that skips directly to the previous company setup flow.
- Brownfield scans prefill the starter task as a codebase health audit.
- Empty scans prefill the starter task as an approved scaffold planning task.
- Restricted and too-large scan outcomes stay on Stage 0 and require either a different path or manual setup.

Implemented files:

- `ui/src/api/onboarding.ts`
- `ui/src/components/OnboardingWizard.tsx`
- `ui/src/lib/onboarding-route.ts`
- `ui/src/lib/onboarding-route.test.ts`
- API export wiring in `ui/src/api/index.ts`

Verification:

- `pnpm exec vitest run ui/src/lib/onboarding-route.test.ts`
- `pnpm -r typecheck`

## Wave 3: Deterministic Recommendation Service

Implementation status: completed locally.

Implemented behavior:

- Added `POST /api/onboarding/recommend`.
- The route is board-only and side-effect-free.
- The request accepts the sanitized scan response and optional operator goals.
- Recommendations are deterministic and do not call an LLM yet.
- Recommendations include `claude_local`, `codex_local`, and `agy_local`.
- `codex_local` uses the existing Codex default model from the Codex adapter package.
- `agy_local` is pinned to `gemini-3.5-flash`.
- `gemini_local` is never returned for new onboarding recommendations.
- Empty folders receive an approved-scaffold-planning starter issue rather than file-write instructions.
- Brownfield folders receive a codebase health audit and diagnostics starter issue.

Implemented files:

- `packages/shared/src/validators/onboarding.ts`
- `server/src/services/onboarding-recommend.ts`
- `server/src/routes/onboarding.ts`
- `server/src/__tests__/onboarding-recommend.test.ts`
- API export update in `ui/src/api/onboarding.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/onboarding-scan.test.ts server/src/__tests__/onboarding-recommend.test.ts`
- `pnpm -r typecheck`

## Wave 4: Transactional Apply Endpoint

Implementation status: completed locally.

Implemented behavior:

- Added `POST /api/onboarding/apply`.
- The route is board-only and mutating.
- The request accepts the accepted recommendation payload shape: proposed company, squads, project workspace, and starter issue.
- Apply validation rejects legacy `gemini_local` by schema because only `claude_local`, `codex_local`, and `agy_local` are accepted.
- Apply validation rejects stale Gemini model IDs on `codex_local`.
- Apply validation pins `agy_local` to `gemini-3.5-flash`.
- The service creates the accepted setup in one database transaction:
  - company with a unique issue prefix
  - default local environment
  - active company-level root goal
  - recommended agents
  - planned primary project
  - primary local-path project workspace
  - assigned starter issue
  - onboarding and starter issue activity logs
- The selected repository path is stored on `project_workspaces.cwd`.
- The starter issue receives the first company identifier, for example `MYA-1`.
- `codex_local` persists its Codex model in `agents.adapter_config.model`.
- `agy_local` persists `gemini-3.5-flash` in `agents.adapter_config.model`.

Implemented files:

- `packages/shared/src/validators/onboarding.ts`
- `server/src/services/onboarding-apply.ts`
- `server/src/routes/onboarding.ts`
- `server/src/app.ts`
- `server/src/services/index.ts`
- `server/src/__tests__/onboarding-apply.test.ts`
- `ui/src/api/onboarding.ts`
- shared export wiring in `packages/shared/src/validators/index.ts` and `packages/shared/src/index.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/onboarding-scan.test.ts server/src/__tests__/onboarding-recommend.test.ts server/src/__tests__/onboarding-apply.test.ts`
- `pnpm -r typecheck`

## Wave 5: Recommendation Review and Apply UI

Implementation status: completed locally.

Implemented behavior:

- The Stage 0 screen now accepts an optional setup focus before scanning.
- The Stage 0 folder path can be pasted directly or selected with a local native folder picker from the Paperclip host.
- The setup focus copy now frames the field as optional and says the onboarding assistant can help shape it after the scan.
- Large project scans are treated as partial safe samples, not blockers.
- The scan budget was raised to support normal large-repo onboarding while still bounding traversal.
- Successful brownfield/greenfield scans call `POST /api/onboarding/recommend`.
- Successful partial large-repo scans also call `POST /api/onboarding/recommend`.
- The wizard switches from the old manual path into a review-before-create path when recommendations are available.
- The review screen shows and permits editing:
  - company name
  - operating focus/company description
  - starter issue title
  - starter issue description
- The review screen shows non-editable recommendation evidence for:
  - recommended agent squad
  - adapter types and pinned models
  - primary workspace path/name
  - deferred MCP setup
  - OAuth/session setup checks for Claude, Codex, and Antigravity
- The review flow calls `POST /api/onboarding/apply` and navigates directly to the created starter issue.
- The previous manual company -> agent -> task -> launch path remains available through the manual skip action and company-prefixed onboarding paths.

Implemented files:

- `ui/src/components/OnboardingWizard.tsx`
- `ui/src/api/onboarding.ts`
- `server/src/services/onboarding-scan.ts`
- `server/src/services/onboarding-directory-picker.ts`
- `server/src/routes/onboarding.ts`
- `server/src/__tests__/onboarding-scan.test.ts`
- `server/src/__tests__/onboarding-directory-picker.test.ts`
- shared onboarding response contract exports

Verification:

- `pnpm --filter @paperclipai/ui typecheck`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm --filter @paperclipai/shared typecheck`
- `pnpm exec vitest run server/src/__tests__/onboarding-scan.test.ts server/src/__tests__/onboarding-recommend.test.ts`
- `pnpm exec vitest run server/src/__tests__/onboarding-directory-picker.test.ts server/src/__tests__/onboarding-scan.test.ts server/src/__tests__/onboarding-recommend.test.ts server/src/__tests__/onboarding-apply.test.ts`
- `pnpm exec vitest run server/src/__tests__/onboarding-apply.test.ts`
- Browser smoke at `http://127.0.0.1:3100/onboarding` with `PAPERCLIP_HOME=/tmp/paperclip-wave5 pnpm dev`:
  - scanned `/private/tmp/paperclip-onboarding-smoke`
  - rendered the recommended review screen
  - created `Paperclip Onboarding Smoke Company`
  - navigated to `/PAP/issues/PAP-1`

## Wave 6: OAuth-First Local Adapter Readiness

Implementation status: completed locally.

Implemented behavior:

- First-run recommendations no longer ask for provider API keys for `claude_local`, `codex_local`, or `agy_local`.
- Recommendations now include local OAuth/session setup checks for Claude Code, Codex, and Antigravity.
- `agy_local` is registered as a built-in local adapter using Antigravity CLI (`agy`) with the canonical `gemini-3.5-flash` model.
- `agy_local` uses local Google OAuth/session state and reports quota as warn-only because Antigravity CLI does not expose machine-readable quota windows yet.
- The Costs provider view includes quota-only providers so Google/Antigravity status is visible even before cost events exist.
- Manual/new-agent UI defaults understand `agy_local` and keep `gemini_local` legacy-only for new onboarding recommendations.

Implemented files:

- `server/src/adapters/agy-local.ts`
- `server/src/adapters/registry.ts`
- `server/src/services/onboarding-recommend.ts`
- `server/src/services/quota-windows.ts`
- `ui/src/adapters/agy-local/index.ts`
- `ui/src/components/OnboardingWizard.tsx`
- shared onboarding/quota contracts

Verification:

- `pnpm exec vitest run server/src/__tests__/onboarding-recommend.test.ts server/src/__tests__/adapter-registry.test.ts`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm --filter @paperclipai/ui typecheck`
- `pnpm --filter @paperclipai/shared typecheck`
- `pnpm --filter @paperclipai/adapter-utils typecheck`

## Wave 7: AI-Assisted Editable Review

Implementation status: completed locally.

Implemented behavior:

- `POST /api/onboarding/recommend` now attempts an AI-generated recommendation through the local Codex OAuth/session path outside test runs.
- AI input is limited to the bounded sanitized scan summary, safe manifest indicators, counts, stacks, warnings, and optional operator focus; raw source files are not sent.
- If local Codex is unavailable, slow, or returns malformed output, onboarding falls back to the deterministic recommender with a visible warning.
- Deterministic fallback copy is more specific for company operating focus and starter issue descriptions.
- `GET /api/onboarding/adapter-options` exposes pre-company provider/model options for Claude, Codex, and Antigravity.
- The review step now allows editing each xAgent squad member's provider and model before apply.
- `agy_local` remains model-locked to `gemini-3.5-flash`; Codex and Claude expose their known model lists.
- Provider setup copy now presents existing local OAuth connections instead of provider API-key setup.
- MCPs are shown as configure-later recommendations and are not blocking setup.

Implemented files:

- `packages/shared/src/validators/onboarding.ts`
- `server/src/services/onboarding-recommend.ts`
- `server/src/routes/onboarding.ts`
- `server/src/__tests__/onboarding-recommend.test.ts`
- `ui/src/api/onboarding.ts`
- `ui/src/components/OnboardingWizard.tsx`
- shared onboarding contract exports

Verification:

- `pnpm exec vitest run server/src/__tests__/onboarding-recommend.test.ts server/src/__tests__/onboarding-apply.test.ts`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm --filter @paperclipai/ui typecheck`
- `pnpm --filter @paperclipai/shared typecheck`

## Wave 8: Deferred Non-Provider Secrets

Implementation status: completed locally.

Implemented behavior:

- Recommendations now include optional, non-provider secret setup guidance for GitHub automation, project runtime environment values, deployment tokens, and webhook signing secrets where relevant.
- Provider API keys for Claude, Codex, and Antigravity remain excluded; those adapters use local OAuth/session state.
- Optional secrets are explicitly marked as not required for onboarding and as future `local_encrypted` entries.
- Secret capture remains outside `POST /api/onboarding/apply`; company creation is not blocked by missing external-service credentials.
- The review step renders optional secret guidance separately from local OAuth checks and configure-later MCPs.

Implemented files:

- `packages/shared/src/validators/onboarding.ts`
- `server/src/services/onboarding-recommend.ts`
- `server/src/__tests__/onboarding-recommend.test.ts`
- `ui/src/components/OnboardingWizard.tsx`

Verification:

- `pnpm exec vitest run server/src/__tests__/onboarding-recommend.test.ts`
- `pnpm --filter @paperclipai/shared typecheck`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm --filter @paperclipai/ui typecheck`

## Wave 9: First-Run Onboarding E2E Coverage

Implementation status: completed locally.

Implemented behavior:

- Replaced the legacy manual onboarding browser test with coverage for the Stage 0 scan -> recommended review -> apply flow.
- Brownfield E2E coverage now creates a temporary React/TypeScript repo, scans it, verifies optional secrets and OAuth connection guidance, edits a squad provider selection, applies setup, and verifies created company, agents, project workspace, and starter issue through the API.
- Greenfield E2E coverage now verifies empty/readme-only folders become scaffold-planning reviews and preserve the no-file-write-until-approval instruction.
- Restricted-path E2E coverage now verifies sensitive paths stay on the scan step with a clear operator-facing error.
- Large-repo E2E coverage now creates a bounded large fixture, verifies safety-limit scans continue into recommended review, and confirms the audit starter issue path remains available.
- The E2E web server disables AI recommendations with `PAPERCLIP_ONBOARDING_AI_RECOMMENDATIONS=0` so CI/local browser runs are deterministic and do not depend on local Codex OAuth availability.

Implemented files:

- `tests/e2e/onboarding.spec.ts`
- `tests/e2e/playwright.config.ts`

Verification:

- `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/onboarding.spec.ts`
- `pnpm exec vitest run server/src/__tests__/onboarding-scan.test.ts server/src/__tests__/onboarding-recommend.test.ts server/src/__tests__/onboarding-apply.test.ts`

## Wave 10: Onboarding UX Hardening From E2E Findings

Implementation status: completed locally.

Implemented behavior:

- Review form fields now have accessible labels and stable test IDs for company name, operating focus, starter issue title, and starter issue description.
- Review squad provider/model selects now have accessible names and stable test IDs, so E2E can target specific squad rows without positional selectors.
- Scan warnings are preserved when the wizard advances from Scan to Review, including large-repo bounded sampling warnings.
- Successful recommended setup now navigates to the starter issue with an onboarding completion query flag.
- On onboarding-created starter issues, the issue page shows a "Finish deferred setup" affordance with links to configure optional secrets and external tool/MCP-adjacent adapter settings.
- Added `onboarding` to the shared built-in issue origin kind contract so the UI and server agree with the origin value already written by the apply service.
- Wave 9 E2E assertions now cover the hardened labels, review warnings, and post-apply deferred setup links.

Implemented files:

- `ui/src/components/OnboardingWizard.tsx`
- `ui/src/pages/IssueDetail.tsx`
- `packages/shared/src/constants.ts`
- `tests/e2e/onboarding.spec.ts`

Verification:

- `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/onboarding.spec.ts`
- `pnpm --filter @paperclipai/ui typecheck`
- `pnpm --filter @paperclipai/shared typecheck`
- `pnpm --filter @paperclipai/server typecheck`

## Wave 11: Persisted Deferred Setup State

Implementation status: completed locally.

Implemented behavior:

- `POST /api/onboarding/apply` now creates a company-scoped onboarding setup state row with checklist items for local OAuth/session confirmation, optional secrets, and MCP/external tool setup.
- `GET /api/companies/:companyId/onboarding-setup` exposes the persisted setup state to board users with company access.
- `PATCH /api/companies/:companyId/onboarding-setup` lets board users mark the setup state `dismissed` or `completed` and writes an activity-log event.
- Onboarding-created starter issues now keep showing the "Finish deferred setup" affordance after query strings are lost by reading the persisted company setup state.
- Operators can dismiss the setup reminder from the starter issue, and the dismissal survives navigation/reload.
- Added migration `0086_company_onboarding_setups.sql` and shared read/update contracts.

Implemented files:

- `packages/db/src/schema/company_onboarding_setups.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/migrations/0086_company_onboarding_setups.sql`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/shared/src/validators/onboarding.ts`
- `packages/shared/src/validators/index.ts`
- `packages/shared/src/index.ts`
- `server/src/services/onboarding-apply.ts`
- `server/src/services/onboarding-setup-state.ts`
- `server/src/services/index.ts`
- `server/src/routes/companies.ts`
- `server/src/__tests__/onboarding-apply.test.ts`
- `ui/src/api/companies.ts`
- `ui/src/lib/queryKeys.ts`
- `ui/src/pages/IssueDetail.tsx`
- `tests/e2e/onboarding.spec.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/onboarding-apply.test.ts`
- `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/onboarding.spec.ts`
- `pnpm --filter @paperclipai/db typecheck`
- `pnpm --filter @paperclipai/shared typecheck`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm --filter @paperclipai/ui typecheck`

## Wave 12: Item-Level Setup Checklist Updates

Implementation status: completed locally.

Implemented behavior:

- `PATCH /api/companies/:companyId/onboarding-setup` now also accepts item-level updates with `itemKey` and `itemStatus`.
- The onboarding setup service updates checklist item status in the persisted `items` JSON payload and automatically marks the whole setup `completed` when all items are complete.
- The starter issue setup reminder now renders persisted checklist items with their current status.
- Operators can mark individual setup items complete from the starter issue; the UI updates the React Query cache from the returned persisted state.
- E2E coverage verifies the local OAuth/session item can be marked complete before the setup reminder is dismissed.

Implemented files:

- `packages/shared/src/validators/onboarding.ts`
- `server/src/services/onboarding-setup-state.ts`
- `server/src/routes/companies.ts`
- `server/src/__tests__/onboarding-apply.test.ts`
- `ui/src/pages/IssueDetail.tsx`
- `tests/e2e/onboarding.spec.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/onboarding-apply.test.ts`
- `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/onboarding.spec.ts`
- `pnpm --filter @paperclipai/db typecheck`
- `pnpm --filter @paperclipai/shared typecheck`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm --filter @paperclipai/ui typecheck`

## Wave 13: Evidence-Backed Setup Checklist Refresh

Implementation status: completed locally.

Implemented behavior:

- Added `POST /api/companies/:companyId/onboarding-setup/refresh` for board users with company access.
- The refresh service derives the local OAuth/session checklist item from the latest non-expired adapter readiness probe for each active local agent (`claude_local`, `codex_local`, and `agy_local`).
- Local auth is marked complete only when every active local agent has basic readiness evidence.
- The optional secrets item is marked complete when the company has at least one non-deleted secret.
- MCP/external tool setup remains deferred until tool-connection evidence is available.
- Refresh keeps dismissed setup rows dismissed while updating checklist item evidence.
- Refresh writes an `onboarding_setup.refreshed` activity event with the resulting checklist statuses.
- The starter issue setup reminder now exposes a "Refresh setup checks" action and updates the React Query cache from the returned persisted state.
- E2E coverage verifies the refresh action remains pending when no readiness/secret evidence exists, before the operator manually marks an item complete.

Implemented files:

- `server/src/services/onboarding-setup-state.ts`
- `server/src/routes/companies.ts`
- `server/src/__tests__/onboarding-apply.test.ts`
- `ui/src/api/companies.ts`
- `ui/src/pages/IssueDetail.tsx`
- `tests/e2e/onboarding.spec.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/onboarding-apply.test.ts`
- `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/onboarding.spec.ts`
- `pnpm --filter @paperclipai/shared typecheck`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm --filter @paperclipai/ui typecheck`
- `pnpm --filter @paperclipai/db typecheck`

## Wave 14: Automatic Setup Evidence Reconciliation

Implementation status: completed locally.

Implemented behavior:

- Adapter readiness probe mutations now refresh the company onboarding setup checklist after the readiness row is recorded.
- Secret creation now refreshes the company onboarding setup checklist after the secret is created and logged.
- Remote secret import refreshes the setup checklist when at least one secret is imported.
- Secret metadata/status updates refresh the setup checklist after the update is logged.
- These automatic refreshes reuse the Wave 13 evidence rules, so local auth and optional secret checklist items can complete without relying only on the manual starter-issue refresh button.

Implemented files:

- `server/src/routes/adapter-readiness.ts`
- `server/src/routes/secrets.ts`
- `server/src/__tests__/adapter-readiness-routes.test.ts`
- `server/src/__tests__/secrets-routes.test.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/adapter-readiness-routes.test.ts`
- `pnpm exec vitest run server/src/__tests__/secrets-routes.test.ts`
- `pnpm exec vitest run server/src/__tests__/onboarding-apply.test.ts`
- `pnpm --filter @paperclipai/server typecheck`

## Wave 15: Setup-State Cache Invalidation From Secret UI

Implementation status: completed locally.

Implemented behavior:

- The Secrets settings page now invalidates the persisted onboarding setup query whenever secret lists/provider configs are invalidated after secret mutations.
- Inline secret creation from agent configuration invalidates the onboarding setup query for the selected company.
- Inline secret creation from project properties invalidates the onboarding setup query for the selected company.
- This lets open onboarding starter-issue surfaces pick up Wave 14 server-side setup reconciliation promptly after operators create or update secrets from settings/configuration UI.

Implemented files:

- `ui/src/pages/Secrets.tsx`
- `ui/src/components/AgentConfigForm.tsx`
- `ui/src/components/ProjectProperties.tsx`

Verification:

- `pnpm --filter @paperclipai/ui typecheck`

## Wave 16: MCP/External Tool Evidence

Implementation status: completed locally.

Implemented behavior:

- The onboarding setup refresh now treats MCP/external tool setup as complete when at least one ready plugin contributes agent tools through its manifest.
- Company-level plugin settings are respected: a ready tool plugin disabled for the company does not count as MCP/tool evidence.
- The Plugin Manager now invalidates the selected company's onboarding setup query after plugin install, uninstall, enable, or disable mutations so open onboarding starter-issue views can pick up tool evidence.
- Regression coverage verifies both enabled and company-disabled ready tool plugins.

Implemented files:

- `server/src/services/onboarding-setup-state.ts`
- `server/src/__tests__/onboarding-apply.test.ts`
- `ui/src/pages/PluginManager.tsx`

Verification:

- `pnpm exec vitest run server/src/__tests__/onboarding-apply.test.ts`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm --filter @paperclipai/ui typecheck`

## Wave 17: Persisted Adapter Readiness From Saved Agent Config Tests

Implementation status: completed locally.

Implemented behavior:

- The frontend API client now exposes the existing adapter-readiness probe endpoint.
- Agent configuration environment tests now record a persisted adapter-readiness probe when all of the following are true:
  - the form is editing an existing agent
  - the environment test did not fail
  - the form has no unsaved edits
  - the adapter is one of `claude_local`, `codex_local`, or `agy_local`
- After the readiness probe is recorded, the selected company's onboarding setup query is invalidated so the local OAuth/session checklist item can refresh from real evidence.
- Environment tests for unsaved drafts remain ephemeral and do not mutate readiness evidence.

Implemented files:

- `ui/src/api/agents.ts`
- `ui/src/components/AgentConfigForm.tsx`

Verification:

- `pnpm --filter @paperclipai/ui typecheck`

## Wave 18: Visible Persisted Adapter Readiness Status

Implementation status: completed locally.

Implemented behavior:

- The frontend agent API client now reads the latest persisted adapter-readiness probe for an agent.
- Existing local agent configuration forms now show a distinct "Persisted readiness" status separate from the ephemeral adapter environment test result.
- The readiness card shows the persisted status, basic readiness, operational readiness, and recorded model when available.
- Empty readiness state copy directs operators to run a saved-agent readiness check to record onboarding evidence.

Implemented files:

- `ui/src/api/agents.ts`
- `ui/src/components/AgentConfigForm.tsx`
- `ui/src/components/AgentConfigForm.test.tsx`
- `ui/src/lib/queryKeys.ts`

Verification:

- `pnpm exec vitest run ui/src/components/AgentConfigForm.test.tsx`
- `pnpm --filter @paperclipai/ui typecheck`

## Wave 19: First-Run Onboarding Browser Smoke

Implementation status: completed locally.

Verified behavior:

- Brownfield first-run onboarding scans a local project folder, reaches the recommendation review, allows provider/model review edits, applies setup, persists the primary project workspace path, and creates the starter issue.
- The starter issue setup reminder renders after onboarding apply, exposes deferred local auth, secrets, and MCP setup links, refreshes setup evidence, allows manual local-auth completion, and stays dismissed after navigation.
- Empty folders continue into scaffold planning recommendations without file-write instructions.
- Restricted paths stay on the scan step with a clear safety error.
- Large projects that reach scan safety limits still continue into the recommendation review with codebase-audit defaults and deferred setup guidance.

Verified files:

- `tests/e2e/onboarding.spec.ts`
- `tests/e2e/playwright.config.ts`

Verification:

- `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/onboarding.spec.ts`

## Wave 20: Setup Reminder Failure-State Coverage

Implementation status: completed locally.

Implemented behavior:

- Added page-level coverage for onboarding setup reminder mutation failures on the starter issue.
- The test verifies that refresh failures surface a "Could not refresh setup checks" toast with the backend error message.
- The test verifies that manual setup-item completion failures surface a "Could not update setup item" toast with the backend error message.
- The test verifies that dismissal failures surface a "Could not dismiss setup reminder" toast with the backend error message.
- The setup reminder remains visible while these failures are reported, so operators are not left with a silently failed setup action.

Implemented files:

- `ui/src/pages/IssueDetail.test.tsx`

Verification:

- `pnpm exec vitest run ui/src/pages/IssueDetail.test.tsx`
- `pnpm --filter @paperclipai/ui typecheck`

## Wave 21: Broad Verification Stabilization

Implementation status: completed locally.

Implemented behavior:

- Updated onboarding-adjacent route tests so service-barrel mocks include `onboardingSetupStateService`.
- Updated quota-window service expectations for the provider metadata contract that now returns `adapterType`, `authState`, and `quotaState`.
- Hardened the heartbeat comment wake batching coverage so the test waits for the promoted batched wake to settle and drains follow-up successful-run-handoff work before database teardown.
- Serialized the heartbeat comment wake batching and workspace runtime suites in `scripts/run-vitest-stable.mjs` so the broad local suite avoids embedded database and process-runtime contention.
- Kept the test-runner change local to `pnpm test:run`; individual focused Vitest runs continue to work directly.

Implemented files:

- `scripts/run-vitest-stable.mjs`
- `server/src/__tests__/companies-route-path-guard.test.ts`
- `server/src/__tests__/company-branding-route.test.ts`
- `server/src/__tests__/company-portability-routes.test.ts`
- `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
- `server/src/__tests__/quota-windows-service.test.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/company-branding-route.test.ts server/src/__tests__/company-portability-routes.test.ts`
- `pnpm exec vitest run server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
- `pnpm test:run`
- `pnpm -r typecheck`
- `pnpm build`

## Wave 22: Antigravity CLI Registry Completion

Implementation status: completed locally.

Implemented behavior:

- Registered `agy_local` in the Paperclip CLI adapter registry so CLI-side stdout event formatting no longer falls back to the generic `process` adapter for Antigravity runs.
- Reused the existing Gemini JSONL stream formatter because `agy_local` currently shares the Google/Gemini-compatible stream shape while exposing the new Antigravity adapter identity.
- Added focused CLI registry coverage proving `agy_local` resolves to the Antigravity/Gemini formatter.
- Updated the product goal copy to name Antigravity as the canonical Google local lane while retaining Gemini CLI as legacy support for existing saved agents.

Implemented files:

- `cli/src/adapters/registry.ts`
- `cli/src/__tests__/adapter-registry.test.ts`
- `doc/GOAL.md`

Verification:

- `pnpm exec vitest run cli/src/__tests__/adapter-registry.test.ts` failed before implementation with `expected 'process' to be 'agy_local'`.
- `pnpm exec vitest run cli/src/__tests__/adapter-registry.test.ts`
- `pnpm --filter paperclipai typecheck`

## Wave 23: Legacy Gemini Visual-Picker Cleanup

Implementation status: completed locally.

Implemented behavior:

- Kept `gemini_local` enabled and valid for explicit configuration so existing saved agents and migration scenarios still work.
- Hid `gemini_local` from visual new-agent picker surfaces so new Google-backed manual setup defaults toward `agy_local`.
- Updated Gemini display copy to mark it as legacy and direct new Google-backed work to Antigravity.
- Added adapter metadata coverage proving legacy Gemini remains explicitly selectable but no longer appears in visual pickers.

Implemented files:

- `ui/src/adapters/adapter-display-registry.ts`
- `ui/src/adapters/metadata.test.ts`

Verification:

- `pnpm exec vitest run ui/src/adapters/metadata.test.ts` failed before implementation with `expected true to be false`.
- `pnpm exec vitest run ui/src/adapters/metadata.test.ts`
- `pnpm --filter @paperclipai/ui typecheck`

## Wave 24: Antigravity Config Copy Cleanup

Implementation status: completed locally.

Implemented behavior:

- Added an `agy_local` UI config-field wrapper so Antigravity setup copy no longer says the instructions file is prepended to the Gemini prompt.
- Kept the shared Gemini-compatible field implementation intact for legacy `gemini_local`.
- Added focused rendering coverage proving the Antigravity adapter field copy says "Antigravity prompt" and does not leak "Gemini prompt".

Implemented files:

- `ui/src/adapters/agy-local/index.ts`
- `ui/src/adapters/agy-local/index.test.tsx`
- `ui/src/adapters/gemini-local/config-fields.tsx`

Verification:

- `pnpm exec vitest run ui/src/adapters/agy-local/index.test.tsx` failed before implementation with missing Antigravity prompt copy.
- `pnpm exec vitest run ui/src/adapters/agy-local/index.test.tsx ui/src/adapters/metadata.test.ts`
- `pnpm --filter @paperclipai/ui typecheck`

## Wave 25: Antigravity Extra Args Execution

Implementation status: completed locally.

Implemented behavior:

- `agy_local` server execution now honors `adapterConfig.extraArgs` by inserting string-array values before the prompt argument.
- This closes the contract between the existing UI config builder, which can persist extra AGY CLI args, and the server adapter runtime.
- The adapter configuration doc now lists `extraArgs` as an AGY execution field.

Implemented files:

- `server/src/adapters/agy-local.ts`
- `server/src/__tests__/agy-local-adapter.test.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/agy-local-adapter.test.ts` failed before implementation because `--add-dir` was missing from the AGY command args.
- `pnpm exec vitest run server/src/__tests__/agy-local-adapter.test.ts server/src/__tests__/adapter-registry.test.ts`
- `pnpm --filter @paperclipai/server typecheck`

## Wave 26: Stable Runner Heavy-Suite Follow-Up

Implementation status: completed locally.

Implemented behavior:

- Moved local CLI execution suites for `claude_local`, `codex_local`, and legacy `gemini_local` into the serialized server shard because they spawn child processes and can exceed Vitest's per-test timeout when run beside the full general server shard.
- Moved `onboarding-scan.test.ts` into the serialized server shard because the large-directory safety-limit test intentionally creates thousands of entries and is sensitive to full-shard filesystem contention.
- Tightened two heartbeat comment-wake batching tests so promoted gateway runs are held, given an agent-authored completion comment and terminal issue disposition, and waited through until the agent is idle before teardown. This removes the background successful-run-handoff race that previously left queued work running after the test started closing its database.

Implemented files:

- `scripts/run-vitest-stable.mjs`
- `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/claude-local-execute.test.ts server/src/__tests__/codex-local-execute.test.ts server/src/__tests__/gemini-local-execute.test.ts server/src/__tests__/onboarding-scan.test.ts`
- `pnpm exec vitest run server/src/__tests__/heartbeat-comment-wake-batching.test.ts --reporter verbose`
- `pnpm test:run`
- `pnpm --filter @paperclipai/server typecheck`

## Wave 27: Continuation Summary Create-Race Recovery

Implementation status: completed locally.

Implemented behavior:

- Added create-race recovery for the system `continuation-summary` issue document when two heartbeat paths both observe no existing summary and one insert wins first.
- Retries the losing first write by re-reading the current continuation summary and writing a new revision with the current `baseRevisionId`.
- Recognizes both normalized `409` document-key conflicts and wrapped Postgres `23505` violations for the `issue_documents_company_issue_key_uq` constraint while letting unrelated errors continue to fail normally.
- Replaced an exploratory embedded database timing probe with deterministic unit coverage for the race forms observed in the heartbeat suite.

Implemented files:

- `server/src/services/issue-continuation-summary.ts`
- `server/src/__tests__/issue-continuation-summary-retry.test.ts`
- `server/src/__tests__/issue-continuation-summary.test.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/issue-continuation-summary-retry.test.ts --reporter verbose` failed before implementation for the wrapped Postgres unique-violation path.
- `pnpm exec vitest run server/src/__tests__/issue-continuation-summary-retry.test.ts --reporter verbose`
- `pnpm exec vitest run server/src/__tests__/issue-continuation-summary.test.ts server/src/__tests__/issue-continuation-summary-retry.test.ts server/src/__tests__/heartbeat-comment-wake-batching.test.ts --reporter verbose`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm test:run`
- `pnpm -r typecheck`
- `pnpm build`

## Wave 28: Fresh-Runtime Onboarding Smoke Hardening

Implementation status: completed locally.

Verified behavior:

- Started Paperclip against a clean isolated `PAPERCLIP_HOME` at `/private/tmp/paperclip-mvp-smoke.MeCnvm` on port `3210`.
- Confirmed `/api/health` returned `status: ok`, `bootstrapStatus: ready`, and `authReady: true` with an empty company list before onboarding.
- Browser-smoked first-run onboarding against `/Users/giovannytorresadrovet/Documents/projects/CodexBar`.
- The large project scan completed as a brownfield scan with bounded counts (`1017` files, `456` directories, `10` ignored directories) and advanced to recommended review instead of blocking on the old safety-limit dead end.
- The review step exposed provider/model selectors for the xAgent squad, including locked `agy_local` / `gemini-3.5-flash`.
- Applying setup created `CodexBar Company`, project workspace `codexbar-core`, and starter issue `COD-1` with the local folder persisted as `~/Documents/projects/CodexBar`.
- The starter issue rendered persisted deferred setup guidance for local OAuth/session confirmation, optional secrets, and MCP/external tools.

Implemented hardening:

- First-run starter issues now start in `backlog` instead of `todo` so onboarding does not immediately dispatch a local agent before deferred OAuth/session setup is confirmed.
- The starter issue still keeps the recommended assignee so the operator can intentionally start the first audit after setup review.
- AI recommendation parsing now understands Codex `exec --json` JSONL output by extracting the final `agent_message` before parsing the strict recommendation JSON.
- The scan path and optional setup focus fields now have accessible labels, so browser tests and assistive technology can target them by label.
- E2E coverage now asserts the applied onboarding starter issue remains `backlog`.

Implemented files:

- `server/src/services/onboarding-apply.ts`
- `server/src/services/onboarding-recommend.ts`
- `server/src/__tests__/onboarding-apply.test.ts`
- `server/src/__tests__/onboarding-recommend.test.ts`
- `ui/src/components/OnboardingWizard.tsx`
- `tests/e2e/onboarding.spec.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/onboarding-recommend.test.ts server/src/__tests__/onboarding-apply.test.ts --reporter verbose`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm --filter @paperclipai/ui typecheck`
- `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/onboarding.spec.ts`
- `pnpm test:run`
- `pnpm -r typecheck`
- `pnpm build`

## Wave 29: Intentional Starter Audit Launch

Implementation status: completed locally.

Implemented behavior:

- Onboarding-created starter issues that are parked in `backlog` now show a dedicated "Start first audit" affordance on the persisted deferred setup panel.
- The launch affordance explains that the starter issue is intentionally parked until the operator starts it.
- If the local OAuth/session checklist item is not completed, the starter issue warns that the run may stop during adapter readiness.
- Clicking "Start first audit" uses the existing issue status mutation path to move the assigned starter issue to `todo`, preserving the route's normal wakeup behavior for assigned work.
- Browser coverage disables wake-on-demand for the generated assignee before clicking the launch action, so the e2e verifies the operator-controlled status transition without spawning a local agent process.

Implemented files:

- `ui/src/pages/IssueDetail.tsx`
- `ui/src/pages/IssueDetail.test.tsx`
- `tests/e2e/onboarding.spec.ts`

Verification:

- `pnpm exec vitest run ui/src/pages/IssueDetail.test.tsx --testNamePattern "requires an explicit start action"` failed before implementation because the onboarding launch affordance did not exist.
- `pnpm exec vitest run ui/src/pages/IssueDetail.test.tsx --testNamePattern "requires an explicit start action"`
- `pnpm exec vitest run ui/src/pages/IssueDetail.test.tsx --reporter verbose`
- `pnpm --filter @paperclipai/ui typecheck`
- `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/onboarding.spec.ts`
- `pnpm -r typecheck`
- `pnpm test:run` initially failed inside the sandbox with the known `tsx` IPC `EPERM`; rerunning outside the sandbox completed with exit `0`.
- `pnpm build`

## Wave 30: Assigned-Backlog Wake Contract Regression

Implementation status: completed locally.

Implemented behavior:

- Added route-level regression coverage proving the Wave 28/29 onboarding starter contract end to end at the issue update route.
- The onboarding starter issue is intentionally parked in `backlog` with its recommended assignee; the "Start first audit" affordance moves it `backlog -> todo` through the normal `PATCH /api/issues/:id` path.
- The new test pins that this transition queues a single assignment wake for the assignee with `source: "automation"`, `reason: "issue_status_changed"`, `payload.mutation: "update"`, and `contextSnapshot.source: "issue.status_change"`.
- A companion negative case proves a non-status edit (title change) while the starter issue stays in `backlog` does not wake the parked assignee.
- The test is isolated: `heartbeatService.wakeup` is fully mocked, so no real local Codex/Claude/Antigravity adapter process is spawned. The `-routes.test.ts` suffix routes it into the parallel route shard of `scripts/run-vitest-stable.mjs`, so no runner registration change is needed.

Implemented files:

- `server/src/__tests__/issue-onboarding-start-audit-wake-routes.test.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/issue-onboarding-start-audit-wake-routes.test.ts --reporter verbose`
- `pnpm --filter @paperclipai/server typecheck`

## Wave 31: Greenfield Workspace Git Readiness

Implementation status: completed locally.

Context: a manual end-to-end smoke test (real local server, isolated instance, throwaway repo) confirmed the full flow works — scan → recommend (AI path times out at 25s and falls back to deterministic as designed) → apply → "Start first audit" wakes the assignee and spawns the real `codex_local` adapter, which read the repo and posted an accurate diagnostics packet. The smoke test surfaced one gap: local CLI adapters (notably `codex_local`) refuse to start with `Not inside a trusted directory and --skip-git-repo-check was not specified` when the workspace is not a git work tree. Greenfield/empty-folder onboarding produces exactly such a directory, which blocks the very first starter audit from launching.

Implemented behavior:

- After the onboarding apply transaction commits, the primary project workspace path is made runnable by local adapters by ensuring it is a git work tree.
- Rather than bypass the adapter's trust check (`--skip-git-repo-check`), onboarding makes the chosen workspace a real git repository — which is what a Paperclip project workspace should be anyway, since agents commit work there.
- The step is best-effort and non-fatal by contract: it never throws, never fails the already-committed setup, only initializes a directory that exists and is **not** already inside a git work tree (so a subdirectory of an existing repo is left alone and never nested), and records an activity-log entry (`onboarding.workspace_git_initialized` or `onboarding.workspace_git_init_failed`) for operator observability.

Implemented files:

- `server/src/services/onboarding-workspace-git.ts` (new `ensureLocalWorkspaceGitRepo` helper)
- `server/src/services/onboarding-apply.ts` (post-commit wiring + activity logging)
- `server/src/__tests__/onboarding-workspace-git.test.ts` (new unit coverage)
- `server/src/__tests__/onboarding-apply.test.ts` (new integration case asserting a non-git workspace becomes a git work tree)

Verification:

- `pnpm exec vitest run server/src/__tests__/onboarding-workspace-git.test.ts server/src/__tests__/onboarding-apply.test.ts`
- `pnpm -r typecheck`

## Remaining Waves

Next wave:

- Consider broadening MCP evidence beyond plugin agent tools if the adapter manager gains a separate MCP server registry.
- For the next PR handoff, rerun the broader local verification set after any additional behavior changes: `pnpm test:run`, `pnpm -r typecheck`, and `pnpm build`.

## Boundaries

- The Stage 0 scanner must not run `agy`, `which agy`, or any other CLI probe. Adapter readiness remains responsible for runtime CLI checks.
- The scanner must not write database rows or filesystem files.
- The scanner must not send raw filesystem contents to any LLM.
- Repo paths belong on project workspaces during the apply wave, not on `companies`.
- `codex_local` recommendations must use Codex/OpenAI model defaults, never Gemini model IDs.
