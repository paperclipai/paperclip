# Test audit, Round 7 UI — Agent configuration follow-up

This separate packet removes **4 registered executions, 4 root renders and 44 net test lines** from `ui/src/components/AgentConfigForm.render.test.tsx`. It adds no helper and changes no production lines. Audit base: `e3effbb9e5c66b838f67fd487987c8bf1007e413`. Prior committed evidence remains byte-identical. Render/execution savings are per complete-suite invocation; no measured runtime or CI-speed claim is made.

## Exact retirement map

| Retired registration | Keeper | Observations retained |
|---|---|---|
| `keeps secret access out of the main Configuration content` | `hides the environment override when Local is the only configured environment` | expect(result.container.textContent).not.toContain("Secret access"); |
| `starts a login session for the effective sandbox and shows the code and the authentication URL` | `shows a Cancel affordance while a login is active and cancels the session` | expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledWith("company-1", "codex_local", {       environmentId: "sandbox-1",     });; expect(result.container.textContent).toContain("WXYZ-1234");; expect(result.container.textContent).toContain("https://auth.example.test/device"); |
| `shows the authorization URL and a browser-code input for a Claude sandbox` | `cancels an active Claude login and returns to its start state` | expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledWith("company-1", {       environmentId: "sandbox-1",     });; expect(result.container.textContent).toContain("https://claude.example.test/authorize");; expect(       result.container.querySelector('input[aria-label="Browser code"]'),     ).toBeTruthy();; expect(result.container.textContent).not.toContain("not encrypted"); |
| `keeps the non-path ACP controls visible when the policy hides the engine choice` | `hides the host path and execution-engine fields for claude_local when the policy is on` | expect(labels).toContain("ACP session mode");; expect(labels).toContain("ACP non-interactive permissions"); |

Each of four pairs uses identical beforeEach/afterEach hooks and render/helper input expressions. The Local-only configuration keeper absorbs the Secret access exclusion. The Codex and Claude cancellation keepers retain their respective original provider-specific start API and displayed-code/submitted-browser-code observations before any Cancel click; their providers and lifecycle remain separate. Real runTest/startLogin helpers click Test/Sign in under the original QueryClient/Toast/Tooltip tree with fresh clients and roots. The managed-sandbox-only keeper absorbs both visible non-path ACP labels after the same Advanced/Advanced Run Policy toggles. AgentConfigForm.tsx passes the policy into real ClaudeLocalAdvancedFields from adapters/claude-local/config-fields.tsx, which retains non-path mode/permission fields while host paths are hidden. Existing enabled/disabled/loading, stored-token, terminal-state, submit, cancel-error and timeout cases remain unchanged. Two retired login cases avoid repeated environment-test/start-login API paths; polling request counts and time savings are not claimed.

The AST verifier checks exact setup, shared enclosing hooks and matched cleanup where present, reconstructs candidate text solely from the declared registrations/assertion migrations, and requires exact byte equality plus full-program AST equality outside those edits. No fixture, helper, provider, action order, wait, assertion strength, timer or teardown changes. The IssueChatThread keeper is an existing complete subset proof; InlineEditor’s identical not-null guard is retained once. Every other case stays byte-identical. Default CI includes this file in `@paperclipai/ui` under `general-workspaces-a`, once across the two file shards; workflow/config unchanged.

## Complete owner-file results

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 99 | 99 | 0 | 0 |
| Candidate | 95 | 95 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/components/AgentConfigForm.render.test.tsx`.

All 13 isolated positive controls passed. All 13 deliberate behavior regressions failed at their intended retained/migrated assertion, rather than setup, timeout or a different guard:

| Regression | Intended guard |
|---|---|
| secrets | `expect(result.container.textContent).not.toContain("Secret access")` |
| codex-company | `expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledWith(` |
| codex-adapter | `expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledWith(` |
| codex-environment | `expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledWith(` |
| codex-code | `expect(result.container.textContent).toContain("WXYZ-1234")` |
| codex-url | `expect(result.container.textContent).toContain("https://auth.example.test/device")` |
| claude-company | `expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledWith(` |
| claude-environment | `expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledWith(` |
| claude-url | `expect(result.container.textContent).toContain("https://claude.example.test/authorize")` |
| claude-input | `result.container.querySelector('input[aria-label="Browser code"]')` |
| claude-advisory | `expect(result.container.textContent).not.toContain("not encrypted")` |
| acp-mode | `expect(labels).toContain("ACP session mode")` |
| acp-permissions | `expect(labels).toContain("ACP non-interactive permissions")` |

Exactly one production owner was temporarily changed per control. Every owner was restored byte for byte after each mutation and matched pinned Git bytes. Filtered controls select one keeper; unselected tests do not count as full-suite evidence. [Controls JSON](2026-10-12-test-audit-r7-ui-agentconfig-controls.json) records exact owner/source hashes, migration/input proof, complete-file run/log digests, mutation bodies, intended assertion failures and restoration receipts. Temporary raw verifiers and logs are identified by digests rather than committed in full.

The earlier broad `pnpm test:run` was intentionally stopped without completion and is not claimed as passed. Separate packet results are focused proof, not a completed combined delivery-head replay or pending full CI. No push, rebase, PR or merge is included here.
