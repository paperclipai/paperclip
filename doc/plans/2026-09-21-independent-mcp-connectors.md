# Four independent MCP connectors

Branch: `codex/unified-mcp-connectors`
Worktree: dedicated checkout on `codex/unified-mcp-connectors`
Base: `b19307758`

Zapier, Arcade, Composio and Executor each have their own connection, credentials,
catalog, agent access, permissions, sessions and lifecycle. Their setup shares the
same structure: **Access → Connect**. Underlying apps remain managed
in the provider; Paperclip does not create child connections for every app.

## Delivery checkpoints

- [x] Create the fresh worktree.
- [x] Build controlled application views and four interactive Storybook groups.
- [x] Review the designs with the user and incorporate revisions.
- [x] Wire the reviewed views to production APIs and implement shared protocol support.
- [ ] Conduct real browser acceptance testing for all four providers, fix and retest.
- [x] Complete the user-authorized narrow checks: new isolated tests, direct UI/server typechecks, token gates, UI and Storybook builds. Full repository suites/builds were explicitly excluded.

Design review is complete and the user authorized production integration and live browser testing. The implementation is running in fresh local data. Three providers have real browser and agent proof; Zapier is waiting for a credential handoff. See [the current acceptance report](../connections/REMOTE-MCP-LIVE-ACCEPTANCE.md). Simulations are not live proof.

## Review links and operation

The review server uses the build from this worktree on port 6137:

| Provider | Complete journey |
| --- | --- |
| Zapier | `apps-connections-zapier--complete-setup-journey` |
| Arcade | `apps-connections-arcade--complete-setup-journey` |
| Composio | `apps-connections-composio--complete-setup-journey` |
| Executor | `apps-connections-executor--complete-setup-journey` |

Choose who can use the connection, continue, then use **Use example configuration**. The separate
**Storybook simulation** area supplies provider responses and browser sign-in or
completion events. After connection, Test opens the regular per-action dialog with
scoped mock API responses; approval requests stay pending in this preview. Provider links are intercepted by this simulator;
they do not open real authorization pages. Example catalogs and schemas are
representative, not production constants. Never enter real credentials here.

Each provider group exposes initial access, selected agents, URL and advanced
setup, connecting, invalid URL, rejected credentials, unreachable endpoint,
and post-setup permissions/management states. Successful authentication and catalog
discovery complete setup. There is no empty-catalog or Test setup step. Tool restrictions
and action tests use the regular Permissions screen after setup. All new tools are enabled automatically.

Browser sign-in pending/return/cancel stories apply only to Arcade, Composio and
Executor OAuth configurations. Zapier uses the pasted URL/token without an OAuth
handoff. Upstream app authorization and Executor resume now use the shared
post-setup Test dialog; bespoke setup test stories
have been removed. Narrow access, connection details
and tool management are directly accessible.

### Design feedback incorporated — 2026-09-21

- Reuse the actual Gmail `AccessStepContent` and `StepHeader`: human credential
  sharing and agent reach come before credentials, with compact top progress bars.
- Remove Connection name, the numbered sidebar and setup tool-permission controls.
- Finish setup as soon as authentication and tool discovery succeed, with all
  tools enabled. Remove the empty-catalog story and every setup Test step.
- Reuse the actual Permissions `ActionsSection` and `ActionTestDialog` after setup,
  including search, Read/Write filters, permission radios and per-action testing.
- Keep tool restrictions in management, separate from who can use the connection.
- Remove Zapier OAuth stories/options and unsupported provider resume examples.
- Update the canonical connector playbook and local `chat-connector-ux` skill with
  these conventions, including the explicit prohibition on setup connection names.

Drafts live only in React state in the previews and clear on reload. The production
controller must persist progress through refresh and OAuth redirects using the
existing server draft and vault mechanisms. Do not copy preview persistence into
production.

To rebuild and serve:

```sh
pnpm --filter @paperclipai/ui build-storybook
node scripts/serve-storybook-static.mjs --port 6137
```

## Provider setup contracts

