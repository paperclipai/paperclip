# Live provider connection qualification

Date: 2026-10-03
Status: Runnable implementation delivered; operating contract and initial verification are in [PROVIDER-CONNECTIONS.md](../../tests/runner-e2e/PROVIDER-CONNECTIONS.md). Live qualification is reported per campaign, not implied by this plan.
Code inspected: `527e3bad2` (`codex/provider-routing-connections`).

## Decision

Extend the existing Playwright Product E2E harness with real connection-creation journeys, an explicit authentication handoff, and support for an existing deployment as the target. Run the subscription journeys in a visible browser on a developer's machine first. The same tests should target local Paperclip and staging.

Playwright owns navigation, assertions, evidence, and the verdict. A person completes login challenges when necessary. A computer-use agent can assist with diagnosis and provider UI changes, but it must not silently change the steps or decide whether the test passed. An assisted success is useful evidence and must be labeled as assisted.

The deliverable is a matrix answering **which configuration worked, against which deployment, with what proof**. A successful login, a saved connection, and a successful agent run are separate checkpoints.

## Existing foundation and gaps

- [`tests/runner-e2e`](../../tests/runner-e2e/README.md) already supplies real browser/server/runner/provider tests, catalog selection, isolated fixtures, independent grading, reports, cost accounting, and provenance. This is the appropriate family, as defined in [`doc/evals.md`](../evals.md).
- Its [Playwright configuration](../../tests/runner-e2e/playwright.config.ts) currently owns a fresh loopback server and database. Supporting staging requires a target lifecycle abstraction, not just substituting a URL.
- [`tests/ai-connections-app/app.spec.ts`](../../tests/ai-connections-app/app.spec.ts) includes simulated login sessions and popup destinations. It also retains local terminal-login assertions that predate this branch's browser-login changes. Keep fast simulated tests, update those stale expectations, and label their limited proof clearly.
- [`tests/hiring-ai-connections/hiring.live.spec.ts`](../../tests/hiring-ai-connections/hiring.live.spec.ts) already checks real runs, connection attribution, and legacy/native execution. It creates initial API-key connections through the API and requires a loopback `local_trusted` instance. Reuse the assertion patterns; it is not a complete connection-onboarding test or a staging harness.
- The existing Grok subscription qualification stages supplied `GROK_AUTH_JSON`. Its documentation correctly says this does not test interactive browser login.

## Coverage contract

Inventory harnesses separately from providers. Claude is a harness; Bedrock and OpenRouter are connection routes. A Paperclip deployment URL, an authentication host, and an agent execution environment are also separate dimensions.

The initial inventory below comes from [managed connection capabilities](../../packages/shared/src/ai-connections.ts), [routing compatibility](../../packages/shared/src/ai-provider-routing.ts), and the [UI adapter registry](../../ui/src/adapters/registry.ts). It describes implementation eligibility, not proven live coverage.

| Harness | Managed subscription | Direct API key | Advanced routes currently admitted |
| --- | --- | --- | --- |
| Claude Code | Yes | Anthropic | OpenRouter, Bedrock, Messages-compatible gateway |
| Codex | Yes | OpenAI | OpenRouter, Responses-compatible gateway |
| Grok | Yes; qualify its actual login UX separately | xAI | Not supported by the current routing compatibility table |
| Gemini | Not in the managed connection capability table | Google | Not in the current routing compatibility table |
| OpenCode | No managed subscription entry | OpenRouter | OpenRouter, Chat Completions-compatible gateway |
| Hermes local | No managed subscription entry | Inventory harness-specific behavior | OpenRouter, Chat Completions-compatible gateway |
| Cursor local, Kimi, Pi | Inventory required | Inventory required | Inventory required |

“Not in the table” is a Paperclip managed-connection limitation, not a claim about everything the upstream CLI can do. Inventory native runner providers and installed first-party adapters as well as legacy UI adapters; any additional local provider must receive a manifest entry before the full campaign can qualify.

