# Daytona connection

Daytona uses the normal Apps connection, selected personal/company credential,
agent installation, action policy, gateway, revocation and audit paths. The API
key stays in the instance vault. The connector does not borrow sandbox-provider
environment credentials or another connection's credential.

Sign-in tokens are never reused as resource tokens; id.paperclip.ing never
stores resource tokens; no connections hub on the ID service.

## Connect and test

Choose **Connectors → Daytona → Add key**, select access, and enter a Daytona
organization API key. Give that key the read, write, and delete permissions for
the resources you intend to manage. An optional organization ID under Advanced
pins the credential to its organization. Setup verifies `GET /api-keys/current`.
Use the saved connection's ordinary Permissions screen to choose agents and set
actions to Allowed, Ask first, or Off.

This is a provider-focused connector. Sandbox IDs and names come from Daytona;
no Paperclip task, run, or environment lease is required. Granting access to this
connection grants access to the provider resources its credential can reach.
Some user/account and administrator operations require extra provider authority
or user authentication and will reject an API key. Paperclip does not fall back
to another identity when Daytona denies access.

## Complete published HTTP action catalog

The catalog contains **274 actions** from Daytona's published specifications:
169 platform API operations and 105 Toolbox operations. It includes sandbox
creation, start/stop/recovery/deletion, snapshots, volumes, files and transfers,
Git, commands and sessions, computer use, organization/account administration,
and provider telemetry queries. These provider telemetry tools do not emit
Paperclip first-party telemetry.

Actions have provider names such as `daytona_api_list_sandboxes`,
`daytona_api_create_sandbox`, `daytona_toolbox_execute_command`, and
`daytona_toolbox_download_file`. The generated schemas retain the provider's
path/query/body arguments and required fields. Toolbox actions also take a
`sandboxId`. Returned provider objects are not reduced to Paperclip task data.
The selected connection credential is redacted from results and errors.

| Action group | Permission classification |
| --- | --- |
| Ordinary reads, file downloads, and read-only lookups | Read |
| Resource creation, file/Git changes, lifecycle and configuration changes | Write |
| Deletion (including TTL/auto-delete), command/code/interactive input, reset/restore, secret/credential access, signed access links and file/account access changes | Destructive |

The source inventory also records **two WebSocket upgrade endpoints**:
interactive interpreter execution and PTY connection. These are streaming
protocol connections, not ordinary HTTP/MCP request-response tools. They are
not advertised as nonfunctional actions. The command/code and session tools
provide the corresponding request-response execution paths.

The API and Toolbox specification sources and SHA-256 hashes are recorded in
`server/src/services/daytona/operations.generated.json`. Regenerate with:

```sh
node scripts/generate-daytona-tools.mjs
node --test scripts/generate-daytona-tools.test.mjs
```

The large generated JSON file is one provider contract snapshot. Its generator
and invocation implementation stay separate from it; no runtime network discovery
or unbounded schema copying occurs on the server's startup path.

## Credential and transport boundary

The platform API endpoint is fixed to `https://app.daytona.io/api`. Toolbox
calls resolve the sandbox through that API, verify its exact ID/name and
organization, and accept only reviewed Daytona cloud proxy hostnames and the
`/toolbox` path. Every request still uses the normal DNS-pinned egress guard.
Redirects are rejected. Action arguments cannot replace Authorization or the
organization header. Generic credential export rejects Daytona.

File uploads take base64 bytes; downloads return bytes with content type and
length. The connector never reads a local host file path, writes host files,
launches the Daytona CLI, or executes commands on the Paperclip server. Provider
commands execute inside the selected Daytona sandbox. Reads and transfers have
an 8 MiB bound. An action shares one deadline across identity, target lookup,
dispatch, and response reading: the caller's budget, capped at 30 seconds.
Expiry blocks later dispatches and cancels active requests. Mutations are never
retried automatically. A timed-out command or write can still be running at the
provider; inspect it before retrying.

Daytona does not provide a diagnostic-only runtime key: every valid organization
key can access running sandboxes through the Toolbox, even with no selected
resource scopes. Treat this as broad provider access. Agent assignment and action
permissions enforce the capability boundary; a read grant is not permission to
run a command or delete a sandbox.

## OAuth research

The native connection currently uses an API key. Daytona's CLI supports browser
sign-in, but its published configuration uses Daytona's own first-party AuthKit
clients. The public issuer metadata does not advertise client registration, and
a supported third-party OAuth app registration path was not verified. The
connector does not borrow those client IDs, copy CLI sign-in tokens, or invent a
native OAuth consent flow.

Composio advertises managed OAuth for its Daytona toolkit. That is a separate
existing provider route: connect Composio through its ordinary connection flow,
then configure its Daytona app. Its auth configuration and account entitlements
must be verified through that provider's live setup. This native connector does
not require Composio or forward its credential to Composio. A marketing listing
is not proof that this instance completed Daytona OAuth.

## Validation and limits

Database-backed tests exercise company and personal vault ownership, real
run-scoped gateway reads and writes, file bytes, action denial, revocation,
foreign-account rejection, untrusted proxy rejection, all generated argument
schemas, and bounded/sanitized errors. Generator tests account for HTTP operations
and protocol upgrades and preserve recursive input definitions.

These fixtures do not qualify a real Daytona account. Live provider proof is
pending an operator connecting a key and trying an allowed read and write. No
platform key or live provider credential is installed by this change. Existing
saved connections must review the expanded catalog through normal Permissions;
new actions do not inherit approval from the previous four diagnostic actions.
Opening a saved Daytona connection upgrades an outdated catalog. The earlier
Paperclip-specific actions are retired and hidden from both Permissions and
agent discovery, even if a provider outage prevents refresh. Historical rows
remain for audit, and newly discovered actions require review.
Agent discovery and dispatch also check same-name saved contracts against the
deployed schema and risk classification. An outdated action cannot execute
while it waits for a human to open Permissions and review the change.

The HTTP boundary tests use a real local server and the pinned transport to
check multipart uploads, audit filter encoding, response cancellation, and
unrelated request responsiveness. The provider network/TLS leg is simulated;
these checks do not replace live account proof.

Provider research verified 2026-10-15:

- https://www.daytona.io/docs/en/api-keys/
- https://www.daytona.io/docs/en/tools/api/
- https://www.daytona.io/docs/openapi.json
- https://www.daytona.io/docs/toolbox-openapi.json
- https://github.com/daytona/clients/tree/main/cli/mcp
- https://composio.dev/toolkits/daytona
- https://www.daytona.io/brand

Official square logo assets are copied unchanged from
`https://framerusercontent.com/images/k2z1jCEWqymEd7reVoRseEVMFHU.svg` and
`https://framerusercontent.com/images/JjrFl7J2k84ANwYg3pD9Hwilc.svg`.