| Provider | New setup | Permission boundary |
| --- | --- | --- |
| Zapier | Paste generated secret-bearing URL; alternatively endpoint plus bearer token. | Recommend Managed mode for individual action controls. Agentic mode exposes discovery/execution tools; permissions cover the whole exposed call. |
| Arcade | Paste gateway URL and sign in through the gateway’s configured User Source. Advanced: bearer API key plus `Arcade-User-ID`. | Actual exposed gateway tools. Individual apps can require further authorization. |
| Composio | Prefill `https://connect.composio.dev/mcp`, then authenticate. Advanced: externally configured session URL and headers. | Connect’s discovery, execution, connection-management and sandbox tools. Direct-tools sessions can expose individual actions. |
| Executor | Paste hosted workspace URL or reachable self-hosted HTTP endpoint and authenticate. Advanced user API key when supported. | Execution and helper tools; action policies remain in Executor. Preserve execution and MCP session identity for resume. |

The production catalog always comes from discovery, never the Storybook fixture.
Only expose a pending-state recovery action when the actual provider response and
protocol support it. Executor’s browser approval/resume is a specific supported
pattern; implement it in the shared post-setup Test dialog, not in onboarding.

Existing Composio project-API-key and child connections must remain supported.
New direct-MCP setup must not migrate their credentials or grants. Narrow legacy
broker checks by setup/transport instead of treating all Composio connections as
parent brokers. Vercel Connect remains a separate follow-up: its documented role
supplies credentials for an app’s MCP connection rather than this aggregator flow.

Research references (checked 2026-09-21):

