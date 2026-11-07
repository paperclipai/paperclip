# Composio account sync user stories

October 3, 2026 · Acceptance criteria written before implementation; results recorded after the embedded-browser walkthrough

The user starts on Apps with a saved Composio gateway. Composio owns app accounts and authorization; Paperclip shows provider observations and controls access to the saved gateway. Existing access restrictions must survive every discovery and setup action.

The current Connect MCP credential supports account listing by toolkit, not an authenticated list-all inventory API. Automatic discovery therefore checks the supported Composio catalog in bounded background batches, independently of search and pagination. Custom apps absent from that catalog remain outside this coverage. The UI and final test report must describe that limit.

## Expected journeys

| Story | Expected outcome | Independent evidence |
| --- | --- | --- |
| As a returning user, I see apps already authorized in Composio without searching or reconnecting them. | Apps begins syncing the saved gateway. Accounts discovered anywhere in the supported catalog move above the paginated catalog, with their app logo and Composio source. | Provider fixture has a pre-existing account outside the first catalog page; no add call, task, new gateway, or grant is created. |
| As a user, I reuse an existing app authorization when I click Connect. | Select a saved Composio account, continue, and see its existing app account. No second sign-in link. | Provider calls contain list only for the already active app. |
| As a user, I authorize a missing app directly. | Choose the saved account, open the hosted provider link, complete sign-in, and return to verify. No agent or task picker. | Provider account changes after authorization; completion reads it again. |
| As a user, I see an app I connected independently. | Automatic sync or Refresh discovers it without finding its catalog page. | Change the disposable provider's account state independently; use the production Apps UI to refresh. |
| As a user, I see an app disconnected or expired independently. | A complete account check removes the disconnected account or shows Needs sign-in for the expired one. | Provider returns an empty list or EXPIRED account; the old green Connected state disappears. |
| As a user, I manage Composio app accounts in Composio. | Manage lists the observed accounts and offers Open in Composio. No local rename or remove action that silently changes upstream state. | Open the row menu and management dialog; inspect the external link and confirm zero rename/remove calls. |
| As a user, I understand whose permissions I am editing. | Imported app menus say Composio permissions and open the saved gateway. A short explanation says access applies across this gateway's apps. | Navigation goes to the gateway's existing permission screen; native connectors retain Permissions. |
| As a user, I see native and Composio account sources accurately. | Native Connect remains preferred; an already authorized upstream account remains visible. Attribution says Via the quoted gateway name rather than inventing an upstream author. | Seed a native-overlap app upstream; inspect its card, account row, and source link. |
| As a user, I can recover from a failed check without losing accounts. | Keep prior observations with a visibly unverified status; show a useful retry action. A successful retry restores verified status. | Provider failure followed by success; no account deletion or false disconnected result. |
| As a user with several Composio gateways, I see accounts grouped by their actual source. | Show each source separately and preserve selection in setup/management. | Distinct provider accounts behind two saved gateways; calls use the selected gateway. |
| As a user, I remove the local Composio gateway without deleting its upstream apps. | Confirmation states that Composio accounts remain. Saved gateway access and its imported rows disappear locally. | Use a disposable gateway; provider accounts remain and no upstream remove/revoke-app call occurs. |
| As a user, I can browse and search a large catalog while sync runs. | Installed accounts stay above each catalog page. Sync feedback does not block search, pagination, or cancel. | Search and change pages during sync; inspect persistent accounts and bounded page size. |

## Verification boundaries

Use the embedded browser against the built production UI and real Paperclip server/database. Live checks use the existing Composio test gateway for reads and management navigation. Authorization, expiry, independent disconnection, errors, and local removal use a clearly marked disposable provider fixture so valuable real accounts are preserved.

Fixture results establish Paperclip behavior through the real UI and backend, not real Composio authorization compatibility. Record these separately. A passing unit test or API response alone does not pass a browser journey.

## Results

The implementation and all twelve Paperclip browser journeys passed within the boundaries below. Fresh third-party OAuth consent was simulated through the disposable provider; it is not claimed as a live provider pass. Live reuse and discovery were verified with the saved Composio gateway and independently compared with Composio's own account inventory.

### Live Composio

Tested the built Apps UI at `http://localhost:3104/TES/apps`, using the existing **Composio test gateway**. No real account was removed, renamed, or newly authorized, and no agent permissions were changed.

- Automatic discovery checked all **1,583 catalog toolkit identifiers**, including aliases and native overlaps, with zero failed toolkit checks. Circleback and the independently connected Airtable account appeared above the paginated catalog without searching for them or requesting another sign-in.
- Opening the old `/TES/apps/connect?source=composio&targetToolkit=circleback_mcp` URL selected the saved gateway. Continue reused the active Circleback account, closed setup, and cleared the setup query. Reload did not reopen the dialog. No new task or gateway was created.
- Manage Circleback showed the provider account and its default status, the quoted source connection link, and the explanation that Paperclip permissions apply across this gateway. The source link opened the correct existing permission screen. Native Notion retained **Permissions** and **Remove connection**.
- **Open in Composio** was clicked from Paperclip. Its final destination was the consumer **For You → Connect Apps** screen, rather than Platform developer projects. Selecting Connected showed the same two apps: Airtable and Circleback MCP, both with one active account.
- A subsequent background check failed at 448 of 1,583 identifiers. Previously observed accounts remained visible as unverified. Refresh recovered, and the next complete scan again checked 1,583 identifiers with zero failures. The failure's provider/transport cause was not established; it is not presented as an app disconnection.

### Disposable provider journeys

Used the production React build, company-scoped tool-access routes, service, and real local PostgreSQL database at `http://localhost:3110/COM/apps`. Only outbound responses for two explicitly fictional fixture gateways were controlled through the service's existing remote-request test seam. This was a separate company with a paused agent and no issues.

