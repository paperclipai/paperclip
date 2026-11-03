# Paperclip Notebook

Paperclip Notebook uses the existing remote HTTP MCP connection, authorization-code
OAuth with PKCE, Dynamic Client Registration, and instance credential vault.
Hosted and self-hosted Paperclip use the same connection protocol; Cloud broker
enrollment is unnecessary. Cloud authenticates the person, while Notebook owns
pages, reader policies, deployments, and its resource-specific OAuth grants.

## Connection and rollout

The curated connection uses `https://notebook.paperclip.app/mcp`. It is hidden
behind the default-off `enablePaperclipNotebook` flag, with no Settings toggle,
including developer mode. Operators can enable it through managed configuration
(`features.enablePaperclipNotebook: true`); self-hosted operators can use the
existing instance experimental-settings API. Cloud tenants cannot self-enable
this hidden flag, including through staging tenant opt-ins.

Catalog metadata and the saved application identity govern availability. While
disabled, setup, discovery, reconnect, OAuth completion, and curated Notebook
calls are denied. Local removal and grant revocation remain available. This
rollout gate does not blacklist independent generic remote MCP endpoints.

The personal connection requests `notebook:read`, `notebook:write`,
`notebook:share`, and `notebook:delete`. Sharing includes publishing a page
publicly in Explore. Notebook enforces ownership and reader policy; Paperclip
continues to enforce current agent assignment and Allowed / Ask first / Off
controls. Connection labels use the normal catalog name. Reconnect preserves
assignments and action restrictions.

## Publishing local files

A remote MCP server cannot read an agent-local filesystem path. Ordinary MCP
clients can use `notebook_publish` for inline UTF-8 or base64 content up to 1 MiB
decoded. Clients that upload directly can continue to use the existing scoped
S3-ticket protocol; upload URLs are temporary authority and must not be logged.

For a local file or built directory, Notebook provides a standalone Node.js
script. It is owned and served by Notebook; Paperclip adds no publishing CLI
command, native runtime tool, private transfer channel, or credential flow.
The script requires a Notebook release advertising `uploadLimits` through
`notebook_get_account` and supporting `notebook_begin_upload` with
`transport: "mcp"` plus `notebook_upload_chunk`. The script and these tools must
be deployed together; this source addition does not establish that deployment.

Run it only in an approved agent shell that already has `PAPERCLIP_API_URL`,
`PAPERCLIP_API_KEY`, and `PAPERCLIP_RUN_ID`. These are the existing Paperclip run
credentials, not Notebook credentials. It creates no login or API key. Download
and inspect the trusted script before running it:

```sh
curl --fail --silent --show-error --proto '=https' \
  https://notebook.paperclip.app/client/publish.mjs \
  -o /tmp/paperclip-notebook-publish.mjs
node /tmp/paperclip-notebook-publish.mjs ./dist \
  --connection CONNECTION_ID --title "Weekly report" \
  --idempotency-key weekly-report-build
```

Build client applications before publishing. Use `--entry-file` and `--spa`
when needed. Updates require `--page-id` and `--expected-version`. The script
reads only the selected local source under the shell's existing filesystem
authority. It rejects symbolic links, nonregular files, noncanonical paths, and advertised
size/file limits before publication mutations, then verifies declared content
again before sending chunks.
Agents without those shell credentials or filesystem access use the ordinary
MCP tools available to their runtime; the script grants neither authority.

The script opens an ordinary run-bound tool gateway session and sends every
operation through `/api/tool-gateway/tools/call` on the selected connection.
Notebook OAuth credentials remain in Paperclip's vault. File bytes travel as
bounded base64 tool arguments under normal gateway handling, not through signed
upload URLs or a private data channel. Notebook verifies chunk identity,
checksums, ownership, scopes, and the original upload window before publication.

If an action requires approval, stop and wait for the normal task approval.
Rerun with the same publication key and unchanged files after approval or a lost
response; Notebook reports the missing chunk indexes so completed chunks are
not repeated. Off actions, removed assignments, disabled connections, and the
rollout gate continue to prevent dispatch. Throttles are honored within a
bounded attempt. Uploads expire after 15 minutes; an expired upload requires a
new publication key. A validating operation is not a working link: use
`notebook_get_operation` until Notebook reports success and the effective audience.

## Verification and limits

The connection fixtures exercise personal OAuth, registration, PKCE/resource
binding, tool discovery, assignment, refresh, reconnect policy preservation,
and local removal. Uploader tests use real local files and controlled HTTP
services; final acceptance must additionally exercise the ordinary authenticated
Paperclip gateway against Notebook. These checks do not establish deployed
hosted/self-hosted browser acceptance or maximum-path AWS publication. Notebook
advertises accepted upload limits; clients do not infer its S3 key layout.

Removing a connection disables local use and clears saved credentials through
Paperclip's existing removal flow. It does not automatically revoke Notebook's
remote authorization; revoke that separately in Notebook's Connected apps.
Automatic upstream revocation, account-email labels, and custom rotating-refresh
response recovery remain deferred. A lost refresh response may require reconnecting.

Notebook artwork uses the repository's first-party Paperclip mark, with fixed
light and dark variants for the connector icon renderer.
