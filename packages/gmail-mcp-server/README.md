# Gmail MCP Server

First-party MCP server for Google's **GA (generally available)** Gmail REST
API (`gmail.googleapis.com`). Paperclip's built-in Gmail app targets Google's
Developer-Preview-only Gmail MCP server
(`@paperclipai/shared/app-definitions/gmail.json`,
`https://gmailmcp.googleapis.com/mcp/v1`); this package is an alternative for
operators who have not enrolled their Google Cloud project in that preview
program and want Gmail access through the stable, GA REST API instead.

It can run as a Paperclip `local_stdio` connection, the same mechanism as the
existing `paperclip.google-sheets` server.

## Configuration

The server authenticates with a user-consented OAuth refresh token — it never
performs the consent flow itself; an operator obtains the refresh token
through their own OAuth app and Google's standard consent screen before
configuring this server.

Required:

- `GMAIL_CLIENT_ID`: OAuth 2.0 client ID.
- `GMAIL_CLIENT_SECRET`: OAuth 2.0 client secret.
- `GMAIL_REFRESH_TOKEN`: a refresh token issued for that client with at least
  the `gmail.readonly` scope (`gmail.compose` is also required for
  `create_draft`; see "Scopes and what this server will never do" below).

Equivalent CLI flags are available for local stdio templates:

```sh
paperclip-gmail-mcp-server \
  --client-id "$GMAIL_CLIENT_ID" \
  --client-secret "$GMAIL_CLIENT_SECRET" \
  --refresh-token "$GMAIL_REFRESH_TOKEN"
```

## Scopes and what this server will never do

A refresh token issued with the `gmail.compose` scope is technically capable
of sending mail through Gmail's `users.messages.send` endpoint. This server
has **no tool, no client method, and no code path that calls `send`, `trash`,
`delete`, or any label-mutating endpoint** — not behind a flag, not
conditionally. The only mutation this server can perform is creating a draft
(`users.drafts.create`), which never leaves the Drafts folder on its own.

## Tools

- `get_profile` (read)
- `search_threads` (read) — Gmail search syntax; returns From/To/Subject/Date
  metadata and a snippet per thread, up to 50 per page.
- `get_thread` (read) — every message in a thread, including plain-text body.
- `get_message` (read) — one message's headers and plain-text body. HTML is
  stripped and used only when no `text/plain` part exists anywhere in the
  message. The body is capped at 20,000 characters; attachment filenames are
  listed separately (attachment *content* is never fetched).
- `list_labels` (read)
- `list_drafts` (read)
- `get_draft` (read)
- `create_draft` (write — draft only, never sent) — `to`/`cc`/`bcc`/`subject`/
  `body`, with an optional `reply_to_message_id` that threads the draft as a
  reply (`In-Reply-To`/`References` headers, and the draft's `threadId`).

## Paperclip `local_stdio` path

Register a `local_stdio` stdio template with `command:
"paperclip-gmail-mcp-server"` and `envKeys: ["GMAIL_CLIENT_ID",
"GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]`, mirroring
`paperclip.google-sheets`'s existing template. Point
`credentialSecretRefs` at vault secrets holding the client secret and
refresh token for the Gmail account the operator has already consented
through their own OAuth app; the client ID is not secret and can be a plain
template argument or env value.
