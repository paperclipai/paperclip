# Nylas Finance Mailbox

First-party Paperclip connector that gives company agents read-only access to one Nylas mailbox. The default mailbox boundary is the `finance@` grant supplied for this deployment.

Every request uses the grant stored in company plugin configuration. Tool schemas do not accept a grant ID, so an agent cannot redirect a request to another mailbox. The Nylas API key comes from the server-side `PAPERCLIP_NYLAS` environment variable by default. A company-specific Paperclip secret reference can override that environment value and is resolved only while a tool call is running.

## Tools

- `nylas_search_messages` — search finance-mailbox messages with bounded filters and pagination
- `nylas_get_message` — read one message, including body and attachment metadata
- `nylas_read_thread` — read thread metadata plus its messages
- `nylas_list_attachments` — list attachments on a message
- `nylas_download_attachment` — return a size-capped attachment as base64

The plugin intentionally exposes no send, reply, update, move, or delete operation.

## Configure

Install the built plugin from the Paperclip Plugins page or from the repository root:

```bash
pnpm --filter @paperclipai/plugin-nylas-mailbox build
pnpm paperclipai plugin install ./packages/plugins/plugin-nylas-mailbox
```

Then open the plugin settings for the active company and set:

- **Nylas API key** — optional when `PAPERCLIP_NYLAS` is present in the Paperclip server environment; select a Paperclip company secret here to override the environment value for this company.
- **Finance mailbox grant ID** — defaults to `29eb5cbe-1129-42b9-93c9-53061483bb8c`.
- **Nylas API region** — `us` by default; choose `eu` only when the Nylas application is hosted in the EU region.
- **Maximum attachment download size** — defaults to 1 MB and is capped at 5 MB. Downloaded bytes are returned to the invoking agent as base64.

The Nylas grant needs provider read scopes. Current Nylas documentation specifies at least `gmail.readonly` for Google or `Mail.Read` for Microsoft for message and attachment reads.

## Development

```bash
pnpm --filter @paperclipai/plugin-nylas-mailbox typecheck
pnpm --filter @paperclipai/plugin-nylas-mailbox test
pnpm --filter @paperclipai/plugin-nylas-mailbox build
```

This is a trusted first-party plugin. It requests only outbound HTTP, optional company secret-reference resolution, and agent-tool registration capabilities. Environment and secret values are never returned in tool results or logs.
