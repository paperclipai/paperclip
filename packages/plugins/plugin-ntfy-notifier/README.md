# ntfy Decision Notifier

A Paperclip plugin that sends a minimal [ntfy](https://ntfy.sh) push when a
decision is waiting for a person. It reacts to host events in real time. It
does not poll.

## What a push contains

Every push has the same fixed shape:

```
Title: Paperclip decision <ISSUE-KEY>
Tags:  paperclip
Click: <link into the Paperclip UI>

A decision is waiting: <ISSUE-KEY>
```

`<ISSUE-KEY>` is the canonical issue identifier, such as `ABC-12`. Nothing
else is sent: no issue titles, question or approval text, labels, agent names
or other details, in the body, the headers or the logs.

- **No readable issue key.** When the decision has no linked issue, or the
  plugin may not read the linked issue, the title is exactly
  `Paperclip decision`. The body is `A decision is waiting: approval` or
  `A decision is waiting: decision` when no issue is linked, and
  `A decision is waiting` when the linked issue is not readable.
- **Click link.** `<paperclipBaseUrl>/<PREFIX>/issues/<ISSUE-KEY>`. Without a
  readable key it uses the issue UUID, then the approval page. A board
  decision opens `<paperclipBaseUrl>/<PREFIX>/decisions?decisionId=<id>`.
- **Headers.** `Authorization: Bearer <token>` is added only when a token
  secret is configured, and `Priority` only when a priority is configured.

## Triggers and host support

The plugin notifies for approvals, interactions addressed to a person and
board blocker attention, and also for board decisions. It subscribes to each
event name once. Some trigger events are not yet in the host's plugin event
registry (`PLUGIN_EVENT_TYPES`), so a stock host never delivers them. The
plugin subscribes to them anyway: the subscription is harmless, and the
trigger starts to work when the host emits the event.

| Category | Host event | Notifies when | Stock upstream host today |
|---|---|---|---|
| Approvals | `approval.created` | A new approval is created. A tool-gateway approval and its approval card count as one decision. | **Works** for approvals created through the approvals API, agent hires and invitations. Tool-gateway and budget approvals do not log `approval.created` today, so they do not notify. |
| Interactions addressed to a person | `issue.thread_interaction_created` | A pending interaction card with no agent addressee, which is what the board inbox shows. | **Not delivered yet.** The host logs the activity with the fields the plugin needs, but the name is not in `PLUGIN_EVENT_TYPES`. Forward-compatible with #4990, which registers it. |
| Board blocker attention: human-owned unblock step | `issue.updated` | The issue moves into `blocked`, or its unblock descriptor changes, and its current `unblockDescriptor.owner` is `"board"` or a user. | **Works.** The plugin reads the issue to confirm the owner. |
| Board blocker attention: computed (stalled blocker tree) | `issue.blocker_attention_changed` | A blocked tree whose terminal blocker has no live path enters the board attention feed. | **Not delivered.** No stock host emits this event yet. Forward-compatible only. |
| Board decisions | `decision.created` | An agent opens a board decision. | **Not delivered yet.** The host logs `decision.created`, but the name is not in `PLUGIN_EVENT_TYPES`. Forward-compatible only. |

The plugin also accepts a raw `activity.logged` event whose `action` is
`issue.thread_interaction_created`, in case a host forwards activity rows.
Stock hosts do not do this today.

### Who an interaction is for

- A card whose payload names an agent addressee never notifies. That is
  agent-to-agent traffic.
- A card whose payload has an explicit empty `addresseeAgentId` is for a
  person and notifies.
- A card whose payload has no `addresseeAgentId` key at all is **never**
  treated as addressed to a person. The plugin reads the card through
  `issue.interactions.read`. If it still cannot tell (for example a private
  issue), it sends nothing and logs `addressee_unknown`.
- Resolved cards never notify.

Other events, such as comments, status changes, resolutions and decided
approvals, are ignored. Agent-owned blockers are ignored.

## Configuration

Configuration is per company and is validated strictly: unknown keys are
rejected.

| Key | Required | Description |
|---|---|---|
| `ntfyBaseUrl` | yes | ntfy server base URL, `https://...`. No credentials, query or fragment. |
| `topic` | yes | ntfy topic: 1-64 letters, digits, `_` or `-`. |
| `tokenSecretRef` | no | `{ "type": "secret_ref", "secretId": "<uuid>" }` for a Paperclip secret holding an ntfy access token with publish permission. The token is resolved for each send and never stored or logged. Omit it for an open topic. |
| `paperclipBaseUrl` | yes | Paperclip UI URL, used only to build the click link. |
| `priority` | no | ntfy priority, an integer from 1 to 5. |
| `triggers` | no | `{ "approvals": true, "interactions": true, "blockerAttention": true, "decisions": true }`. Each flag defaults to `true`. `blockerAttention` covers both blocker rows above. |
| `allowInsecureHttp` | no | Allows `http://` URLs, for local testing only. Default `false`. It is rejected together with `tokenSecretRef`, so a token is never sent over plain http. |

Example:

```json
{
  "ntfyBaseUrl": "https://ntfy.example.com",
  "topic": "paperclip-decisions",
  "tokenSecretRef": { "type": "secret_ref", "secretId": "00000000-0000-0000-0000-000000000000" },
  "paperclipBaseUrl": "https://paperclip.example.com",
  "priority": 4
}
```

## Delivery and dedupe

- **Outbound.** Requests go through the host-mediated `ctx.http.fetch`
  (capability `http.outbound`), so the host's outbound guard applies.
  Redirects are not followed.
- **Bounded retries.** Each attempt has a 10 s timeout, and there are at most
  3 attempts with a short back-off. Network errors, 408, 429 and 5xx are
  retried. Other 4xx responses are final.
- **No retry after a timeout.** A timed-out request may still reach ntfy,
  because a host-proxied fetch can keep running after the plugin's timer
  fires. A retry could then publish the same push twice, so a timeout ends
  the send after one attempt.
- **Durable dedupe.** Dedupe is keyed on the decision identity, not on time,
  and is stored in company-scoped plugin state. The keys are
  `approval:<id>`, `interaction:<id>`, `tool-action:<id>`, `decision:<id>`
  and `blocker:<issueId>:<blockedTransitionAt>`. A computed blocker-attention
  item sends one push per feed episode. Duplicate deliveries and worker
  restarts do not send twice. Concurrent deliveries in one worker are
  collapsed.
- **At-least-once.** A decision is marked only after ntfy accepts the
  publish. A failed send is not marked, so a later delivery of the same event
  can still send it. Rare duplicates remain possible when the worker stops
  between a successful publish and the state write, when a timed-out request
  was in fact accepted and the event is delivered again later, or when a
  retry follows a network error or 5xx that ntfy had in fact accepted. A rare
  duplicate push is preferred over a lost decision.
- **Logs.** Log lines carry only coarse codes such as `kind`, `outcome`,
  `reason`, `status` and `attempts`. They never contain tokens, URLs,
  identifiers or event text.

## Capabilities

`events.subscribe`, `http.outbound`, `secrets.read-ref`, `plugin.state.read`,
`plugin.state.write`, `issues.read`, `issue.interactions.read`,
`companies.read`.

## Development

```sh
pnpm --filter @paperclipai/plugin-ntfy-notifier test
pnpm --filter @paperclipai/plugin-ntfy-notifier typecheck
pnpm --filter @paperclipai/plugin-ntfy-notifier build
```

### Self-contained install artifact

```sh
PLUGIN_SDK_VERSION=<host version> pnpm --filter @paperclipai/plugin-ntfy-notifier build:artifact
```

This bundles the worker and the manifest with the published plugin SDK of the
given version into `artifact/paperclip-plugin-ntfy-notifier-<version>.tgz`,
and writes its sha256. The artifact has no runtime dependencies, so it can be
unpacked and installed by local path without npm. The tarball is
deterministic: sorted entries, fixed mtime and owner, and gzip without a
timestamp.
