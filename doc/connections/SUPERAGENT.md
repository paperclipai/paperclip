# Superagent

Updated: 2026-10-06. Status: catalog definition reviewed against official
documentation and live provider metadata; live account qualification
outstanding.

Superagent (`superagent.sh`) is a security platform: PR security scans,
dependency updates, red-team reports, context guardrails that score content
before agents consume it, and runtime guardrails for coding agents. It appears
in Apps and uses Paperclip's shared remote-MCP connection, vault, catalog,
grants, policies, gateway, and audit trail. It is a resource connection, not
Paperclip sign-in. No plugin or database migration is required. The only
provider-specific runtime code is a reviewed risk-classification rule.

Paperclip connects to Superagent's hosted MCP server at
`https://www.superagent.sh/mcp` (Streamable HTTP) with one method: an
organization API key stored as a Paperclip secret and sent as an
`Authorization: Bearer sk_live_...` header.

The `www` host is pinned deliberately. The bare `superagent.sh` domain
redirects to `www`, and Superagent documents that some MCP clients fail on
that redirect for POST requests.

This curated connection is the polished route: it provides branding, key
guidance, and a billable/destructive-tool warning. None of it is *required* to
reach Superagent's server. It can also be connected generically from
**Connect your own MCP server** with the same URL and header. See
[Connecting any remote MCP server](./GENERIC-REMOTE-MCP.md).

## Service involvement

Superagent hosts the MCP resource. Paperclip stores the key as a secret
reference, discovers tools with `tools/list`, and sends the key on every
governed call. No Paperclip-operated vendor relay is involved; cloud and
self-hosted instances use the same path.

## Administrator setup

1. In Superagent, open **Settings → API keys** (`/app/settings#api-keys`) and
   create a key for Paperclip. Use a separate key so it can be revoked
   independently.
2. In Paperclip, open **Apps → Browse → Superagent**, paste the key, and click
   **Connect**.
3. On the connection's **Permissions** screen, set the billable and
   destructive actions listed below to **Ask first** or **Off** if agents run
   unattended.

Revoke the key in Superagent, then remove the connection in Paperclip, to
disconnect.

## Capabilities and policy

The server exposes roughly 70 tools that mirror the Superagent REST API:
findings and triage, red-team reports, Contributor Trust scans, dependency
update runs, context-guardrail scoring (web pages, email, messages, files,
skills, MCP repositories, packages), Applications, Agents and endpoint
clients, runtime guardrail groups, rules and alerts, OpenTelemetry
destinations, and the structured agent report return path.

Superagent's documentation calls out these tools:

- Billable: `create_repository_report`, `create_web_app_report`,
  `create_agent_report`, `create_package_report`, `triage_finding`.
- Permanent deletes: `delete_finding`, `delete_telemetry_endpoint`. The
  `delete_agent_group` and `delete_agent_rule` tools also delete.
- Immediate endpoint-policy changes: `set_agent_builtin_rule_mode`,
  `restore_agent_builtin_rule`.

Paperclip applies a reviewed Superagent risk rule in `classifyRisk`, because
several mutations use names the generic classifier reads as reads
(`triage_finding`, `scan_*`, `restore_agent_builtin_rule`). Only `list_*` and
`get_*` tools, and tools Superagent marks `readOnlyHint: true`, are reads.
`delete_*` and `revoke_agent_client` are destructive. Everything else is a
write. The API-key helper text tells operators to put billable and
destructive tools behind Ask first.

## Vendor

- Product: Superagent, `https://www.superagent.sh`.
- MCP documentation: `https://www.superagent.sh/docs/mcp`.
- API keys: `https://www.superagent.sh/docs/reference/settings`.
- Rate limits: per key per minute; HTTP 429 with `Retry-After`.

## Transport and auth

- Transport: `mcp_remote`, Streamable HTTP.
- Auth: `api_key`, `Authorization: Bearer <key>`. Keys use the `sk_live_`
  prefix.
- Key permissions: not scoped. A key reaches everything in its organization.
  Paperclip cannot narrow an issued key.
- OAuth: not offered. The server returns
  `WWW-Authenticate: Bearer ... resource_metadata="https://www.superagent.sh/.well-known/oauth-protected-resource"`,
  and that document names `https://superagent.sh` as its authorization
  server, but neither `/.well-known/oauth-authorization-server` nor
  `/.well-known/openid-configuration` exists there, so browser sign-in
  cannot be discovered. Add an OAuth method if Superagent publishes
  authorization-server metadata.

## Resource filters

None. Superagent documents no query or header options that narrow the hosted
server. Narrowing is done with per-action policies.

## Manifest

| Field | Value |
| --- | --- |
| Slug | `superagent` |
| Category | `developer` |
| Method | `mcp-api-key` (`customer` ownership, risk tier S4) |
| Server URL | `https://www.superagent.sh/mcp` |
| Credential | `authorization`, password, required, placeholder `sk_live_...` |
| Key placement | header `Authorization`, prefix `Bearer ` |
| Console links | keys `https://www.superagent.sh/app/settings#api-keys`, docs `https://www.superagent.sh/docs/mcp` |

The definition is generated from the `superagent` row in
`packages/shared/src/self-serve-mcp-research.json` and the `superagent` branch
of `specialMethodsFor` in `scripts/ingest-app-definitions.mjs`.

## Wizard path

`/apps/connect?source=superagent` opens a single-method form: the API key
field and **Connect**, which stays disabled until a key is entered. A
successful key check and tool discovery lead to the connection's
Permissions screen.

## Governance defaults

- Default profile and bindings: the standard connection profile; every
  discovered action starts Allowed under the current product default.
- Policies: operators narrow billable and destructive tools to Ask first or
  Off on the Permissions screen.
- Risk: the reviewed Superagent rule in `classifyRisk` described above.
- Quarantine rules: the shared defaults; no Superagent-specific exceptions.

## Brand provenance

Superagent's site publishes its pyramid mark only as 32×32 WebP favicons
(light and dark), below the catalog's 128px minimum. The same mark is the
avatar of Superagent's official GitHub organization (`superagent-ai`, whose
profile links `https://superagent.sh`), published as a 460×460 transparent
PNG. That file is used unchanged in both themes.

| File | Source | SHA-256 |
| --- | --- | --- |
| `ui/public/brands/apps/superagent.png` (460×460) | `https://avatars.githubusercontent.com/u/152537519?v=4&s=512` | `2c731c7a4cdaabe2ed341b141dc75608e23b362b9a6e5ee81d1c7a373154fbcf` |

## Validation hook

- Environment: definition review on 2026-10-06 against `origin/master`; no
  Superagent account was used.
- Metadata probe: an unauthenticated `initialize` on `/mcp` returned HTTP 401
  with the `resource_metadata` header above; the protected-resource document
  returned HTTP 200; no authorization-server metadata was found.
- Deterministic tests: manifest shape, store visibility, artwork, URL
  recognition, bearer-header projection with the key kept out of connection
  config, risk classification of read, write and destructive fixture tools,
  and the connect form's API-key gating.
- Connect evidence, catalog evidence, allowed read, governed write, denied
  case, revoke, audit: not run. The API-key method still needs the full live
  lifecycle with a Superagent organization before this connection is
  considered qualified.
