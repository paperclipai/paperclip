# Managed aggregator accounts — acceptance stories

Date: 2026-10-05

## Expected behavior

1. **Discover existing accounts.** After saving an Arcade or Executor gateway, opening Apps discovers the accounts visible through that gateway. No individual app reconnection, task, extra executable connection, or access grant is required.
2. **Group accounts.** Notion appears once with its native account, a Composio account, two Arcade accounts, and an Executor account. Identical labels remain distinct by provider, gateway, and upstream account identity. Native Connect/Add account remains the onboarding action.
3. **Reconcile upstream changes.** Add or disconnect an upstream account, then use Refresh in only that gateway’s menu. A successful scan updates its accounts; other gateways’ observations remain intact.
4. **Manage upstream.** Imported account menus contain only Open in the provider. Links are HTTPS and contain no credentials. Executor workspace/self-hosted paths remain intact. Upstream deletion and per-app authorization stay upstream; Paperclip policies apply to the executable parent gateway.
5. **Optional Arcade sync.** A gateway using a project key and Arcade user ID reuses those credentials. Otherwise Set up account sync asks for an optional project key and user ID. Its vault credential is used for discovery only; gateway tool invocation still uses its existing credentials.
6. **Honest discovery states.** Unsupported inventory, expired sign-in, partial pages, and stale observations never become successful empty inventories or green checks. Failed scans retain previous accounts and invite refresh/setup.
7. **Isolation and rotation.** Account observations are scoped to company, saved gateway, viewing human, and credential version. Rotating a credential or changing the session endpoint hides prior observations until a successful scan. Account discovery cannot grant access.
8. **Navigate five chips.** Paperclip defaults to native discovery with all installed apps above it. Composio/Arcade scope discovery while retaining all connected account lines on grouped cards. Native cards appear under a provider only if that provider has observed accounts for the app, not merely because its catalog supports the app. Installed shows only installed apps; All includes every source. Executor's chip is temporarily hidden; its gateway and observed accounts remain available. A Paperclip search expands to All and clearing returns to Paperclip; explicit filters stay scoped. Pagination affects discovery only.
9. **Unknown integrations and small screens.** Unknown Executor integrations receive a separate card without guessed branding. Empty results remain actionable. Chips wrap and account rows remain readable at mobile widths.
10. **Inspect a saved gateway.** Composio setup opens its Permissions page. Opening that page starts one refresh, displays progress, and shows detected apps with their logos in a bounded, keyboard-scrollable list. Refresh Composio checks only this saved gateway. Partial failures retain observations as unverified. Account discovery does not change human/agent permissions. The redundant OAuth scope guidance and “Reconnect to update permissions” button are removed; actual authorization-repair controls remain available.

## Reproduction

Run this checkout’s Storybook on port 6200 and the disposable acceptance server:

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/aggregator-accounts/test-drive.ts
```

Open `http://localhost:6200/iframe.html?id=apps-managed-accounts--full-stack-test-drive&viewMode=story`.

This mounts the production Apps page against production tool-access routes and a disposable PostgreSQL database. Only external provider responses are simulated. The upstream controls change fixture inventory; use the gateway menu to refresh and observe the result. Existing app data and other local services are untouched.

The catalog-only stories remain at `Apps/Catalog source selection` and demonstrate the five current chips, pagination, native onboarding precedence, and grouped accounts.

## Evidence and limitations

Verified in the embedded browser on 2026-10-05 against the production Apps component, production routes, and disposable PostgreSQL. External Composio, Arcade, and Executor responses were simulated.