Exclude remote OpenClaw and Hermes gateways, Cursor Cloud, managed Claude/AWS AgentCore, process/HTTP adapters, and the generic legacy ACPX integration from this campaign. Their remote systems own provider configuration. **Hermes local remains in scope.** Supported native Claude/Grok runner profiles that internally use ACPX remain in scope; that transport is distinct from the excluded generic legacy integration.

For every supported harness/auth/route combination, enumerate the supported legacy/native runner profiles and target environments. Do not infer that an API-key pass covers subscription, that legacy covers native, or that local covers staging. Protocol routes need a real configured endpoint and credential; a mock gateway is useful for regression tests but does not supply live qualification.

Keep three independent manifest fields:

- Eligibility: supported, unsupported/product gap, needs inventory, or deliberately excluded with a reason.
- Execution: not run, awaiting user, missing credential, blocked target, running, complete.
- Qualification: passed or failed, with individual checkpoint results and assistance recorded.

A credential-free catalog check must flag newly added local harnesses or changed capabilities without a reviewed coverage entry. Report required, selected, attempted, and passed counts separately. Unsupported configurations are visible product gaps, never green tests.

## Authentication strategy

Use three lanes, with separate results:

| Lane | Starting state | What it proves |
| --- | --- | --- |
| Fresh connection, existing browser sign-in | Saved provider website/Google browser session; no Paperclip connection or runtime credential for this cell | The current Paperclip subscription flow obtains and saves a fresh usable credential |
| Fresh connection, signed-out browser | Empty provider browser state; no Paperclip connection or runtime credential | The complete first-time experience, including account selection and login |
| Existing connection | A connection previously created by the live UI journey | Selection, reuse, continuation, and reconnect behavior |

Most developer campaigns use the first lane. The signed-out lane runs explicitly before releases or login changes. The existing-connection lane cannot substitute for either creation lane.

There are three distinct identities/stores: Paperclip board authentication for the selected target, provider website authentication in the browser, and the resulting managed connection credential. Reusing provider website sign-in reduces friction while still exercising a fresh OAuth/device authorization and production credential persistence. Do not import `~/.codex`, `~/.claude`, or an existing token into a fresh-connection test.

Initially, use the developer's existing subscription accounts through a dedicated QA browser profile, separate from their everyday Chrome profile. Keep account aliases and expected identities in private local configuration; do not put personal email addresses into the public catalog. Serialize tests sharing an account or refresh-token chain. Never copy the profile between CI workers.

### Login checkpoint

The flow starts the real production login session, arms popup/new-tab observation before clicking, and tracks the expected provider origin and Paperclip session. It handles ordinary redirects and device-code/code-entry steps using the actual UI. Provider and Google pages can require a person for account choice, passwords, passkeys, MFA, CAPTCHA, or consent.

At such a boundary:

1. Show the relevant window and mark the cell `awaiting_user`, with the provider, target, and expected account alias.
2. Pause only the affected account's queue. Keep a bounded deadline tied to the real login session's expiry.
3. Let the person complete the production browser flow. If the provider rejects the automated browser, support handoff to a normal browser using the product's existing device URL or code-return flow. Do not add authentication bypasses.
4. Resume from observed Paperclip login status and saved-connection state. Clicking “continue” is never sufficient proof of successful authorization.
5. If the session expires, retain that attempt and use the product's retry action to start a new session. Never replay an old callback code.

Record which step needed assistance and its duration, without recording passwords, codes, callback query strings, or provider session IDs. Check the expected account using available provider/account metadata; where this cannot be machine-verified, explicitly record human identity confirmation rather than claiming an automated identity check.

There is no promise that Google or provider sign-in will remain unattended indefinitely. Expired browser state is an operational login requirement, not a passing test. A bug that loses a completed callback is a product failure, not automatically “needs login.”

## Local and staging target adapters

Introduce two lifecycle modes while sharing the same journey:

