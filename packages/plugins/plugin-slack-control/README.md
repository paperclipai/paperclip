# Slack Control (optional alpha)

Control configured Paperclip projects through a private Slack conversation. The plugin is disabled by default. It creates no agents, changes no agent instructions or credentials, and installs no Slack app automatically.

| Direct message | Result |
| --- | --- |
| `status` | Up to three task identifiers and states per configured project. No model invocation. |
| `new demo: Review the synthetic onboarding fixture` | Creates a task in the configured `demo` project, assigns its configured existing agent and requests a native Paperclip wake. |
| Reply in that message's Slack thread | Adds a human-attributed comment to the same task; normal Paperclip comment wake rules apply. |
| `status` within a bound task thread | Returns that task's current title and state. |

Commands must be plain text, at most 4,000 characters. `new` and project aliases use the exact lower-case syntax above; `status` is case-insensitive. Unknown commands return help. A `new` command inside an existing task thread is a comment, not another task. Attachments and rich-message content are not imported. Approvals, budget limits, blocked tasks and paused agents remain governed by Paperclip. A successful creation response does not mean an agent has started or completed the work.

## Implementation and boundaries

1. Validate one configured Slack workspace, at most ten explicit Slack-user to Paperclip-user mappings and ten project/agent aliases.
2. Accept only new human `message.im` events. Reject channels, group DMs, bot/app messages, edits, deleted/hidden messages, external-workspace identities and unlisted users. Confirm the conversation is a real one-to-one IM with that user using Slack's API.
3. Resolve both tokens through company-scoped Paperclip secret references. The authenticated bot workspace must match the configured workspace. Each command rechecks active human company membership and a writable role (`owner`, `admin`, `operator`, or legacy `member`). There is no implicit mapping from an email address, display name, local-board identity or Slack text.
4. Insert the event into the plugin's namespaced PostgreSQL inbox before acknowledging it. A worker-lifetime timer processes sequential batches of 25 every ten seconds, so replies can take up to ten seconds before processing starts. The timer is created during setup, outside the short-lived configuration invocation, and uses only the host's authorised proactive company scopes. Socket callbacks persist and acknowledge events; they do not perform company operations under an expired configuration invocation. Only bounded input validation and one database insert precede the acknowledgement; database outages can prevent Slack's acknowledgement deadline from being met, allowing provider retries.
5. Atomically claim each event once before any task/comment mutation. Store thread bindings by company, workspace, IM channel and root message timestamp. Future replies require the same Slack and Paperclip identities. Native human-comment attribution revalidates company membership in the host and records the user as author.

The plugin has one company configuration and one Socket Mode connection per worker. Reconfiguration closes the prior connection before opening the next, and stale connection handlers cannot dispatch new commands. A native request already in flight when configuration is disabled may still complete. Do not run a second instance of this plugin against the same Slack app and company database.

Initial authentication and Socket Mode reconnects share one retry loop. Transient network failures use exponential backoff from one second to a maximum of sixty seconds. A longer provider rate-limit delay takes precedence; if it exceeds Node's safe timer range, the plugin reports a `rate_limited` error requiring operator recovery instead of retrying early. Each attempt has a thirty-second authentication/hello deadline and uses fresh clients; SDK automatic reconnects and HTTP retries are disabled. Shutdown cancels backoff, pending requests and upgraded sockets through public SDK/undici APIs before another attempt can start. If teardown cannot be confirmed within five seconds, the plugin reports `cleanup_failed` and refuses replacement until the worker is restarted. Queued commands wait while offline and recheck the existing company/actor restrictions after recovery; already claimed or uncertain commands retain the delivery contract below.

Saving configuration starts connection work in the background; a successful save does not establish that Slack is connected. The board-only status response includes `connection.state`, `connection.lastFailure` (a fixed category) and `connection.retryAt` (a Unix timestamp in milliseconds or null). Invalid/revoked credentials, missing permissions, a workspace mismatch or an unclassified provider failure stop automatic retries and report an error. Correct the credentials or configuration and save again. Provider error bodies, headers, tokens and socket URLs are never returned or logged. Secret references are resolved only during the company-scoped configuration invocation, not from reconnect callbacks.

