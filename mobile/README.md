# Paperclip Mobile (Android Spike)

Expo React Native shell for Paperclip issue execution with offline recovery primitives.

## What this spike includes

- Android-ready Expo app shell in TypeScript
- Authenticated inbox + issue-detail fetch (`todo`, `in_progress`, `blocked`) for a single agent
- Inbox status filters (`all`, `todo`, `in_progress`, `blocked`) with priority+recency sorting
- Deferred write queue for checkout/comment/status mutations while offline
- Replay-on-reconnect with explicit conflict/failure surfacing in UI
- Manual bearer-token entry in app UI (with optional env prefill)

## Local run (Android emulator)

1. Install Android Studio + emulator image, then start an emulator.
2. From repo root, install dependencies:

```bash
pnpm install
```

3. Configure app env:

```bash
cp mobile/.env.example mobile/.env
```

Set:
- `EXPO_PUBLIC_PAPERCLIP_API_URL`: reachable API URL from emulator/device.
  - For Android emulator: `http://10.0.2.2:3100` (host loopback)
  - For physical device: use your LAN or VPN host IP, for example `http://192.168.1.100:3100`
- `EXPO_PUBLIC_PAPERCLIP_COMPANY_ID`
- `EXPO_PUBLIC_PAPERCLIP_AGENT_ID`
- `EXPO_PUBLIC_PAPERCLIP_DEPLOYMENT_MODE`: `local_trusted` or `authenticated`
- Optional `EXPO_PUBLIC_PAPERCLIP_RUN_ID` (mutating requests require run-id propagation)
- Optional `EXPO_PUBLIC_PAPERCLIP_API_KEY` for local convenience
- Optional `EXPO_PUBLIC_QA_SEEDED_API_KEY` for deterministic QA sign-in via fixture button

4. Launch app:

```bash
pnpm --filter @paperclipai/mobile android
```

## Local run (physical Android device)

1. Install Expo Go from Play Store.
2. Start the dev server:

```bash
pnpm --filter @paperclipai/mobile start
```

3. Scan the QR code in terminal from Expo Go.
4. Paste a Paperclip API key in the app and tap `Sign in`.

## Mobile auth contract (M0)

Deployment-mode behavior:

- `local_trusted`
  - app may persist bearer token session in local storage for restart restore
  - on successful validation, session state is `active`
  - token restore is attempted on app boot
- `authenticated`
  - token is treated as memory-only in the mobile shell
  - persisted token storage is cleared on boot
  - user must sign in each app restart unless using env/fixture injection for testing

Session lifecycle states surfaced in UI:

- `signed_out`: no active token loaded
- `active`: token validated by inbox fetch
- `expired`: API returned unauthorized (`401/403`), token/session cleared, re-auth required
- `error`: session bootstrap/storage failure

Refresh/expiry/error semantics:

- no silent refresh-token flow yet in this shell
- any unauthorized response on inbox/detail/mutation paths invalidates session and requires sign-in
- offline/network errors do not invalidate session; they route through offline cache/queue behavior

## Notes

- Mutating actions (checkout/comment/status) are queue-backed and will be deferred when offline.
- Replay conflicts are intentionally surfaced in the UI and preserved in local replay history.
- `authenticated` mode intentionally avoids token persistence-at-rest pending secure storage integration.

## Push notifications (M2 groundwork)

- Notification preference is persisted per `(companyId, agentId)` profile in local storage.
- Opt-in requests OS permission and attempts Expo push-token provisioning.
- Notification tap routing supports assignment/mention wake payloads and focuses the target issue in-app.
- Deep links use app scheme `paperclip-mobile://` with one of:
  - `paperclip-mobile://issue/<issue-id>`
  - `paperclip-mobile://open?issueId=<issue-id>`

Expected push payload fields for issue wakeups:

```json
{
  "eventType": "issue_assignment",
  "issueId": "uuid",
  "issueIdentifier": "PROJ-16",
  "deepLink": "paperclip-mobile://issue/uuid"
}
```

`eventType` may be `issue_assignment`/`assignment` or `issue_mention`/`mention`.

## QA deterministic auth contract

For AUTH smoke flows, QA can avoid manual paste by setting:

- `EXPO_PUBLIC_QA_SEEDED_API_KEY=<qa bearer token>`

When present, the auth panel exposes a one-tap action (`Use QA fixture token`) that applies the seeded key and loads inbox data in a deterministic path.

## Stable test selectors

Android shell exposes fixed `testID`s for smoke automation:

- `pc-auth-form`
- `pc-auth-token-input`
- `pc-auth-submit-button`
- `pc-auth-qa-fixture-button`
- `pc-inbox-refresh-button`
- `pc-offline-banner`
- `pc-replay-queue-button`
- `pc-mutation-queue-count`
- `pc-inbox-filter-all`
- `pc-inbox-filter-todo`
- `pc-inbox-filter-in-progress`
- `pc-inbox-filter-blocked`
- `pc-issue-list-container`
- `pc-issue-list`
- `pc-issue-detail-panel`
- `pc-issue-detail-comments`
- `pc-issue-comment-input`
- `pc-issue-comment-submit`
- `pc-issue-checkout-action`
- `pc-issue-set-status-done`
- `pc-issue-set-status-in-progress`
- `pc-empty-state`
- `pc-error-state`
- `pc-issue-card-<issue-id>` (prefix for per-item assertions)

## Telemetry + crash diagnostics baseline (M0)

The mobile shell includes an on-device diagnostics module (`src/diagnostics.ts`) wired into app runtime flow (`App.tsx`):

- Breadcrumb timeline for connectivity checks, auth, inbox fetch, queue replay, and diagnostics actions
- Global runtime error capture via `ErrorUtils` and explicit `recordDiagnosticsError(...)` capture in request/share flows
- Redacted context on every diagnostic event:
  - `companyId`
  - `agentId`
  - `runId`
  - `issueId`
  - `issueIdentifier`

Redaction behavior:

- IDs are never exported raw
- values are transformed to short form (`abcd...wxyz`) or `***` for very short values

This gives QA/engineering enough signal to correlate failures with Paperclip issue/run context without exposing full identifiers in shared logs.

## QA diagnostics export path

In-app path for testers:

1. Open the app and reproduce the issue flow.
2. In the `QA diagnostics` panel, tap `Share diagnostics`.
3. Choose a target (Slack/Telegram/email/notes) from the native share sheet.
4. Attach the exported JSON text to the test report and include:
   - timestamp
   - observed issue identifier
   - expected vs actual behavior

Optional:

- Tap `Preview JSON` first to inspect the payload before sharing.