- **Managed local:** create and own an isolated Paperclip home, database, server, company, and runtime. Teardown may stop/delete only these owned resources.
- **Attach existing:** authenticate to a configured local/staging URL and create a dedicated QA company or use an explicitly designated test company. Never reset the deployment, change instance-wide feature settings, install plugins, or stop its server as fixture setup.

The current local `3109` application can be an attach-existing target. Preserve its BOB company and user data. Full first-company onboarding belongs on a fresh managed target or a dedicated disposable staging tenant/instance; a shared staging deployment cannot prove that path merely by creating another agent.

Each private target configuration supplies an exact origin, target mode, expected deployment identity/revision, board-auth account reference, QA company policy, and available execution environment. The staging URL is still to be supplied. Target validation precedes credential resolution. Verify redirects, health, authorization, installed harness versions, required capabilities, and environment availability; do not send credentials to a host introduced by a redirect or unreviewed target configuration.

Record the tested server revision separately from the harness revision, plus runner/CLI version, immutable sandbox image when applicable, model ID, protocol, authentication host, and execution environment. Staging with a missing capability is blocked, not silently tested through a different route. Unknown build provenance prevents a release qualification claim.

## Required browser journey and independent proof

For each admitted cell:

1. Create/select the isolated fixture company and a synthetic workspace through existing public surfaces. Ordinary bootstrap APIs may prepare the fixture; they must not create the connection or agent that the browser journey is supposed to test.
2. Enter the production new-agent flow, select the harness and Subscription/API Key/Advanced mode, and create the connection through the UI. Advanced cases supply the configured provider/protocol, endpoint or region, and selected credential reference. Verify that permissions default to everyone/all agents within the isolated test company and that advanced controls retain their values.
3. Verify the saved connection and compatible connection selector after reload. For a fresh-login cell, confirm that a new connection was actually created and that the selected connection is the one bound to the agent.
4. Choose the model and environment in Configure, run the product's test action, and finish setup. Verify the model list/custom model path and selected values survive reload.
5. Create a real task through the browser. Ask the agent to read a small synthetic input file, compute a deterministic result, and save a result artifact. Generate the input independently and keep the expected result out of the prompt. Seed the workspace using existing environment fixture facilities, not a private server hook.
6. Require the real tool receipt, persisted successful run, task completion, correct artifact bytes/hash, and a user-visible result link that opens after reload. “Provider routing works” or any other model-authored success sentence alone cannot pass.
7. Correlate the run with the selected connection, auth method, harness/runner, route, model, and execution environment using durable production evidence. Reuse the existing run-context assertions where available. Any missing attribution is an evidence gap to implement explicitly, not something to infer from the model's response.
8. Send one bounded follow-up that uses the saved result and produces a second independently checked output. This proves the saved credential remains usable beyond the setup probe.
9. Clean up only campaign-owned resources, retain sanitized results, and report cleanup failures separately. Failed cleanup prevents an entirely clean campaign result but does not erase successful functional evidence.

Use a controlled runtime without ambient provider keys or personal CLI homes so a broken selected credential cannot fall back to another account. On staging, explicitly qualify the runtime's credential isolation. Add a negative case with a deliberately invalid selected credential and require an actionable failure with no successful fallback. For a controlled gateway, correlate sanitized request metadata when available; never retain authorization headers.

Also cover the other product entry points: Apps connector row → Connect → connection list → agent selection; existing agent → switch compatible connection; and reconnect after an expired/invalid connection. Apply every supported auth method to both Apps and agent-creation entry points. Fresh company onboarding and destructive recovery cases are separately enumerated; their target requirements must be visible. A representative smoke selection is useful, but is not the full matrix.

## Trustworthy results and safe evidence

Extend the existing Product E2E result/report pipeline with authentication checkpoints, assistance, target identity, and coverage denominator. Preserve the existing failure classification: product, model/provider behavior, grading/evidence, or infrastructure. Operational blocks are separate from these failure causes.