| Journey | Browser result and corroboration |
| --- | --- |
| Pre-existing apps without search | Circleback accounts behind two gateways, imported Notion, and Zendesk outside the first catalog page appeared automatically. No add request, task, or agent grant was needed. |
| Existing authorization | Live Circleback reuse passed as described above; setup checked the existing account before deciding whether authorization was needed. |
| Missing app authorization | Spotify opened the saved-account dropdown with Work, Personal, and Connect a new account. No agent picker appeared. Continue produced the hosted sign-in link. Premature completion showed a useful “finish connecting” error. After independent fixture activation, completion verified the account and displayed its connected row. The fictional hosted link itself was not opened. |
| Independent connection | Added Spotify and Airtable in provider fixture state, then clicked Refresh. Both appeared without using their native Connect actions. |
| Independent disconnection and expiry | Removed Personal Circleback and Zendesk upstream; expired Work Circleback. After sync, the removed accounts disappeared, Zendesk returned to Connect, and Circleback showed Needs sign-in rather than a green check. |
| Provider-owned management | The imported row menu contained only Open in Composio and Composio permissions. Manage was an observation view with Refresh and the provider link. Recorded provider actions contained no rename or remove operation. |
| Permission ownership | Composio permissions navigated to the actual saved gateway. Its explanation appeared before the human/agent permission controls. No permissions were changed by discovery or setup. |
| Native overlap and source attribution | The Airtable card retained native Connect while displaying its already connected upstream account. Imported Notion remained visible. Imported rows said Via the quoted gateway name; native rows retained Connected by. |
| Failed refresh and recovery | Injected HTTP 503, clicked Refresh, and saw the last known accounts with Not verified and retry. Restored the provider, clicked retry, and saw verified Connected again. |
| Several gateways | Circleback showed two distinct accounts and source links. Management switched between Work and Personal; after Personal's upstream removal it correctly showed no accounts, without displaying Work's account under Personal. |
| Local gateway removal | Cancel preserved the gateway. Confirming Remove archived Work and revoked its local organization grant; Work's imported rows disappeared, while Personal remained. The fixture's upstream account state was byte-for-byte unchanged. No upstream remove or rename action occurred. |
| Search and pagination during sync | Searched Spotify while checking; cleared search; moved to page 2 showing 25–48 of 1,548 connectors; searched meeting apps while checking. Installed accounts remained above the catalog and browsing stayed responsive. |

Additional checks: a single-provider Circleback action skipped the provider picker. After Work's removal the saved-account dropdown offered Personal and Connect a new account. Choosing the latter opened normal gateway setup with organization-wide defaults, a Reuse an existing session disclosure, and one Change link. Cancel created no gateway.

The fixture call log recorded **list** and one **add** action, with a maximum batch size of **32**. Database checks found zero fixture issues, no added agent grants, an archived Work gateway, and an active Personal gateway. The fixture's health check was adjusted to prevent the real server from probing the fictional host; this was fixture setup, not a product fix. After recording these results, the disposable company was archived and its fixture server and browser tab were closed. The live Apps page remains available.

### Issues found and corrected during the walkthrough

1. The legacy targeted setup URL opened a new-gateway wizard despite an existing active gateway. It now uses the saved-account chooser, preserving explicit new/resume/reconnect flows.
2. Successful targeted setup left query parameters that reopened the dialog on reload. Completion and cancel now consume that setup query.
3. The imported account button had a duplicated “account account” accessible label. The label now uses the account's actual name.
4. Gateway permission scope appeared below the controls. It now precedes them so users see the scope before editing.
5. The bare Composio dashboard URL opened Platform developer onboarding. The consumer-management link now uses `https://dashboard.composio.dev/~/org/connect/apps`, verified in the embedded browser without embedding a user-specific organization slug.

### Automated verification

- Focused UI/shared tests: **320 passed** across Browse, AppsConnect, AppDetail, aggregator setup, and catalog mapping.
- Backend Composio setup/sync tests: **21 passed**, including batch size, concurrent leases, incomplete/error evidence, recovery, company access, and credential changes during a check.
- Repository-wide `pnpm -r typecheck`: passed.
- Repository-wide `pnpm build`: passed; the final management-link edit also passed a fresh UI build.
- `pnpm check:token-gates`: passed after the final UI edit.
- Repository-wide `pnpm test:run`: failed in the first general-server phase after **14,825 tests passed**, with timeout failures in access-service startup, project-icon startup, direct-adapter execution, and Git streaming, plus a worker-start timeout for server-info. Later workspace/serialized phases did not run because this command stops on failure.
- Separate rerun of those five files: **32 tests passed** across access-service, project-icon-persistence, heartbeat-direct-adapter-native-isolation, and server-info. The single `workspace-git-snapshot-streaming.test.ts` test still timed out at its 300,000 ms limit. That test and its implementation were not changed by this work. No full-suite pass is claimed; its remaining timeout is recorded rather than hidden or worked around by changing the test.

### Coverage limits

Automatic discovery covers the supported public catalog, not arbitrary custom apps absent from that catalog. It uses the authenticated Connect MCP account-list tool because saved gateway OAuth is not a consumer list-all API key. Observations are isolated by company, human viewer, and credential selection; changed credentials require fresh evidence.

The hosted authorization handoff, premature completion, and post-authorization verification were tested with controlled provider responses. This report does not claim that a new real Spotify OAuth consent flow was completed. No paid runner evaluation, exhaustive mobile/accessibility audit, or new Arcade account synchronization was performed. Existing Arcade setup remains intact.

Paperclip still exposes and governs the saved gateway's outer MCP tool catalog. Imported app rows do not re-publish each underlying service's tools or promise app-level permission isolation inside Composio's gateway.
