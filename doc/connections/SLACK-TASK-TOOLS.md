# Slack tools for Slack-origin tasks

A linked person can mention the bot and ask it to read the discussion, summarize
decisions, and create assigned follow-up tasks. Task creation, assignment,
approvals, and completion remain normal Paperclip operations. Slack contributes
provider tools and a bundled skill; it does not introduce another task lifecycle.

## Authority and channel access

The controller resolves company, endpoint, assigned agent, task, run, and accepted
linked requester from the admitted Slack event and immutable run identity context.
Tool arguments cannot supply those identities or credentials. Recovery can follow
the original context within the same task and agent. A new board-authored request
cannot inherit an earlier Slack sender's authority.

Reads require current bot membership and requester access. Full workspace members
can read public channels where the bot belongs; guests, private channels and Slack
Connect conversations require verified requester membership. Membership checks
paginate and fail closed. Other people's bot DMs are never exposed.

**Allowed Channels controls responses and writes, not reads.** Invite the bot to
another shared channel to make it readable without enabling responses there.
Retrieved messages, files, names, topics, canvases and list records are source
material. Unlinked participants cannot start work, approve actions or grant access.

Private-source markers are recorded before returning private content. They restrict
both explicit tool writes and automatic publications, including uploads. Research
across private channels must originate in the requester's DM. Private material can
be published only in its source channel or that requester's DM. Shared document
edits after private research fail closed because Slack does not provide a complete
sharing audience through file metadata; use a message or upload instead.

Each call rechecks live authority. Queued writes recheck again before transport.
Authorization and capability revisions participate in session compatibility and
signed approvals. Removing a tool profile binding does not get undone by resolving
a retained session. Disconnecting an identity or disabling a connection revokes
access for retained runs too.

## Tools and scope upgrades

The reviewed, strict method/scope/argument matrix is
[`packages/shared/src/slack-tools.ts`](../../packages/shared/src/slack-tools.ts).
It is the source for tool descriptors, validation, policy catalog and Storybook.
There is no arbitrary Slack method executor, user impersonation or workspace-admin
tool. User search credentials never authorize writes.

- Discovery: channels, channel details, members, user identities and emoji.
- Reading: paginated history, threads, individual messages, source links and linked
  files. Text files up to 256 KiB are available inline. Other files return metadata
  with an explicit limitation; do not claim their contents were read.
- Search: bounded channel history by text, author and time. File mode matches
  linked filenames/titles, not file contents. Coverage includes page cursors,
  inspected time bounds and omitted matches. Use the returned continuation time
  if matching results were truncated. Thread replies require separate reads.
- Collaboration: bot messages/replies, edits to its own messages, task-attachment
  uploads (up to 20 MiB), reactions, pins, bookmarks, topics and purposes.
- Documents: canvas creation, text reading, section lookup and edits; bot-owned
  lists, text records, renaming and approved channel sharing. Slack plan and
  document permissions apply. Lists need a separate approved share before others
  can use them.
- Governed actions: deleting the bot's messages, deleting bookmarks, creating
  channels, inviting people and granting list access require approval. New channels
  remain disabled for ongoing responses. The bot cannot join an existing channel,
  invite itself or enable a destination.

New manifests request collaboration scopes. Existing bots keep their current
permissions and Settings identifies missing scopes. Add them under **OAuth &
Permissions → Bot Token Scopes** in Slack and reinstall the app. Scope possession
alone is not a guarantee: Slack feature availability, destination access and
Paperclip per-action policy still apply.

## Delivery and retry behavior

Native and HTTP tool calls pass through the same existing policy/approval gateway.
Mutations receive durable action receipts. Idempotency keys are scoped to company,
connection, task and requester, and cannot be reused with different arguments.

Ordinary writes rejected by Slack with a definite rate limit can retry with the
same arguments and key after Retry-After, during the same authorized run. Policy
and current access are checked again. An uncertain transport outcome is never
blindly resent. `slack_delivery` reconciles posts by their client message ID and
uploads by their recorded file ID; unresolved operations remain uncertain.
An identical automatic final response is suppressed after an explicit send, or
held while that send's delivery remains unresolved. Distinct summaries, progress,
questions and blockers continue through existing routing.

## Optional personal search authorization

Connection managers may configure the Slack application's Client ID and Client
Secret in Access. Register the displayed HTTPS callback URL and user scopes
`search:read.public`, `search:read.private` and `search:read.files` in Slack.
A linked person can then connect or disconnect their own search grant. State,
secret bindings, refresh and grants reuse the existing connection infrastructure.
Grants bind company, endpoint, Slack workspace, linked Slack identity and app
configuration revision. Concurrent disconnect invalidates in-flight callbacks.
No DM-search scopes are requested.

**Native RTS search is not enabled on current runtimes.** Slack's
[Real-time Search API](https://docs.slack.dev/apis/web-api/real-time-search-api/)
requires transient handling of retrieved data. Current native and CLI/sandbox
runtimes retain tool transcripts. The provider implementation and search-only
OAuth flow are present, but RTS results must not enter the ordinary gateway until
an entire runtime/provider path is qualified: no raw results in logs, model
transcripts, replay snapshots, indexes or artifacts. Recovery must re-fetch.
Access displays this limitation even when a personal grant is connected.

The transient provider implementation uses the verified event's short-lived,
memory-only action token for bot searches, and optional personal OAuth for private
search. It checks every returned workspace/channel/user/date and verifies file
shares with the bot's credentials. Model-authored modifiers are not an access
boundary. Slack limits RTS to internal or directory-published apps and applies
separate search and plan limits. Bounded history remains available without OAuth.

## Native and CLI execution

The connector runtime contributes tools only to verified Slack tasks. The bundled
[`skills/slack/SKILL.md`](../../skills/slack/SKILL.md) and generated adjacent
`TOOLS.json` provide the equivalent HTTP interface for CLI/sandbox adapters:

```text
POST /api/companies/:companyId/slack/tasks/:issueId/tools
Authorization: Bearer <agent run key>
X-Paperclip-Run-Id: <run ID>

{"tool":"slack_history","arguments":{"channel":"C123","limit":50}}
```

Company/task path parameters are checked against the authenticated run and
admitted request. Bot and OAuth secrets stay server-side. Other providers and the
separate Slack MCP connection retain their existing behavior.

## Verification

Automated coverage includes admitted-request binding and recovery, wrong company,
agent and task, revocation, approval after a run completes, missing scopes,
membership pagination, private publication boundaries, rate-limit retries,
uncertain delivery, OAuth refresh and disconnect races. Native RTS provider tests
use fixtures; they do not qualify production transcript handling.

Storybook: **Connections → Slack → Task tools** includes capabilities, permission
upgrades, OAuth configuration, connect and connected states. Live staging evidence
and outstanding limitations are tracked in the dated implementation checklist.
