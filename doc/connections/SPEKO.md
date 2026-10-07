# Speko

Updated: 2026-10-07. Status: catalog definition reviewed against official
documentation and live provider metadata; live account qualification through
Paperclip outstanding.

Speko (`speko.ai`) is a hosted voice-AI platform: voice agents that answer
inbound calls and place outbound calls, phone numbers, call transcripts and
recordings, knowledge bases, evals, and monitors. It appears in Apps and uses
Paperclip's shared remote-MCP connection, vault, catalog, grants, policies,
gateway, and audit trail. It is a resource connection, not Paperclip sign-in.
No plugin or database migration is required. The only provider-specific
runtime code is a reviewed risk-classification rule.

Paperclip connects to Speko's hosted MCP server at `https://mcp.speko.ai/mcp`
(Streamable HTTP) with one method: an organization API key stored as a
Paperclip secret and sent as an `Authorization: Bearer sk_live_...` header.

This curated connection is the polished route: it provides branding, key
guidance, and a warning about billable and real-world actions. None of it is
*required* to reach Speko's server. It can also be connected generically from
**Connect your own MCP server** with the same URL and header. See
[Connecting any remote MCP server](./GENERIC-REMOTE-MCP.md).

## Service involvement

Speko hosts the MCP resource. Paperclip stores the key as a secret reference,
discovers tools with `tools/list`, and sends the key on every governed call.
No Paperclip-operated vendor relay is involved; cloud and self-hosted
instances use the same path.

## Administrator setup

1. In the Speko dashboard, open **API keys** (`/agents/keys`) and create a key
   for Paperclip. Use a separate key so it can be revoked independently. Use a
   key from an organization that holds only the agents and phone numbers these
   agents may reach.
2. In Paperclip, open **Apps → Browse → Speko**, paste the key, and click
   **Connect**.
3. On the connection's **Permissions** screen, set the calling, deploy, and
   delete actions listed below to **Ask first** or **Off** if agents run
   unattended.

Revoke the key in Speko, then remove the connection in Paperclip, to
disconnect.

## Capabilities and policy

On 2026-10-07 the server listed 126 tools, named `<resource>.<action>` (for
example `agents.list`, `sessions.phone.create`, `phone_numbers.delete`). Every
tool carries `readOnlyHint` and `destructiveHint` annotations.

Actions that cost money or reach real people:

- Calls: `sessions.phone.create`, `sessions.create`, `agents.test_call`,
  `agents.evals.run`, `receptionist.verify_forwarding`.
- Live changes: `agents.deploy`, `agents.rollback`, `receptionist.go_live`,
  `receptionist.pause`, `receptionist.resume`, `phone_numbers.update`.
- Purchases: `phone_numbers.create` buys a phone number.
- Deletes: `agents.delete`, `phone_numbers.delete`, `knowledge_bases.delete`,
  `agents.monitors.delete`, `receptionist.cancel`, and the other tools Speko
  marks `destructiveHint: true`.

The generic classifier would read `agents.test_call`, `agents.deploy`,
`receptionist.go_live`, and `agents.evals.run` as reads, because none uses a
generic write verb. Paperclip therefore applies a reviewed Speko rule in
`classifyRisk`, the same rule PostHog uses: a tool is a read only when Speko
marks it `readOnlyHint: true`. Tools Speko marks `destructiveHint: true` are
destructive. Everything else is a write. The API-key helper text tells
operators to put calling, deploy, and delete actions behind Ask first.

## Vendor

- Product: Speko, `https://speko.ai`.
- MCP documentation: `https://docs.speko.ai/quickstart/mcp`.
- Protected-resource metadata:
  `https://mcp.speko.ai/.well-known/oauth-protected-resource/mcp`.

## Transport and auth

- Transport: `mcp_remote`, Streamable HTTP.
- Auth: `api_key`, `Authorization: Bearer <key>`. Keys use the `sk_live_`
  prefix.
- Key permissions: a key reaches its whole Speko organization. Paperclip
  cannot narrow an issued key.
- OAuth: Speko also offers browser sign-in. Its authorization server
  (`https://platform.speko.ai/api/auth`) publishes metadata with dynamic
  client registration and the scopes `speko:read`, `speko:write`,
  `speko:execute`, `speko:billing`, `speko:credentials`, `speko:compliance`,
  and `speko:phone`. This definition does not add an OAuth method yet. That
  method needs its own scope review and a live consent proof.

## Resource filters

The definition declares `organization`, `agent`, and `phone_number` as
`requiredResourceFilters`. Like every other catalog entry, Paperclip does not
yet collect or apply these filters at runtime (tracked in #11428). Until it
does, the enforceable boundary is the key: a key reaches one Speko
organization. The setup guidance says so.

## Manifest

| Field | Value |
| --- | --- |
| Slug | `speko` |
| Category | `communication` |
| Method | `mcp-api-key` (`customer` ownership, risk tier S4) |
| Server URL | `https://mcp.speko.ai/mcp` |
| Credential | `authorization`, password, required, placeholder `sk_live_...` |
| Key placement | header `Authorization`, prefix `Bearer ` |
| Console links | keys `https://platform.speko.ai/agents/keys`, docs `https://docs.speko.ai/quickstart/mcp` |

The definition is generated from the `speko` row in
`packages/shared/src/self-serve-mcp-research.json` and the `speko` branch of
`specialMethodsFor` in `scripts/ingest-app-definitions.mjs`.

## Wizard path

`/apps/connect?source=speko` opens a single-method form: the API key field and
**Connect**, which stays disabled until a key is entered. A successful key
check and tool discovery lead to the connection's Permissions screen.

## Governance defaults

- Default profile and bindings: the standard connection profile; every
  discovered action starts Allowed under the current product default.
- Policies: operators narrow calling, deploy, and delete tools to Ask first
  or Off on the Permissions screen.
- Risk: the reviewed Speko rule in `classifyRisk` described above.
- Quarantine rules: the shared defaults; no Speko-specific exceptions.

## Brand provenance

Speko's site publishes its mark as an SVG icon. The file is used unchanged in
both themes; its filled tile keeps contrast in dark mode.

| File | Source | SHA-256 |
| --- | --- | --- |
| `ui/public/brands/apps/speko.svg` | `https://speko.ai/icon.svg`, linked from [speko.ai](https://speko.ai/) (retrieved 2026-10-07) | `0f65c3bef9631d45f9a25c98302b327e387d4d09ecbd7cfdbb7f5af7f713eba3` |

## Validation hook

- Environment: definition review on 2026-10-07 against `origin/master`.
- Metadata probe: an unauthenticated `POST /mcp` returned HTTP 401; the
  protected-resource document returned HTTP 200.
- Provider probe: with a Speko organization key, `initialize` and
  `tools/list` succeeded directly against the server and returned 126
  annotated tools. This was a direct probe, not a Paperclip connection.
- Deterministic tests: manifest shape, store visibility, artwork, URL
  recognition, bearer-header projection with the key kept out of connection
  config, risk classification of read, write and destructive fixture tools,
  and the connect form's API-key gating.
- Connect evidence, catalog evidence, allowed read, governed write, denied
  case, revoke, audit through Paperclip: not run.
