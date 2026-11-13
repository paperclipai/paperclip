# 1Password

Connect from **Connectors → 1Password**, choose who can use the connection, and
fill **Paste your 1Password Service Account token**. Setup links directly to
[Create a service account](https://www.1password.dev/service-accounts/get-started#create-a-service-account).
No desktop sign-in, CLI installation, Connect server, or OAuth application is
required. Change agent access and action policies on **Permissions** after setup.

## Provider contract

Reviewed on 2026-10-22 against the official
[service-account guide](https://www.1password.dev/service-accounts/get-started),
[SDK documentation](https://www.1password.dev/sdks), and
[item-management guide](https://www.1password.dev/sdks/manage-items).
The implementation pins the official `@1password/sdk` to **0.5.0**. 1Password's
documentation MCP server searches documentation; it is not an authenticated vault
integration. This connector uses a provider-owned SDK bridge through the existing
`rest_api` connection path, rather than advertising an unsupported remote MCP URL.

Create a service account with access only to the vaults the selected agents need.
Grant **Read Items** and **Write Items** for reading and managing items. An existing
read-only token can connect; provider permissions still deny its writes. Vault
access and permissions are immutable: create a replacement service account and
reconnect in Paperclip to change them. Built-in Personal, Private, Employee, and
default Shared vaults cannot be selected. Creating a service account requires a
1Password subscription and the appropriate account permissions.

The method is `1password/service-account`. Its configured URL
`https://my.1password.com/` is a routing identity, not a public REST or MCP endpoint.
The SDK uses the account address in the token and handles regional API access.
Paperclip accepts only HTTPS account addresses under `1password.com`,
`1password.ca`, or `1password.eu`, without custom ports, paths, or URL credentials.
There are no OAuth metadata, registration, callback, refresh, or revocation
endpoints in this method. Reconnect replaces the token through the normal vault
credential writer; provider revocation is managed in 1Password.

## Actions and governance

| Action | Risk | Result |
| --- | --- | --- |
| `onepassword_list_vaults` | Read | Vaults authorized by the service account |
| `onepassword_list_items` | Read | Item summaries in one vault |
| `onepassword_get_item` | Read | An item including its secret fields |
| `onepassword_resolve_secret` | Read | The value of one `op://vault/item/field` reference |
| `onepassword_create_item` | Write | A new Login, Password, API Credentials, or Secure Note item |
| `onepassword_update_item` | Write | An item with specified properties updated |
| `onepassword_archive_item` | Destructive | An archived item |
| `onepassword_delete_item` | Destructive | A deleted item |

Updates preserve the SDK's item version and omitted properties. Supplied `fields`
and `tags` arrays replace their previous arrays. Supported editable field types
are Text, Concealed, Totp, Url, and Email. Vault and item operations require IDs;
secret references support the provider's ordinary `op://` format. Vault
administration, sharing, document/file exports, and arbitrary commands are not
exposed. 1Password enforces the service account's vault boundary on every call.

All actions use existing company, agent, responsible-user, connection-grant,
profile, Allowed / Ask first / Off, quarantine, and audit checks. Setup uses the
existing default of all discovered actions Allowed for the chosen agents. The
credential field explicitly describes required vault permissions. Select trusted
agents: item reads and secret-reference resolution intentionally return secret
values to the agent and ordinary tool-result history. The service-account token
itself is always redacted, including if it is stored in an item being read.

Personal setup creates user-owned secrets and declarations; shared setup creates
company-owned secrets. Credentials never enter connection configuration or agent
environment variables. The worker receives only the selected invocation token
and validated arguments. It has no inherited environment or desktop identity.

Each invocation starts a disposable worker to isolate SDK initialization and
cryptography from the API event loop. There is no background polling or retained
SDK client. The worker is terminated on completion or deadline (15 seconds for
discovery, at most 30 seconds for calls). Termination stops local work; an already
accepted provider mutation can finish remotely. Writes are never retried
automatically. Provider errors use fixed actionable messages, and worker output
is bounded to 1 MiB; raw SDK errors and stdout/stderr never enter server logs.

## Verification

`server/src/services/connectors/onepassword/onepassword.test.ts` exercises strict
arguments, patch preservation, forged endpoint rejection, and actual worker
deadline termination with unrelated event-loop progress.
`server/src/services/connectors/onepassword/worker.test.ts` executes the worker
entry point with synthetic SDK results to verify nested token redaction and
oversized-result rejection before posting a result to the gateway.
`server/src/__tests__/onepassword-connection.test.ts` exercises encrypted
credential ownership, personal declarations, reads and writes through a running
agent's gateway session, classification, refresh, reconnect, action policy,
cross-company denial, and revocation of a retained session. The ordinary suite
uses provider fixtures. `PAPERCLIP_ONEPASSWORD_LIVE=1` plus an environment-supplied
`OP_SERVICE_ACCOUNT_TOKEN` enables the account-bound variant, which creates and
deletes only synthetic test items. Never put a token in a command argument.

Setup and management use the production components; the 1Password Storybook
stories provide catalog, token, rejection, inline task setup, narrow-screen, and
Permissions/Test simulations. These fixtures do not establish provider access.

Live qualification status is recorded in
[`tool-method-permission-reviews.json`](./tool-method-permission-reviews.json).

On 2026-10-22, the supplied account passed live connect, eight-action discovery,
vault listing through a running agent's gateway, catalog refresh, token
replacement/reconnect preserving the connection ID, another gateway read,
removal, and denial through the retained gateway session. Audit and connection
responses did not contain the credential. The account could list one vault but
1Password denied a minimal synthetic item creation for lack of permission; no
item was created.

On 2026-10-23, a replacement token with Write Items permission passed the live
governed lifecycle for both personal and shared credentials. All eight actions
ran through an actual run-scoped gateway: list vaults, create and list a
synthetic item, read it, update it and verify the update, resolve its secret
reference, archive it, and delete it. Catalog refresh, reconnect, another read,
connection removal, and retained-session denial also passed. Both synthetic
items were deleted, and their absence from item listings was verified. Audit,
responses, and the captured log did not contain the credential.

The first 2026-10-23 attempt stopped before any provider call because the host
had exhausted PostgreSQL semaphores. The passing run used a temporary test-only
PostgreSQL profile with ten connections and fewer workers; no shared service or
host limit was changed. The deterministic provider suite covers mutations and
the ordinary policy boundaries separately.

The browser walkthrough used a fresh local test instance, a personal credential,
and one explicitly selected disposable agent. It reached the normal Permissions
screen with all eight actions. Initial setup failures during development (a
canonical URL mismatch and a rewritten token label) were corrected before the
passing walkthrough. An inherited Node `--input-type` flag also broke the first
compiled-worker smoke; workers now start with an explicit empty Node argument
list, and packaging is verified separately from source execution.

## Branding provenance

Official source: 1Password's product site, retrieved 2026-10-22:

- Light theme: `https://1password.com/favicon/icon-v2.svg`
- Dark theme: `https://1password.com/favicon/icon-v2-light.svg`

The native icon shapes and colors are preserved. Each SVG adds only an explicit
matching `viewBox` so the official icon scales inside Paperclip's standard gray
frame. The browser-served manifest contains asset paths only.

## Shared changes

1Password owns its schemas, SDK mapping, account-address validation, errors,
worker lifecycle, and result sanitization under
`server/src/services/connectors/onepassword/`. The existing native-provider
catalog registry registers its probe, tools, classification, contract hashes,
and executor. Shared setup, health, discovery, and gateway code dispatch that
existing contract; existing providers retain their behavior. No schema or database migration is needed.
The shared credential-label formatter preserves explicit "Paste your" prompts
from the manifest, so setup shows **Paste your 1Password Service Account token**
without a provider-specific UI branch. Ordinary key labels keep their existing
presentation.
