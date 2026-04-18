# Code-Writer Incidental Bug Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-on instance setting that requires code-writing runs to publish an explicit incidental-bug triage declaration before their issue comment policy is considered satisfied.

**Architecture:** Extend the existing heartbeat run issue-comment policy instead of inventing a separate workflow. Store the policy toggle in instance general settings, centralize code-writing adapter detection and triage parsing in small helpers, inject a short runtime reminder into heartbeat prompt construction, and reuse the existing retry/recovery machinery when the declaration is missing.

**Tech Stack:** TypeScript, Express, Drizzle-backed instance settings JSON, React, Vitest

---

### Task 1: Lock the setting and triage contract in tests first

**Files:**
- Modify: `server/src/__tests__/instance-settings-routes.test.ts`
- Modify: `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
- Create: `server/src/services/incidental-bug-triage.test.ts`
- Modify: `packages/adapters/openclaw-gateway/src/server/execute.test.ts`

- [ ] **Step 1: Write the failing instance settings route assertions**
  Add coverage for:
  - `GET /instance/settings/general` returning `requireIncidentalBugTriageForCodeWriters`
  - `PATCH /instance/settings/general` accepting the new boolean field
  - activity logging still recording the changed key

- [ ] **Step 2: Write the failing triage parser unit tests**
  Add coverage for:
  - parsing `NONE SEEN`, `FIXED INLINE`, `DEFERRED`, and `ESCALATED`
  - requiring `Reason:` for `DEFERRED` and `ESCALATED`
  - ignoring markers inside fenced code blocks
  - ignoring markers inside quoted prior-comment / transcript blocks
  - returning `null` for malformed or missing declarations

- [ ] **Step 3: Write the failing heartbeat policy tests**
  Add coverage for:
  - code-writing run with comment but no triage marker becomes `retry_queued`
  - retry wake carries `retryReason: "missing_incidental_bug_triage"`
  - second failure becomes `retry_exhausted`
  - recovery notice text mentions missing incidental-bug triage, not missing comment
  - non-code-writing adapters still use the old comment-only rule

- [ ] **Step 4: Write the failing adapter reminder test for non-`promptTemplate` adapters**
  Add coverage proving `openclaw_gateway` receives the incidental-bug triage reminder in its wake/request text once enforcement is enabled.

- [ ] **Step 5: Run the focused tests to verify they fail**
  Run:
  - `pnpm vitest server/src/__tests__/instance-settings-routes.test.ts server/src/services/incidental-bug-triage.test.ts server/src/__tests__/heartbeat-comment-wake-batching.test.ts packages/adapters/openclaw-gateway/src/server/execute.test.ts`
  Expected: FAIL on the newly added setting and missing-triage assertions

### Task 2: Add the new instance general setting and operator toggle

**Files:**
- Modify: `packages/shared/src/validators/instance.ts`
- Modify: `packages/shared/src/types/instance.ts`
- Modify: `packages/shared/src/validators/index.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `server/src/services/instance-settings.ts`
- Modify: `ui/src/api/instanceSettings.ts`
- Modify: `ui/src/pages/InstanceGeneralSettings.tsx`

- [ ] **Step 1: Extend the shared settings contract**
  Add `requireIncidentalBugTriageForCodeWriters` to the general settings schema and type with default `true`.

- [ ] **Step 2: Normalize and persist the setting in the server service**
  Update `normalizeGeneralSettings()` and `updateGeneral()` so the new field is always returned and merged predictably.

- [ ] **Step 3: Add the General settings UI toggle**
  Add a new settings card in `InstanceGeneralSettings.tsx` with copy that explains:
  - it applies to code-writing runs
  - it requires declaring `none seen`, `fixed inline`, `deferred`, or `escalated`
  - it does not force every incidental bug to be fixed immediately

- [ ] **Step 4: Run the focused settings tests**
  Run:
  - `pnpm vitest server/src/__tests__/instance-settings-routes.test.ts`
  Expected: PASS

### Task 3: Centralize code-writing adapter detection and triage parsing

**Files:**
- Create: `server/src/services/incidental-bug-triage.ts`
- Create: `server/src/adapters/code-writing-adapter-types.ts`
- Modify: `server/src/services/heartbeat.ts`

- [ ] **Step 1: Add one central helper for code-writing adapters**
  Define the allowlist in one place. Include:
  - `claude_local`
  - `codex_local`
  - `cursor`
  - `gemini_local`
  - `hermes_local`
  - `openclaw_gateway`
  - `opencode_local`
  - `pi_local`

