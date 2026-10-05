# Browser Use Cloud

This connection delegates website work to Browser Use's hosted agent through its
v4 REST API. The task's Browser tab embeds the provider's interactive live viewer.
The connection's API key stays in Paperclip's vault and is never exported to the
agent, local browser tools, or the board UI.

## Connect and configure

Choose **Browser Use Cloud** (`browser-use-cloud`) in Apps, select agent access, enter a project API key from
[Browser Use settings](https://cloud.browser-use.com/settings), and review
Permissions. No OAuth registration, callback, Paperclip ID, or external connection
broker is required. Cloud and self-hosted instances use the same server-side path.
The instance needs outbound HTTPS to `api.browser-use.com`; browsers need access
to `live.browser-use.com`. An operator-supplied CSP must permit that viewer origin
in `frame-src`.

The setup probe reads profiles without creating paid work. Existing personal and
organization grants, audience restrictions, installations, policies, approvals,
and invocation audit remain authoritative. Browser settings on Permissions are
per credential: the owner (or a shared connection manager) can set a maximum cost per run and explicitly allow
existing saved profiles. No selected profiles means fresh browsers. Profiles can
contain authenticated website sessions, so selecting one grants meaningful access.
Paperclip does not create or import profiles.

## Reviewed actions

| Action | Risk | Scope and behavior |
| --- | --- | --- |
| `browser_start` | Destructive-capable | Delegate a task; optional allowed profile and lower cost cap. |
| `browser_status` | Read | Current run status, sanitized result, progress and recorded run cost. |
| `browser_continue` | Destructive-capable | Start a new turn in an idle owned conversation. Busy sessions reject it. |
| `browser_cancel` | Destructive-capable | Cancel hosted agent work; keep the browser for the idle window. |
| `browser_end` | Destructive-capable | Cancel work and stop every browser registered to the conversation. |
| `browser_sessions` | Read | List conversations for the current task, agent and selected grant only. |
| `browser_profiles` | Read | List existing profiles explicitly allowed for the selected grant. |

Start, continue and control are conservative because a natural-language browser
task can change external systems. They use the normal Allowed / Ask first / Off
policy, rate limits and signed approval path. A new action or schema change goes
through the existing catalog review/quarantine configuration. Arbitrary HTTP
endpoints, CDP, provider run IDs and browser IDs are not agent inputs.

Hosted execution requires a bound task and agent run. The Apps Test surface can
use `browser_profiles`; paid starts there are rejected with task guidance. For a
hosted test, use a real task so ownership, budgets and cleanup are exercised.

## Runtime and lifecycle

The gateway exposes reviewed REST tools to existing native and CLI tool bridges.
Authorized task/run access contributes the `browser-use-cloud` skill, bundled
with the connector in `server/src/services/connectors/browser-use-cloud/skill.ts`.
It is not in the universal `skills/` directory and is not offered to every agent.
The existing connector assignment resolver requires accessible connection tools
and a current credential grant. No assignment, disabled tools/connections, or
revoked access means no skill. The run-scoped bundle exposes its short description
for discovery and contains the detailed `SKILL.md` for using this connection.
Adapters that cannot isolate skill files receive the same authorized instructions
in their run context. Nothing is added to an agent's saved skill preferences.
Retired `paperclipai/paperclip/browser-use` selections are stripped from runtime
overlays; unrelated browser skills keep their own names and behavior.
The idempotent migration updates pre-release app/connection and financial keys
to `browser-use-cloud` without replacing credentials, grants, or browser records.

The parent agent starts
a hosted run, polls its status and stays alive until it finishes. Approved starts
can execute after the requesting turn ends: a ten-minute handoff window lets the
resumed agent attach by reading status. An expired handoff stops unfinished work.

Four company-scoped tables separate grant settings, conversation ownership, hosted
runs and browser instances. Each hosted run records its invocation, parent run,
event cursor and cost checkpoint. A leased reconciler polls minimal status,
drains bounded event pages, discovers browser instances by conversation, and
checks each instance's authoritative conversation association. Restarting the
server resumes reconciliation. A lost paid-create response becomes an explicit
unknown outcome and is never submitted again automatically; the operator must
inspect Browser Use before starting replacement work.

Each new ready browser session opens once per task/account in the right panel. A task
card and the panel launcher reopen it. Switching tabs preserves the iframe.
Closing the tab hides it; **Close browser** in the footer menu stops the provider browser. **Stop browsing**
requests hosted-run cancellation. Visible viewers keep completed browsers open;
leaving the viewer starts a ten-minute idle window.
**Keep browser open** in the footer menu renews that window, bounded by provider expiry.
Only the final five minutes show a seconds countdown and a direct **Keep browsing**
action. **Reconnect view** reloads the live display without restarting browser work.
The footer has no cost display. **Browser size** defaults to **Fit to pane**.
A ResizeObserver measures the iframe's actual CSS size and, after 250 ms without
another meaningful change, applies the remote viewport through CDP. Only the
newest pending dimensions are retained; requests are serialized. The iframe is
not reloaded. Fixed presets disable automatic fitting until Fit to pane is chosen.
Only the visible panel in a visible document resizes. One viewer holds a 20-second
in-memory lease, renewed every eight seconds and released when hidden/unmounted.
Other viewers show **Size follows another viewer** and can explicitly choose
**Fit to this pane instead**. Automatic updates never take over a live lease or
override a newer fixed selection. A resize failure pauses fitting until a size
is explicitly selected again. Socket/server restart resets the mode to fitting.

Browser Use's current viewer has a 30-pixel tab strip and 40-pixel navigation bar.
The Paperclip token `--browser-use-viewer-chrome-height` records that measured
70-pixel allowance; Paperclip's footer is excluded by observing the iframe itself.
The provider's published viewer bundle exposes no sizing postMessage contract.
This keeps navigation available but requires rechecking the allowance if the
provider changes its chrome; it is not a guaranteed cross-origin measurement.
Remote dimensions are bounded to 6144 × 3456, scaling proportionally at the limits.
One-pixel jitter is ignored. These dimensions are browser settings, not UI tokens.

The same menu also offers Phone (390 × 844), Tablet (768 × 1024), Laptop (1280 × 800), Desktop (1440 × 900),
and **Browser default**. Presets fix the remote page viewport; changing panel size
scales that viewport. Failed resizes retain the previous selection and show an
inline error. Follow-up work uses a
normal task message and `browser_continue`, with the same conversation ID.

Cancellation/failure of the owning run, task cancellation/reassignment,
agent pause/termination, task pause, budget blocks, grant/access removal and idle
expiry request cleanup. Completing a task stops unfinished hosted work; a completed
hosted run retains its idle grace period. Stop is not considered complete until the provider confirms
it. Terminal event pages and accounting finish before the session closes. Removing
the app disables its access first, then confirms shutdown before deleting secrets.
If shutdown is pending, removal returns a retryable conflict; only cleanup retains
credential access, and retrying removal finishes secret deletion.

## Credential and budget boundaries

The board list and stored tab state contain internal IDs and safe metadata only.
An authenticated, active, non-viewer company member with access to the exact grant
can request a viewer URL through a `no-store` endpoint. Agent keys cannot use that
endpoint. Only the exact HTTPS `live.browser-use.com` origin is accepted. The URL
lives in component memory, uses `no-referrer`, and is revalidated while hidden.
Provider events/results are sanitized before persistence or gateway output; live,
CDP, recording and other URL fields are excluded. Do not put a viewer link in a
comment, log, tool response or artifact.

Each dispatch uses the minimum of the requested cap, configured grant cap and
applicable remaining hard company/agent/project budgets. Unconfigured limits do
not invent a cap. Provider run `totalCostUsd` is recorded through a locked,
idempotent cumulative checkpoint and feeds normal Paperclip budget enforcement.
Each positive accounting delta also creates a linked, task-scoped `finance_events`
row in the same transaction as its `cost_events` row. Reconciliation retries do
not duplicate either entry. Costs remain available for reporting without appearing
in the browser footer. These are recorded run charges, not a live invoice. Browser hosting and
proxy fields are not added separately because their relationship to run totals
has not been verified; avoid double counting. Concurrent runs are not a shared
provider-side reservation. Recording is explicitly off. Artifact/file import,
recordings and arbitrary provider queue interruption are not part of this connection.
CDP is limited to board-authorized viewport presets and bounded pane dimensions; arbitrary commands and
credential-bearing CDP addresses are never exposed to the UI or agent tools.

## Validation and live proof

Deterministic tests use the real vault, connection setup, policy/approval gateway,
Postgres tables, reconciler and routes with a controlled v4 provider fixture.
They cover paid-create idempotency/uncertainty, ownership, delayed browser readiness,
viewer authorization and no-store headers, durable event pagination, cost dedup,
approval handoff, revoked access and shutdown before secret removal. Panel tests
check iframe preservation and tab closure. Storybook provides the production panel
with explicitly simulated interactive, idle, closed, failed and revoked states.

For live acceptance, connect a dedicated test credential in the isolated instance:

1. Confirm setup/discovery performs no paid start and the agent receives the tools.
2. Delegate a harmless public-page task with a small cap; inspect the actual viewer
   while the run is active and type/click in it.
3. Switch tabs, close/reopen, stop the hosted agent, keep an idle browser open, and
   continue through a task message. Verify a second agent or different grant cannot
   use the conversation or fetch its viewer.
4. Exercise Ask first, denied access, restart during work, provider rate limiting,
   idle expiry and connection removal. Confirm provider shutdown and one cost entry
   per cumulative billed increment without any viewer credential in audit.

The live test-drive used a fresh
database with one company, one agent and one task; it contains no cloned inbox or
task history. The connection was configured through the normal setup wizard and
given a $1 per-run limit with fresh browsers. Browser Use completed a real v4 run
that explored `paperclip.ing`, visited About and returned to the homepage. The
recorded run cost was $0.01. The completed browser was visible in Paperclip's
Browser tab, and manual address-bar navigation and Back worked inside the iframe.
Keep open renewed the idle countdown. The initial blank viewer recovered after a
page reload; provider results alone were not treated as proof of the viewer.

An earlier run exposed a runtime transport filter that excluded
Browser Use REST tools even though the skill was installed. Both runtime tool
delivery and the native assignment snapshot now include this reviewed REST
connection, with a regression test covering all seven tools. Live acceptance of
revocation, approvals, rate limiting and restart recovery remains outstanding;
those cases currently have deterministic fixture coverage.

## Verification record — 2026-09-29

- Footer redesign: 59 Storybook states across panel, footer, task activity and
  credential settings. UI typecheck/build, Storybook build, token gates and 34
  existing panel/state tests pass. Browser walkthrough verified the 5:01/5:00
  countdown boundary, narrow layout, timer extension, preserved page state after
  stopping work, reconnect/close controls and saving settings with offline fixtures.
- Fresh live test: setup/discovery, actual hosted task, completed result, $0.01
  accounting, interactive iframe navigation, and Keep open verified. The runtime
  delivery regression suite passes 14 tests; server TypeScript check passes.
- `pnpm -r typecheck` and `pnpm build`: passed. The final lifecycle changes also
  passed server typecheck/build and UI typecheck.
- Browser Use backend: 18 passing tests; task-panel/state/brand tests: 43 passing;
  shared app-definition tests: 24 passing; gallery route assertion: passing.
  Existing gateway/connection/removal regression suites: 429 passing tests.
- `pnpm check:token-gates`, brand asset validation, module boundary validation
  and `git diff --check`: passed.
- Browser inspection of the production panel with a simulated provider: typed
  input survived Properties/Browser tab switches; Stop agent, Keep open and End
  session behaved correctly; controls remained usable at a 390-pixel viewport.
- The full `pnpm test:run` attempt was stopped after known failures. Its gallery
  count assertion was updated for the added app and passed on retry. Its unrelated
  Slack callback-ordering test passed in isolation. There is no clean full-suite
  result from this worktree.
- The optional `pnpm check:tokens` content check finds existing names in unrelated
  Storybook fixtures. None of the new Browser Use files introduced those matches.

## Provider research

Reviewed on 2026-09-29:

- [v4 overview](https://docs.browser-use.com/cloud/api-v4-overview): current REST
  base URL and API key header; minimal status polling and terminal summary.
- [v4 OpenAPI](https://docs.browser-use.com/cloud/openapi/v4.json): run/session/browser
  identities, continuation by session, events, cancellation, profiles and cost cap.
- [Live preview and recording](https://docs.browser-use.com/cloud/browser/live-preview):
  browser-ready event, interactive iframe, credential treatment and recording flags.
- Official artwork: [Browser Use logo](https://browser-use.com/logo-primary.svg),
  copied as a sanitized local SVG; provenance is in the app brand manifest.

The connector uses v4 directly. It does not mix v3 MCP task/session methods with
v4 runs, and it does not substitute Paperclip's existing execution agent adapter.

## Viewer size and Storybook coverage

The iframe fills the available panel height and width without a Paperclip-imposed
aspect ratio. The provider streams an existing remote viewport, so scaling its
viewer does not make the website switch responsive breakpoints.

The published v4 `RunBrowserSettings` schema exposes `screenWidth` (320–6144) and
`screenHeight` (320–3456) at browser creation. Explicit settings on a follow-up
apply only when provisioning a new browser. The schema does not list
`allowResizing`, although a live test on 2026-09-29 established that sending
`browserSettings: { allowResizing: true }` when creating an agent run enables
runtime viewport resizing. Treat this as verified provider behavior with an
OpenAPI documentation gap, not a documented contract. The standalone browser
creation API documents the same opt-in and notes its stealth tradeoff.

Live test results, using the same browser and page throughout each test:

| Browser configuration | Requested viewport | Measured page viewport | Result |
| --- | --- | --- | --- |
| Agent run, default resizing policy | 480 × 800, then 900 × 700 | Stayed 1280 × 588 | CDP commands succeeded but had no effect; native window resizing also had no effect |
| Standalone browser, `allowResizing: true` | 480 × 800, then 900 × 700 | 480 × 800, then 900 × 700 | Responsive layout and screenshot dimensions changed |
| Agent run, `browserSettings.allowResizing: true` | 480 × 800, then 900 × 700 | 480 × 800, then 900 × 700 | Both changes occurred while run status was `running`; live viewer followed the change |

The successful command was server-side CDP `Emulation.setDeviceMetricsOverride`
with `width`, `height`, `screenWidth`, `screenHeight`, `deviceScaleFactor: 1`, and
`mobile: false`. Verification checked `window.innerWidth/innerHeight`, layout
metrics, PNG screenshot dimensions, and a 600-pixel CSS media query. The media
query changed with the page width, proving reflow rather than viewer scaling.
The opted-in agent's 900 × 700 viewport persisted on a check 41 seconds later,
still during the run; the run subsequently completed. All three disposable cloud
browsers were confirmed stopped after testing.
The initial configured screen dimensions were not the actual page viewport;
browser chrome and device scaling affected the latter.

REST `PATCH /api/v4/browsers/{id}` still rejected both a dimensions-only body and
`action: "resize"` with HTTP 422. That endpoint documents only `action: "stop"`.
The live-preview docs do not specify a parent-frame resize message. Browser Use
does document [CDP attachment to a live v4 agent browser](https://docs.browser-use.com/cloud/agent/network-capture).

Automatic panel-size synchronization is implemented through
`POST /api/issues/:issueId/browsers/:browserId/viewport`. Fit requests carry bounded
width/height and a viewer UUID; fixed choices carry a validated preset. All use
the same company, task, grant and board checks as the viewer. New runs request
the resizing opt-in. A bounded CDP session verifies actual viewport dimensions,
reapplies the selection to new page targets, and serializes updates. Browser
default clears the override while retaining the selected mode. Mode and ownership
are shared by viewers on the same server process and reset on server/CDP restart.
Unsupported older browsers retain their existing size and show an actionable error.

The iframe stays mounted across resizing. Only the visible pane observes and
renews ownership; it debounces changes for 250 ms and coalesces pending updates.
A 20-second lease prevents concurrent viewers from fighting over dimensions;
the menu allows explicit takeover. See the interaction details above for viewer
chrome calibration and the fixed-size escape hatch. Resizing during an agent
action can invalidate screenshot coordinates; the live test covered a running
agent observing the page, not concurrent click safety.

Automatic fitting verification on 2026-09-29:

- 60 focused tests passed across viewport scheduling, CDP ownership and validation,
  connection routes, Browser Use service behavior and task-panel state. UI/server
  typechecks, UI/Storybook builds and token gates passed.
- In the embedded Storybook, the page reflowed at 358 × 527 and 798 × 327 while
  retaining typed input. Phone stayed 390 × 844 when the pane changed. Two viewers
  correctly handed ownership over through the menu.
- The fresh test-drive browser received a 478 × 754 Fit request and the backend verified
  those actual page dimensions. A subsequent real pane maximize/restore changed
  the remote viewport from 624 × 520 to 1040 × 520 and back through the automatic
  observer path. Its hosted viewer stayed at `about:blank` in the
  embedded browser, including after clearing the viewport override and reconnecting.
  Thus live remote sizing is verified, but a successful visual end-to-end fit in
  that test-drive remains unverified. The Storybook uses an offline fixture.

Storybook now groups the production panel and its lifecycle states, isolated footer
and expiry boundaries, task activity/reopening, and credential settings with
loading/error/access states. Offline interactions exercise keep-open, stop/close,
reconnect, profile selection, saving and changing/resetting viewport presets.
The offline viewer simulates reflow at the chosen preset and scales it to fit its
panel. It is not evidence of provider viewport resizing; that was tested separately.

## Follow-up opening and viewer presence

Browser sessions appear as compact entries in the chronological task feed at
their creation time, between the request and reply. Status updates stay on the
same session entry; **Open browser** opens its side-panel tab and **View session**
shows a closed session. There is no browser list in the task header. Older
sessions outside the loaded comment window appear when that history is loaded.
Storybook's **Task activity / Inline History** demonstrates successive sessions.

Each new live session opens its Browser tab once per task and browser tab, including
follow-up requests after older browsers have closed. Repeated polling does not
steal focus back after the user switches away. Open requests are acknowledged only
after the new tab selection has been committed and persisted.

A visible, selected Browser tab sends an authorized presence POST every 30 seconds.
The server renews the existing idle window (at most once a minute), respecting
provider expiry and the reconciler's shutdown lease. Hidden tabs and collapsed
panes stop renewing; closing a viewer does not immediately destroy its browser.
The ten-minute idle window applies after the last visible presence. Explicit
Close browser, revoked access, pause/budget gates and provider expiry still win.
No paid run is started by presence. Each renewal is activity-logged.

The iframe shows a loading state and reconnects once after 15 seconds if its
document never loads, then shows a recoverable error if the retry also times out.
Inactive browser tabs do not consume that load window. A viewer that did not
load cannot own automatic sizing. When a task has several sessions, the tabs use
the same browser numbers as task activity. A closed tab offers **Open active
browser** if another live session exists, without starting another paid run.
On 2026-09-29 the same provider iframe rendered successfully in Chrome, while
Codex's embedded browser left both the provider and a plain example.com iframe
at about:blank. After reconnecting to the updated test-drive, the embedded viewer
also loaded and displayed paperclip.ing. The new-session selection and automatic
presence renewal were verified there with the same hosted session; no replacement
paid run was needed.

Follow-up verification: 54 focused tests passed (15 service/route lifecycle tests
and 39 UI tests), plus UI/server typechecks, UI build and token gates. The original
hosted session stayed idle and available after its original deadline; viewing
renewed the deadline automatically. Closing/reopening the tab selected and rendered
that same session. Proof was captured in the isolated test-drive.

Second hands-on pass reproduced a stale closed tab and a viewer that required
manual reconnect. A fresh composer request then opened paperclip.ing automatically
and stayed visible after completion, switching tabs and reloading the task. The
original stalled-navigation cause remains unproven; the bounded automatic retry
and closed-tab recovery cover those observed failure paths. Recovery was exercised
in the actual test-drive; 41 focused UI tests, UI typecheck/build and token gates
passed. The automatic timeout retry is regression-tested with a non-loading iframe.

## Passkey limitation

The provider's current v4 authentication and live-viewer documentation does not
document WebAuthn/passkey forwarding from the viewer's device to the cloud
browser. Do not promise that a local Touch ID or iCloud passkey will work in the
embedded viewer. The documented alternatives are saved login profiles, passwords
and TOTP codes, and human entry of verification codes. Profile sync transfers
login cookies and browser state, not a password manager; sites can reject a
transferred login or require another verification step. See [profile sync](https://docs.browser-use.com/cloud/guides/profile-sync)
and [1Password integration](https://docs.browser-use.com/cloud/guides/1password).

## Uncertain starts and rejected continuations

Each paid task includes an opaque invocation marker. The v4 API has no documented
create idempotency key. If a response is lost or the process stops before saving
provider identifiers, Paperclip never repeats the paid POST. The reconciler scans
the documented run list for that exact marker, with a durable pagination cursor.
Once found, it cancels the run, discovers and stops its browsers, and records cost.
A missing list entry is not proof that no work exists: cleanup remains pending
and retains the credential while recovery continues. Each sweep reads at most
five pages. Continuations restrict recovery to their known provider session.

Definite request rejections (such as HTTP 409 or 429) atomically record a failed
local run and return its existing browser to idle. That browser remains visible,
gets a fresh idle grace period, and can still be closed. A crash before commit
leaves the run eligible for recovery. Provider backoff also applies to cleanup.
New-browser arrivals are queued in order and are acknowledged only after the
panel has selected and persisted the tab. Polling cannot claim an unseen arrival.