| Story | Result and evidence |
| --- | --- |
| Existing accounts | Passed: saved gateways imported existing accounts without app reconnection. Gateway onboarding tests confirm Arcade returns to Apps without an agent task. |
| Grouping | Passed: one Notion card showed a native account, a Composio account, two accounts from each of two Arcade gateways, and an Executor account. Repeated “Work” labels remained separate. |
| Upstream changes | Passed: adding and disconnecting simulated Arcade accounts followed by its gateway’s Refresh updated only that gateway’s account rows. Other providers and the native account remained. |
| Upstream management | Passed: imported kebabs contained only Open in the provider. Executor’s link retained its workspace path. Browser verification inspected destinations; it did not complete external provider sign-in. |
| Optional Arcade sync | Passed: the browser saved a synthetic discovery key through the real manager-only endpoint and imported the second gateway’s accounts. Database tests also prove existing API-key/user-header reuse and discovery-only vault use. |
| Failure states | Passed: expired authorization and an incomplete page retained last-known accounts without green checks. Unsupported Executor inventory showed unavailable, retained stale accounts, and recovered after refresh. |
| Isolation and rotation | Passed: service tests cover viewing-user/gateway/company isolation, member/agent configuration denial, endpoint changes, and an actual vault credential rotation followed by discovery using the new value. UI/API-client tests prove user switches do not reuse another user’s account cache or pending HTTP response. Manager account responses also use private, no-store HTTP caching. |
| Navigation | Passed: all six chips, Paperclip-to-All search expansion, explicit source scope, clear search, installed pinning, pagination, and empty states. The catalog Storybook interaction also completed without console errors. |
| Unknown apps and mobile | Passed: an unknown Executor integration retained a separate card and unverified status. At 390px the production page’s content width was 382px, with wrapped chips and readable account rows. The viewport override was reset afterwards. |

The initial fixture run ended on the full-stack story. Its upstream controls are explicitly labeled simulated. That run did not exercise native OAuth or live provider dashboards; working Arcade/Executor credentials were unavailable.

### Permissions-page follow-up: real Paperclip test drive

The actual CLI `test-drive` server is running from this checkout at
`http://localhost:3105`, with an isolated PostgreSQL database and the agent key
from `~/.secrets`. The user subsequently connected a real Composio gateway.
The embedded browser verified its Permissions page at
`/AGG/apps/f878eeb0-b1b9-4081-b779-ffecf3b41e7a/permissions`:

- Detected Airtable and Circleback from the live saved Composio session.
- Manual Refresh Composio displayed “Refreshing…” and catalog-check progress,
  then completed with both apps visible.
- Navigating away and returning automatically started a refresh without a click.
- The redundant sign-in guidance and update-permissions button are absent.
- The catalog exposes Paperclip, Composio, Arcade, Installed, and All.
- 317 focused AppDetail, AppsConnect, and Browse tests pass, including setup
  navigation, first-load refresh, progress/completion, upstream reconciliation,
  retained observations after failure, unsupported discovery, and manager-only
  visibility. UI typecheck, UI production build, and token gates pass.

This walkthrough did not repeat OAuth sign-in or change upstream accounts. The
post-setup redirect is covered by connection-flow tests. The real gateway had two
observed apps, so overflow with a long real account inventory was not exercised.
The list has a bounded height and keyboard-focusable vertical scroll container.
Refresh and settled-page screenshots are saved as `composio-apps-refreshing.png`
and `composio-permissions-connected-apps.png` in this task's visualization folder.

### Automated checks

- 261 focused UI/provider/API-client tests passed: Browse, AppsConnect, inventory adapters, and HTTP request isolation.
- 8 database/service/authorization tests passed, with no skips in the final run. These reused the disposable browser-test database because the host had exhausted its 32 PostgreSQL shared-memory slots. The optional `PAPERCLIP_AGGREGATOR_TEST_DATABASE_URL` test override accepts only a local, disposable database.
- 9 shared catalog tests passed.
- Final `pnpm -r typecheck`, `pnpm build`, token gates, and `git diff --check` passed.
- `pnpm test:run` was attempted but did not complete successfully. It encountered a timeout in `workspace-git-snapshot-streaming.test.ts`, failures in `heartbeat-run-event-sequencing.test.ts`, and numerous PostgreSQL startup skips; the run ended with exit 130. A separate remote-MCP compatibility run also could not start PostgreSQL. These repository-wide checks are not reported as green.

Local verification logs: `/tmp/paperclip-aggregator-focused-final.log`, `/tmp/paperclip-aggregator-db-final.log`, `/tmp/paperclip-full-typecheck-final.log`, `/tmp/paperclip-full-build-final.log`, `/tmp/paperclip-token-gates-final.log`, and `/tmp/paperclip-full-test.log`.

Desktop and mobile screenshots are saved in the task’s visualization workspace as `managed-aggregator-accounts.png` and `managed-aggregator-accounts-mobile.png`. This is fixture-backed acceptance evidence, not live provider certification or a production release sign-off.