- [ ] **Step 2: Add a dedicated incidental-bug triage parser**
  Implement a helper that:
  - extracts the normalized outcome from markdown text
  - strips or ignores fenced code blocks before matching
  - strips or ignores quoted prior-comment / transcript blocks before matching
  - validates `Reason:` lines for `DEFERRED` and `ESCALATED`

- [ ] **Step 3: Add a helper to build the runtime reminder copy**
  Keep this text centralized so heartbeat can inject the same requirement consistently into code-writing prompts.

- [ ] **Step 4: Run the helper tests**
  Run:
  - `pnpm vitest server/src/services/incidental-bug-triage.test.ts`
  Expected: PASS

### Task 4: Enforce the triage declaration through the heartbeat comment policy

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/services/heartbeat-run-summary.ts`
- Modify: `server/src/routes/issues.ts`
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `ui/src/pages/IssueDetail.tsx`
- Modify: `packages/adapters/openclaw-gateway/src/server/execute.ts`
- Modify: `packages/adapters/openclaw-gateway/src/server/execute.test.ts`

- [ ] **Step 1: Replace the binary comment check with a policy evaluation**
  Refactor `finalizeIssueCommentPolicy()` so it distinguishes:
  - no linked issue
  - no run-linked issue comment
  - run-linked comment present and policy satisfied
  - run-linked comment present but missing required incidental-bug triage

- [ ] **Step 2: Reuse retry/recovery for missing triage**
  Generalize the current missing-comment retry helpers so they can queue a retry and recovery notice for `missing_incidental_bug_triage` as well as `missing_issue_comment`.

- [ ] **Step 3: Preserve the specific policy reason alongside coarse status**
  Update the issue-comment policy plumbing so operator/debug surfaces can distinguish `missing_issue_comment` from `missing_incidental_bug_triage` even when both collapse to `retry_queued` or `retry_exhausted`.

- [ ] **Step 4: Inject the runtime reminder before adapter execution**
  In the heartbeat execution config construction, prepend the short incidental-bug triage reminder to the effective `promptTemplate` for adapters that consume it when the setting is enabled. Do not rewrite managed instructions bundles on disk.

- [ ] **Step 5: Add adapter-specific reminder support where `promptTemplate` is ignored**
  Update `openclaw_gateway` wake/request text construction so the same reminder reaches the model before that adapter remains in the enforced allowlist.

- [ ] **Step 6: Keep synthesized run comments unchanged except for policy compatibility**
  `buildHeartbeatRunIssueComment()` should continue using model-authored summary/result text; do not auto-fake a triage declaration. Missing declarations must fail policy and trigger retry.

- [ ] **Step 7: Update false-complete scoring and recovery wording**
  Make stale-work heuristics and operator recovery comments explicitly reference missing incidental-bug triage when that is the failure mode.

- [ ] **Step 8: Run the focused heartbeat tests**
  Run:
  - `pnpm vitest server/src/services/incidental-bug-triage.test.ts server/src/__tests__/heartbeat-comment-wake-batching.test.ts server/src/services/heartbeat-comment-truth.test.ts packages/adapters/openclaw-gateway/src/server/execute.test.ts`
  Expected: PASS

### Task 5: Document the new contract

**Files:**
- Modify: `doc/SPEC-implementation.md`
- Modify: `server/src/onboarding-assets/default/AGENTS.md`
- Modify: `server/src/onboarding-assets/engineer/AGENTS.md`
- Modify: `server/src/onboarding-assets/qa/AGENTS.md`

- [ ] **Step 1: Update the implementation spec**
  Document:
  - the new instance general setting
  - default-on behavior
  - the four allowed incidental-bug triage outcomes
  - the fact that the gate requires declaration, not mandatory fix-all behavior

- [ ] **Step 2: Update baseline agent instructions**
  Add concise guidance telling code-writing agents that issue truth comments must include one incidental-bug triage marker when they touch code. Cover the shared default baseline plus role bundles that routinely participate in code-review / delivery flow.

### Task 6: Run repo verification before handoff

**Files:**
- Modify only if verification exposes legitimate fallout from the implementation tasks above

- [ ] **Step 1: Run targeted package tests**
  Run:
  - `pnpm vitest server/src/__tests__/instance-settings-routes.test.ts server/src/services/incidental-bug-triage.test.ts server/src/__tests__/heartbeat-comment-wake-batching.test.ts server/src/services/heartbeat-comment-truth.test.ts packages/adapters/openclaw-gateway/src/server/execute.test.ts`
  Expected: PASS

- [ ] **Step 2: Run the repo-required verification**
  Run:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`
  Expected: exit code 0 for all commands, or a precise report of any unrelated/pre-existing failure