The host must replay persisted company configuration on both initial activation and worker crash recovery. This plugin does not include that host change or keep a separate hidden configuration cache. The upstream base used for this contribution replays configuration on initial startup only: after a worker crash, re-save configuration or restart the host to reconnect. Unattended crash recovery requires a separate host fix; related upstream work is tracked in [PR #10100](https://github.com/paperclipai/paperclip/pull/10100). Verify that the installed host includes recovery replay before relying on it.

This is a transport, not an account scheduler or a natural-language planner. It uses existing agent configuration and native limits; it does not add a shared subscription-account concurrency lock. Choose existing agents that already respect your account allocation. It cannot make a local machine's agents run while that machine is off. The Paperclip host and selected execution environment must be available.

## Delivery contract and recovery

Paperclip's current plugin SDK has no atomic idempotency key for creating an issue or comment. This plugin therefore uses an **at-most-once mutation fence**, not an exactly-once delivery claim. Repeated Slack event IDs cannot create repeated issues or comments. A crash after the durable claim but before the native call can leave a command unexecuted; retrying it automatically could duplicate a call whose response was lost.

On worker restart, a `working` event is reconciled by its plugin-owned issue origin or a matching human-authored comment marker. If the outcome cannot be established, it becomes `uncertain` and is not replayed. A caught ambiguous RPC error also becomes `uncertain` immediately. Known task creation followed by a blocked or failed wake remains a recorded task; its response directs the operator to Paperclip. A lost Slack response does not erase a known task result, and the acknowledgement message is not resent automatically.

Instance operators can inspect the board-authenticated endpoint:

```text
GET /api/plugins/<installed-plugin-id>/api/status?companyId=<company-id>
```

It returns connection state and the latest 25 delivery outcomes, including event hashes and known task IDs. It does not return token references or incoming message bodies. Some completed outcome text contains the task title or summary shown in Slack. There is no automatic push alert for `uncertain` events in this increment. If a command gets no response, inspect this endpoint and Paperclip before sending a new command.

While a connection exists, `authenticatedIdentity` exposes only its verified workspace ID, bot ID and bot user ID (or null when unavailable). These are identifiers from the existing `auth.test` response; status inspection makes no additional Slack request and exposes no credentials or response headers. The object is null when the connection is stopped.

The `diagnostics` object counts Events API envelopes received through the SDK's `slack_event` dispatcher, accepted messages, ignored messages and persistence/acknowledgement failures. Its last reason is a fixed category; no event identifiers, message bodies, tokens or provider errors are included. Counters reset on enabled reconfiguration or worker restart. `accepted` means the input passed validation, not that task processing completed; failures can overlap accepted or ignored counts. A connected socket with zero received events after a fresh message means the parser has not received an Events API envelope. Check the Slack app identity and its `message.im` subscription before changing the allowlist. Nonzero ignored counts indicate that the existing message/identity checks rejected an envelope.

For an uncertain creation, search company issues with `originKind=plugin:paperclipai.plugin-slack-control` and `originId=<eventKey>`. For an uncertain reply, inspect the bound issue's comments for `[Slack event <eventKey>]`. Do not blindly resend. After confirming no native mutation committed, an operator may send a new Slack command with a new event ID. There is no automated destructive repair or replay endpoint.

Inbox messages and binding records stay in the Paperclip database. SDK/provider payloads and tokens are not forwarded to logs. The inbox is not automatically pruned: deleting idempotency records could permit old events to execute again. Deleting a company removes its plugin records through foreign keys. Add a reviewed retention strategy before high-volume use.

## Setup (operator actions; not performed by installing this package)

1. Build this package in the Paperclip workspace:

   ```sh
   pnpm --filter @paperclipai/plugin-slack-control typecheck
   pnpm --filter @paperclipai/plugin-slack-control test
   pnpm --filter @paperclipai/plugin-slack-control build
   ```

   Install it through Paperclip's plugin management using the local package directory. Enable its declared capabilities only after reviewing them. Keep its company configuration disabled until the remaining steps are complete. The workspace registers this package with the Docker dependency stage and the standard test runner. CI resolves its dependencies; do not commit a generated lockfile in a contribution PR.

2. In Slack's app management, create an internal app **from** `slack-app-manifest.json` in your intended workspace. The manifest enables Socket Mode, the Messages tab and only the `message.im` event. Bot scopes are `chat:write`, `im:history`, and `im:read`. Create an app-level token with `connections:write`, then install the app to obtain its bot token. These are separate tokens. No public webhook URL or inbound firewall port is required. See the official [Socket Mode SDK guide](https://docs.slack.dev/tools/node-slack-sdk/socket-mode/) and [app manifest reference](https://docs.slack.dev/reference/app-manifest/).

   `pnpm --filter @paperclipai/plugin-slack-control slack:setup-url` prints a ready-to-open app creation link containing this public manifest. It makes no network request and performs no installation. Slack still asks the operator to choose a workspace and review creation, following its [documented manifest sharing flow](https://api.slack.com/reference/manifests).

3. Store the app-level and bot tokens as **company secrets** in Paperclip's secrets UI. Select secret references for this plugin's `appToken` and `botToken`. Never put token strings in plugin configuration, a source-controlled file, a task, a screenshot or a shell command. Optional numeric `version` pins a secret version; omitting it uses the host's current version. Re-save the configuration after rotating a token to reconnect.

4. Copy `config.example.json` to a private location outside the repository. Replace the workspace ID (`T…`), Slack member ID (`U…` or `W…`), active writable Paperclip user ID and existing project/agent IDs. IDs must be explicitly checked in both systems. An instance admin saves company-scoped configuration through Paperclip's UI or its authenticated API:

   ```text
   POST /api/plugins/<installed-plugin-id>/config
   { "companyId": "<company-id>", "configJson": <the configuration object> }
   ```

   Configuration uses secret reference objects only. Saving `enabled: true` authorises the outbound Slack connection and responses to allowed direct messages. The worker checks the bot's authenticated workspace before starting. Never configure this worker for another company; create a separately reviewed deployment for another tenant.

5. Perform the synthetic smoke below before assigning real work. To stop new dispatch, save `enabled: false`. Keep the secret references and mappings for a reversible later restart, or remove them through normal Paperclip administration.

## Synthetic working smoke

After the operator has authorised Slack installation and enabled the configuration:

1. Select a project containing synthetic fixtures and an existing paused agent if a model invocation is undesirable. Set the alias to `demo`.
2. From the one allowed Slack user, DM the app `status`. Confirm its reply and the company-scoped status endpoint. No task or agent invocation should result.
3. Send `new demo: Synthetic Slack control smoke; do not change files or contact anyone`. Confirm exactly one task, its mapped human creator, expected project/agent and a reply on the original Slack thread. A paused agent must remain paused.
4. Reply `Synthetic follow-up; no action needed` within that thread. Confirm one comment by the mapped Paperclip user on that same task. Check normal native wake behaviour separately if the agent is active.
5. Send a message as an unlisted user or in a channel/group DM. Confirm no plugin task, comment or reply. Disable configuration and confirm connection state becomes `disabled`.

The offline suite checks the manifest's required Socket Mode/IM fields against the documented shape, SDK capability and human-attribution contracts, official transport calls with mocked Slack responses, a real local PostgreSQL-compatible database migration, company separation, competing claims, retry and crash fences, persistent close/reopen, thread identity and configuration lifecycle. Recovery tests cover transient and permanent failures, backoff, handshake deadlines, stale events and confirmed shutdown before replacement. Loopback tests use the actual Slack SDK and undici to cancel a pending connection request and close an upgraded WebSocket whose peer ignores close frames. A synthetic child worker also exercises the actual host invocation guard: late configuration callbacks remain rejected, while the setup-created drain uses authorised proactive scope and stops when that scope is revoked. Slack's server-side manifest validation, real app installation, real Slack delivery and a real agent invocation require the operator's credentials and are **not performed by these tests**. PGlite runs only in tests; production storage is the host's namespaced PostgreSQL service.