Keep first failures and all attempts. Permit only declared bounded infrastructure retries; do not let an agent change selectors or retry a failed product flow until the campaign looks green. A repaired test starts a new definition/revision measurement.

Example report shape (illustrative, not results):

| Cell | Target | Login | Saved | Tool/artifact | Follow-up | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Claude subscription/native | Local | Assisted | Pass | Pass | Pass | Pass, assisted |
| Codex subscription/native | Staging | Needs reauthentication | — | — | — | Awaiting user |
| Grok custom gateway | Local | — | — | — | — | Unsupported/product gap |

Disable automatic Playwright traces, HARs, screenshots, videos, request-body logging, and DOM dumps for the live authentication flow, including failure handlers. Masked password fields do not protect network traces, tokens, or callback URLs. Exception messages and reporters also need sanitized wrappers; do not serialize raw Playwright call logs containing filled values or navigated URLs. Calibrate redaction with synthetic sentinel credentials before using real accounts.

Keep browser profiles and auth state outside the repository and artifact directories, using OS-protected storage or restrictive local permissions. Persist only selected provider state; never include it in reports, caches, or CI uploads. Resolve one cell's required credentials at a time from a private secret store; API-key fixtures may reference existing local secrets without sourcing the entire secrets file into the server environment.

After authentication, allow only the existing synthetic-task screenshots and structured allowlisted evidence. The [current public evidence policy](../../tests/runner-e2e/SECURITY.md#public-evidence-boundary) explicitly excludes credential and setup pages; this feature must not widen that boundary. Auth diagnosis uses sanitized phase/status metadata, not screenshots of personal accounts. Read-only report regeneration must make no additional provider calls.

## Implementation slices

1. **Manifest and target support.** Add an explicit-only `provider-connections` Product E2E suite; register coverage and profiles in the existing catalog/fixture registry. Add owned-local/attach-existing target lifecycles without changing existing suites' defaults. Include credential-free tests for origin validation, coverage drift, selection, cleanup ownership, and blocked results.
2. **One complete subscription path.** Implement the authentication checkpoint and Claude subscription journey locally, then Codex. Prove each with a fresh UI-created connection, independent task artifact, reload, and follow-up. Prove both saved-browser-sign-in and signed-out lanes. Fix stale local-login browser assertions alongside this work.
3. **Same journey on staging.** Supply the staging target and board account; replay the Claude/Codex journeys against its actual login host and runner environment. Record deployment differences rather than building a separate staging script.
4. **API keys and advanced routes.** Add direct keys, OpenRouter, Bedrock, and each supported protocol gateway. Include wrong-key/no-fallback, mismatched protocol, model discovery, and custom alias cases. Bedrock has a selected region/model and an expiring credential; an expired credential is renewed before the case and never counted as a product pass.
5. **Complete the inventory.** Add Grok's actual subscription and key paths, Gemini, OpenCode, Hermes local, and supported Cursor/Kimi/Pi/native-provider cases. Resolve unsupported auth paths as explicit product decisions; do not invent a third mode for every harness. Expand entry points and runner/environment variants until every required manifest cell has evidence.
6. **Operationalize.** Start with a manually launched visible-browser campaign on the developer's machine. Later use dedicated subscription accounts on a trusted QA machine, plus unattended API-key/gateway jobs in the existing protected paid CI workflow. Keep subscription reauthentication an explicit attended operation whenever the provider requires it.

The suite, target configuration, and authentication selectors are now implemented; use the commands in [PROVIDER-CONNECTIONS.md](../../tests/runner-e2e/PROVIDER-CONNECTIONS.md). Discovery, verification, and reports reuse `test:e2e:runner`. The authoritative README/FIXTURES/SECURITY docs and `doc/evals.md` link the operating contract.

Each case declares a turn limit covering the setup probe and follow-up, a provider-run timeout, a separate login deadline, company/agent budget limits, and cleanup policy. Run one subscription case per account at a time. Present selected cells and estimated spend before paid execution; record actual usage and unknown cost separately. Do not call subscription usage “free,” and do not run the full matrix as a side effect of normal unit tests or `--all`.

## Acceptance criteria

- One catalog and journey implementation selects local or staging through configuration.
- At least one real fresh Claude and Codex subscription connection passes through each target before claiming the initial slice complete; no mocked popup/session or preinstalled credential substitutes for this proof.
- Human handoff, timeout, expired login, and account mismatch produce distinct, resumable outcomes without false passes.
- Passing requires the selected connection's persisted binding, real successful run, independently validated tool result/artifact, and a successful subsequent use.
- Credential-free grader tests reject a plausible success message without a tool result, a wrong artifact, wrong connection attribution, and absent evidence.
- Missing credentials, unsupported combinations, and unrun cells remain visible in the coverage denominator. Assisted and unattended results remain distinguishable.
- Existing local/staging user data survives; teardown owns only test resources.
- Secret sentinel tests prove that failure artifacts and report projections do not disclose login state or credentials.
- The full inventory is qualified only after all required supported cells have current evidence. Earlier slices are explicitly partial.

## External references

- [Playwright pages and popups](https://playwright.dev/docs/pages): popup/new-page events provide deterministic browser coordination.
- [Playwright authentication](https://playwright.dev/docs/auth): authenticated browser state can be reused, is sensitive, and expires. Reusing website state does not require bypassing Paperclip's connection flow.
- [Google OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies): account authorization must use an appropriate browser flow. Google login restrictions and challenges are not something this harness should attempt to bypass.


## Verification update · 2026-10-05

Six previously failing local key/gateway journeys now pass: legacy Grok from
both entry points, legacy Codex/new-agent OpenRouter, legacy OpenCode/Apps
OpenRouter, and native OpenCode/OpenRouter from both entry points. Gemini
selected-model startup, current local skill-root guidance, and repair-run
artifact attribution have been corrected. Its final two browser retests still
failed the 300-second first-task deadline, so Gemini remains unqualified.
The affected ACP regression group passes 221 tests and Grok's two affected files
pass 54 tests. The ACP checks include a real missing-file protocol reproduction,
canonical local Gemini workspaces, preserved remote paths, and permission-denial
guards. The existing ACPX patch now returns resource-not-found for genuine
missing files; it keeps other errors and permissions intact. Workspace
typecheck/build and token gates pass; the full
Vitest suite has not produced a passing result after broad timeout failures.

The pinned native Grok installation still requires administrator access.
Attended subscription completion, staging/Daytona, and qualification against a
single reviewed committed build remain outstanding. See
[the qualification runbook](../../tests/runner-e2e/PROVIDER-CONNECTIONS.md) for
retained attempts, exact evidence boundaries, and replay instructions. This
update does not mark the overall acceptance criteria complete.

## Gemini investigation update · 2026-10-06

The new-agent/API-key workflow passes with `gemini-3.5-flash-lite`, including the
independent first artifact and follow-up checks. The Apps diagnostic retest
delivered its first artifact, then timed out on follow-up with no recognized
error signal; that cause remains unknown. Earlier deadline failures include provider HTTP 503 overload
retries; increasing the deadline would not resolve the underlying uncertainty.

A new credential-free installed-CLI smoke distinguishes correct ACP missing-file
semantics from Gemini CLI 0.58.0's plain-error-object conversion bug. A temporary
CLI copy with that narrow conversion fixed passes creation, existing-file reads,
and external-path denial; the user's installed CLI remains unchanged. Explicit
thinking-effort configuration also needs a supported startup-settings path;
short comparisons do not show that default `HIGH` thinking caused the deadlines.

The harness now projects terminal errors into closed diagnostic codes before
managed-instance teardown, retaining no error text or hidden reasoning. Fresh
managed targets preserve the original stopped onboarding database. Results,
cleanup, model/source provenance, and remaining qualification boundaries are
recorded in the private report and the runbook. The full acceptance criteria
remain open.