- Zapier [setup](https://docs.zapier.com/mcp/get-started/connect/other) and [tool modes](https://docs.zapier.com/mcp/overview/how-tools-work).
- Arcade [MCP gateways](https://docs.arcade.dev/en/operate/governance/mcp-gateways).
- Composio [Connect](https://docs.composio.dev/docs/composio-connect) and [sessions](https://docs.composio.dev/docs/sessions-via-mcp).
- Executor [MCP proxy](https://executor.sh/docs/mcp-proxy) and [implementation](https://github.com/UsefulSoftwareCo/executor).
- Vercel [AI SDK and MCP integration](https://vercel.com/docs/connect/frameworks/ai-sdk-and-mcp).

## Production implementation scope

The views live in `ui/src/features/connections/remote-mcp/`; fixtures and the
simulator live under `ui/storybook/`. Reuse the views in the production controller
and keep the stories synchronized. The production controller is routed into Apps.

1. **Definitions and contracts:** give all four providers independent catalog
   definitions, setup/branding metadata and capabilities. Permit branded setup
   and configuration imports to use OAuth discovery, bearer tokens, custom
   headers and credential-bearing URLs. Extend existing connection/test types
   with provider presentation and upstream pending state. No new connection
   model or database tables are planned.
2. **MCP transport:** complete initialized Streamable HTTP operation, paginated
   `tools/list`, response matching by JSON-RPC ID, and session continuity across
   execution/resume. Existing `server/src/services/mcp-http.ts` and tool-access
   discovery need this work; a one-request proxy is insufficient.
3. **Gateway governance:** enforce company membership, agent grant and tool
   permission on both discovery and invocation, including resume. Allow new
   catalog entries under existing connection access; preserve explicit Off and
   Ask first, remove disappeared tools, and audit changes. Broad-tool permission
   covers the entire exposed call.
4. **Authentication and recovery:** keep credentials/catalogs/policies/sessions
   isolated by connection and effective identity. Use the vault, endpoint
   validation and secret redaction. Preserve execution IDs and handle provider
   authorization URLs and URL elicitation in both runtime and Test. Never
   automatically repeat a call when a write may already have happened. Disconnect
   must revoke access and invalidate sessions without affecting other connections.
5. **UI controller:** connect these controlled views to `ConnectionSetupFlow`,
   current permissions and Test interfaces, draft storage, OAuth and existing
   service APIs. Resolve provider pending actions using observed capabilities.
   Save errors remain visible and do not pretend to persist a draft. The test’s
   acting agent uses the same effective rules as a real agent gateway call.
6. **Verification:** protocol/governance fixtures, Storybook interaction and
   visual checks, token gates, Storybook build, then required repository typecheck,
   tests and build. Run the final checks on the integrated production change.

## Historical design milestone verification

Review environment: macOS, this worktree, static Storybook, example company,
agents and catalogs. Browser UI simulation and production acceptance are recorded
separately. Screenshots generated by the browser suite are local test evidence;
they are not Linux visual-regression baselines.

Commands:

```sh
pnpm --filter @paperclipai/ui typecheck
pnpm check:token-gates
pnpm exec vitest run ui/src/components/SetupWizard.test.tsx ui/src/components/JsonSchemaForm.test.tsx ui/src/features/connections/ConnectionSetupFlow.architecture.test.ts ui/src/pages/apps/app-detail/TestPanel.test.tsx
pnpm --filter @paperclipai/ui build-storybook
pnpm exec playwright test --config tests/storybook-visual/remote-mcp-connections.config.ts
```

Observed fixes during review: Save & exit now explicitly avoids submitting its
form; schema inputs expose accessible names; setup reuses the Gmail access choices and compact top progress header; newly discovered fixture tools default to Allowed without resetting saved
restrictions. The shared components retain their existing behavior otherwise.

### Design revision verification (before production integration)

- UI typecheck, token gates, 34 focused tests and Storybook build passed.
- All 15 browser checks passed, including four complete Access → Connect journeys
  that finish with zero action calls and every discovered action Allowed.
- The canonical Permissions action list and Test dialog cover effective agent
  access, denied agents, disabled tools, success, errors and pending approval.
  Permission changes survive catalog refresh and reconnect; disconnect blocks use.
- All 82 stories render at 1280px/dark and 390px/light without page errors or
  horizontal overflow: Zapier 18, Arcade 21, Composio 22, Executor 21.
- Browser inspection confirmed Zapier goes straight from Connect to saved
  permissions, then opens the shared Test dialog. Narrow Permissions screenshots
  for Zapier/Composio and the shared Test dialog were visually reviewed.
- Fake credentials stay out of browser storage, and scoped test requests never
  leave the Storybook mock. No real provider action ran.

Screenshots are local test evidence in
`tests/storybook-visual/test-results/remote-mcp/`. Earlier 117/122-story results
included the removed setup Test flow and are superseded by this revision.

The removed simulations were never live provider proof. Production results and the final narrow check commands are recorded in the acceptance report. The user subsequently prohibited running the full suite locally; that later constraint supersedes the earlier repository-wide verification plan.

Dependency installation previously used the pinned pnpm after a base-branch
patch/lockfile mismatch (`postgres@3.4.9`); the tracked lockfile was restored.
No dependency or lockfile changes are included.

## Current live acceptance

See [REMOTE-MCP-LIVE-ACCEPTANCE.md](../connections/REMOTE-MCP-LIVE-ACCEPTANCE.md) for provider-specific results, actual agent task links, fixes, retests, and remaining gaps.

- Arcade, Composio, and Executor: real OAuth, catalog, Test and agent calls observed; governance and lifecycle exercised.
- Zapier: dedicated provider server configured, but its generated secret URL still needs to be pasted into the local setup form. No live execution proof is claimed.
- Supporting checks: 27 newly added isolated Vitest checks, 18 connector-only Storybook checks, 85 stories at desktop/narrow widths, direct UI/server typechecks, token gates, UI build, and Storybook build passed. One test worker; no full repository suite or recursive build/typecheck.

The isolated test instance has a fresh database and a browser-reachable OAuth callback. All three tested connections were restored after revocation checks and are available for review.

For **each** provider, record environment, account identity, observed catalog,
journeys, actual results, useful screenshots, defects/fixes/retests and gaps:

1. Discover it from Apps, connect it, and verify account and catalog.
2. Assign agent access and exercise Allowed, Ask first and Off.
3. Run a useful action in Test and verify its external result; use disposable
   data for writes.
4. Have a real Paperclip agent call through the Paperclip gateway. Verify an
   ungranted agent and disabled tool are denied.
5. Exercise applicable provider authorization/approval, including Executor resume
   without starting a second execution.
6. Add/remove tools upstream and refresh. New tools become Allowed; prior Off and
   Ask first remain. Confirm reload, draft return, reconnect and disconnect.
7. Change this connection and prove the other connections remain unaffected.
8. Assess redirects, transient errors, duplicate writes, copy, keyboard access,
   desktop and narrow layouts. Fix defects and repeat affected journeys.

Completion requires observed live results for **all four**, with functional
correctness and UX readiness assessed separately. Storybook successes do not
check any live acceptance box.
