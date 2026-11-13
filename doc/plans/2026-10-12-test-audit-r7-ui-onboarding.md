# Test audit, Round 7 UI — Onboarding walkthroughs follow-up

This separate packet removes **5 registered executions, 5 rendered scenarios and 56 net test lines** from `ui/src/components/OnboardingWizard.test.tsx`. It adds no helper and changes no production lines. Audit base: `2e76f5157240ee8b2d42adbdcd4c345aea07c013`. All prior committed proof remains byte-identical. Registration/render savings are per complete-suite invocation; no measured runtime or CI-speed claim is made. A service-worker retirement counts only initializer setup, never a render.

## Exact retirement map

| Retired registration | Keeper | Exact observations migrated |
|---|---|---|
| `carries no token value in the hire payload` | `sends the fixed Claude binding and applyStoredClaudeLogin when a stored login exists` | const binding = hireBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY] as         \| { type: string }         \| undefined;; expect(binding?.type).toBe("user_secret_ref");; expect(JSON.stringify(hireBody)).not.toContain("secretId"); |
| `sends the fixed binding in the environment test request when the status route returns 200` | `sends the fixed Claude binding and applyStoredClaudeLogin when a stored login exists` | expect(mockAgentsApi.testEnvironment).toHaveBeenCalled();; const testArgs = mockAgentsApi.testEnvironment.mock.calls.at(-1) as unknown[];; const testBody = testArgs[2] as { adapterConfig: { env?: Record<string, unknown> } };; expect(testBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toEqual({         type: "user_secret_ref",         key: CLAUDE_OAUTH_TOKEN_ENV_KEY,         version: "latest",         required: true,       }); |
| `sends no binding in the environment test request when the status route returns 404` | `sends no binding and no flag when the Claude status route returns 404` | expect(mockAgentsApi.testEnvironment).toHaveBeenCalled();; const testArgs = mockAgentsApi.testEnvironment.mock.calls.at(-1) as unknown[];; const testBody = testArgs[2] as { adapterConfig: { env?: Record<string, unknown> } };; expect(testBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toBeUndefined(); |
| `creates the organization on Continue and lands on the agent step, no mission` | `shows no environment-check card on the model step, and no Mission row on review` | expect(mockCompaniesApi.create).toHaveBeenCalledWith({ name: "Initech" });; expect(document.body.textContent).not.toContain("Define your mission");; expect(document.body.textContent).not.toContain("Tell us about your team"); |
| `renders no 'Use saved login' control` | `starts the other source's login after backing out of the first` | expect(document.body.textContent).toContain("Sign in to Claude then come back and enter authorization code");; expect(document.body.textContent).not.toContain("Use saved login"); |

Five registrations consolidate within identical enclosing hooks and setup expressions. The stored-login 200 keeper receives the complete probe-called, captured probe payload and full fixed-binding equality before its original hire observations. The original hire-body binding is reused through the same captured mock-call expression; its broader type annotation and applyStoredClaudeLogin checks stay unchanged. The retired explicit reference-kind check and complete hire-payload secretId exclusion are retained before the original stronger binding equality. The 404 keeper separately receives its probe-called/captured-body/undefined-binding guards. The organization-create keeper carries exact requested name and both initial mission/team exclusions before advancing. The source-switch keeper carries the Claude instruction anchor and no-legacy-saved-login guard before Back. The real wizard creates companies, probes adapter environments and submits hires through distinct local call sites; its onboarding login UI uses AdapterLoginChrome. No status, provider, stored-login, cancellation or navigation paths are combined. An initial hire-kind mutation referenced an identifier not bound in the wizard and failed before the API payload assertion; it was rejected and restored, then rerun using the actual literal CLAUDE_CODE_OAUTH_TOKEN key. Every other case remains byte-identical.

The verifier requires matching setup statements, enclosing hooks and explicit teardown where present. It reconstructs candidate source solely from the declared registrations/assertion migrations and requires exact byte equality plus full-program AST equality outside those edits. Existing shared variable bindings, mock arguments and provider/component inputs remain the same. No other fixture, helper, action order, wait, assertion strength, timer or cleanup changes. Default CI includes the file in `@paperclipai/ui` under `general-workspaces-a`, once across its two file shards, with no workflow/config change.

## Complete owner-file results

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 93 | 93 | 0 | 0 |
| Candidate | 88 | 88 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/components/OnboardingWizard.test.tsx`.

All 11 separately selected positive controls passed. All 11 distinct production-owner regressions failed at intended retained/migrated assertions, not setup, timeout or another guard:

| Regression | Intended guard |
|---|---|
| probe-present-200 | `expect(mockAgentsApi.testEnvironment).toHaveBeenCalled()` |
| probe-binding-200 | `expect(testBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toEqual(` |
| hire-reference-kind | `expect(binding?.type).toBe("user_secret_ref")` |
| hire-private-id | `expect(JSON.stringify(hireBody)).not.toContain("secretId")` |
| probe-present-404 | `expect(mockAgentsApi.testEnvironment).toHaveBeenCalled()` |
| probe-binding-404 | `expect(testBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toBeUndefined()` |
| create-company-name | `expect(mockCompaniesApi.create).toHaveBeenCalledWith({ name: "Initech" })` |
| initial-mission | `expect(document.body.textContent).not.toContain("Define your mission")` |
| initial-team | `expect(document.body.textContent).not.toContain("Tell us about your team")` |
| auth-instruction | `expect(document.body.textContent).toContain("Sign in to Claude then come back and enter authorization code")` |
| saved-login | `expect(document.body.textContent).not.toContain("Use saved login")` |

Exactly one production owner changed per control, and every owner was restored byte for byte after each mutation and checked against pinned Git bytes. Literal keeper-name filters are escaped; unselected cases are not full-suite evidence. The initial first-install receipt verifier mistook emit( for it( and rejected its receipt despite the intended test failure. The declaration-boundary matcher was corrected and that control rerun; the rejected verifier attempt supplies no accepted evidence.

[Controls JSON](2026-10-12-test-audit-r7-ui-onboarding-controls.json) preserves source/owner hashes, exact before/after migrations, matched setup and variable-binding proof, complete-file run/log digests, intended assertion failures and restoration checks. Temporary raw scripts/logs are identified by digests rather than committed in full.

The earlier broad local `pnpm test:run` was intentionally stopped before completion and is not claimed as passed. These separate focused packets precede delivery-head replay and full CI. This packet includes no push, rebase, PR or merge.
