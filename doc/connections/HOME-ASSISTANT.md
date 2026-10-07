# Home Assistant connection

Home Assistant's official **Model Context Protocol Server** integration exposes
a home's Assist API to MCP clients. Agents can read exposed entity state,
the date and time, timers, to-do lists, calendars, and media search. With
approval, they can also control exposed devices and run exposed scripts.

This document follows the template in
[Connection Authoring Runbook](./CONNECTOR-PLAYBOOK.md) and records exactly what
was and was not verified.

**Status: catalog connector with deterministic tests only.** No live Home
Assistant instance or token has been connected yet. See
[Validation Hook](#validation-hook).

**Release path:** the **long-lived access token** method (`mcp-access-token`)
targets `https://{haHost}:{haPort}/api/mcp/assist` on the customer's own Home
Assistant. Home Assistant's IndieAuth OAuth flow is out of scope for this
change (see [Why no OAuth method yet](#why-no-oauth-method-yet)).

Authored against Paperclip App `06484b3c4153b6201f1a07304694793b1fdf36dd`, with
`CONNECTOR-PLAYBOOK.md` blob `6c5f7913b2fd08bdacc69ea87720e1124610894f` as the
authority. Provider docs and Home Assistant core (`dev`, plus tags `2026.6.0`,
`2026.8.0`, and `2026.10.0`) were read on 2026-10-07.

## Vendor

- App key: `home-assistant`
- App name: Home Assistant
- Owner: unassigned
- Reuse classification: **MCP-direct**
- Reason for classification: Home Assistant ships an official MCP server
  (`mcp_server` integration) over Streamable HTTP. No REST shim or wrapper is
  needed. The server is self-hosted, so the endpoint is per-customer and comes
  from a URL template.
- Security tier: **S3**. Tools can actuate physical devices (lights, switches,
  covers, locks, climate, media) and run arbitrary exposed scripts.

### Why a catalog entry at all

Operators could already paste the URL into "Connect your own MCP server". The
catalog entry adds Home Assistant-specific governance that the generic path
cannot give: a reviewed read allowlist, Ask-first defaults for every other
tool, quarantine for tools that appear later (newly exposed scripts), and
setup guidance about unscoped tokens.

## Transport And Auth

- Transport: `mcp_remote`, Streamable HTTP, stateless.
- Endpoint: `https://{haHost}:{haPort}/api/mcp/assist`. `haPort` is an
  advanced field that defaults to `443`.
  - `/api/mcp/{api_id}` was added in Home Assistant **2026.8**. For the Assist
    API it admits non-admin users without turning off the integration's
    "Require an administrator account" option, and it serves only Assist
    rather than every LLM API the integration exposes.
  - Older releases only serve `/api/mcp`. They need the generic custom MCP
    route, which has none of this connector's governance defaults.
- Auth: `api_key`. A Home Assistant **long-lived access token** sent as
  `Authorization: Bearer <token>` (`keyPlacement` header).
- HTTPS only. Curated URL templates must be `https://`, and the server rejects
  resolved non-HTTPS URLs. Plain-HTTP LAN access (`http://homeassistant.local:8123`)
  is not supported here. Use Home Assistant Cloud remote access
  (`<id>.ui.nabu.casa`) or a TLS reverse proxy.
- Host validation: `haHost` must be a bare DNS name. Schemes, paths, ports,
  and userinfo are rejected so they cannot be smuggled into the URL template.
- Private network reachability follows the generic remote-endpoint guard.
  Private addresses are allowed only when the deployment is not
  authenticated and public.
- Paperclip ID / Paperclip Connect involvement: **none.** The credential is a
  customer-pasted token stored as a company secret ref, and the endpoint is
  the customer's own Home Assistant.

### Connection Flow (mandatory)

```mermaid
sequenceDiagram
    participant O as Operator
    participant H as Home Assistant UI
    participant P as Paperclip instance
    participant M as Home Assistant /api/mcp/assist
    O->>H: Add MCP Server integration (Assist API)
    O->>H: Create dedicated non-admin user and expose entities
    O->>H: As that user, Profile → Security → create long-lived token
    O->>P: Connect Home Assistant, method mcp-access-token, host + token
    P->>P: Validate host, resolve https URL, store token as secret ref
    P->>M: POST initialize + tools/list, Authorization Bearer token
    M-->>P: Assist tools (reads, intents, exposed scripts)
    P->>P: classifyRisk (reviewed reads only), Ask first for writes
    P->>O: Finish setup; later-discovered tools quarantined
```

### Why no OAuth method yet

Home Assistant uses IndieAuth. The `client_id` is the client's own base URL,
the redirect URI must share its scheme and host, and there is no client
secret. Home Assistant advertises `client_id_metadata_document_supported` but
no RFC 7591 registration endpoint. A Paperclip OAuth method would need a
reachable HTTPS Paperclip origin as `client_id`, and Home Assistant's external
URL must match the host used. It would also need live validation of
refresh-token behavior. The token path meets the connector requirement today.
An OAuth method can follow as a separate change with live proof.

### Credential residual risk

Long-lived access tokens are **not scoped**. A token can do anything its Home
Assistant user can do, including on Home Assistant's REST and WebSocket APIs,
not just MCP. They last 10 years unless revoked. The connector therefore:

- requires a **dedicated non-admin** Home Assistant user (setup steps, warnings,
  and the credential helper text);
- relies on **Assist entity exposure** to bound what MCP tools can reach;
- stores the token only as a company secret ref, never in connection config,
  and the tests assert it is not echoed;
- leaves revocation to Home Assistant (Profile → Security → delete token) or to
  disconnecting in Paperclip.

## Administrator Setup (mandatory)

1. Run Home Assistant 2026.8 or newer, reachable over HTTPS.
2. Settings → Devices & services → Add integration → **Model Context Protocol
   Server**. Select the Assist API ("Control Home Assistant").
3. Create a dedicated **non-admin** user for Paperclip. Never use an owner or
   administrator account.
4. Settings → Voice assistants → **Expose**: expose only the entities agents
   should read or control. Exposed scripts become MCP tools.
5. Sign in as the dedicated user. Under Profile → Security, create a long-lived
   access token. Paste it into Paperclip once and do not keep other copies.

## Resource Filters

None. The resource boundary is Home Assistant's Assist entity exposure plus the
dedicated user's permissions. Paperclip cannot narrow it further.

## Manifest

Authored in `scripts/ingest-app-definitions.mjs` and generated to
`packages/shared/src/app-definitions/home-assistant.json`:

- One method: `mcp-access-token`, `mcp_remote`, `api_key`, `ownershipModes:
  ["customer"]`, `grantKinds: ["organization"]`, risk tier S3.
- Tenant fields: `haHost` (required, bare host) and `haPort` (advanced, default
  `443`).
- Credential field `authorization`, placed as `Authorization: Bearer`.
- `setupPrerequisite` with the steps above, and warnings about unscoped
  tokens, the absence of a read-only mode, Ask-first defaults, and HTTPS only.
- Branding: the official Home Assistant logomark from
  `home-assistant/assets` (`logo/home-assistant-logo.zip`,
  `home-assistant-logomark-color-on-light.svg`). It is paths only, with no
  scripts or references. The logo is an Open Home Foundation trademark and is
  used only to identify the integration.
- URL pattern `https://*.ui.nabu.casa/api/mcp*` recognizes pasted Home
  Assistant Cloud MCP URLs.

## Actions

Home Assistant has **no read-only Assist mode**. One endpoint serves reads and
device control. Risk is assigned per tool by `classifyRisk` with
`sourceTemplateKey === "home-assistant"`:

| Tool (bare / namespaced) | Risk | Default |
| --- | --- | --- |
| `GetLiveContext` / `homeassistant__GetLiveContext` | read | Allowed |
| `GetDateTime` / `llm__GetDateTime` | read | Allowed |
| `HassTimerStatus` / `intent__HassTimerStatus` | read | Allowed |
| `todo_get_items` / `todo__get_items` | read | Allowed |
| `calendar_get_events` / `calendar__get_events` | read | Allowed |
| `search_media` / `media_player__search_media` | read | Allowed |
| Every other tool (`HassTurnOn`, `HassLightSet`, timers, lists, `HassBroadcast`, `script__*`, …) | destructive when `destructiveHint`, else write | Ask first |

- Names are matched **exactly**. Exposed scripts are named `script__<id>`, so a
  script called `get_live_context` stays destructive or write.
- The reviewed-read check runs before the generic `destructiveHint` check.
  Home Assistant defaults `destructiveHint` to true, even on `GetLiveContext`
  and `GetDateTime`. A reviewed read that reports `readOnlyHint: false` is
  downgraded to write.
- Unreviewed tools never become reads, even with `readOnlyHint: true`. Without
  this rule, the generic classifier would read `HassTurnOn` as a read.
- `GetLiveContext` returns the state of every exposed entity, which can
  include presence and security sensors. Limit exposure accordingly.

## Wizard Path

Apps → Home Assistant → **Use a long-lived access token** → setup
prerequisites → host (and advanced port) + token → catalog review → finish.
Reads start Allowed and all other tools start Ask first.

## Governance Defaults

- `recommendedDefaultsForApp`: `access: "all_agents"`,
  `askFirstRiskLevels: ["write", "destructive"]` (same as Enterpret).
- `quarantineNewEntries: true` on connect, and the reviewed catalog is
  preserved on refresh and reconnect. Tools that appear later, such as a
  newly exposed script, are quarantined with `pending_review`.
- Write-capable use beyond Ask first needs a separate operator decision for
  each deployment.

## Validation Hook

Deterministic coverage (no live Home Assistant):

- `packages/shared/src/app-definitions.test.ts`: manifest shape, URL
  resolution for ports 443 and 8123, host and port validation, store
  visibility, branding, and Ask-first defaults.
- `server/src/__tests__/tool-access-service.test.ts`:
  - risk classification for bare and namespaced reads, intents, and
    script look-alikes;
  - a gallery connect that sends the bearer token to the resolved
    `/api/mcp/assist` URL without echoing it into config;
  - quarantine of a newly exposed script on refresh;
  - rejection of a scheme, path, or port smuggled into `haHost`.

**Outstanding live proof** (not run): connect with a real dedicated-user token
over Home Assistant Cloud or a TLS proxy, safe read (`GetLiveContext`),
Ask-first write approval and denial, refresh quarantine after exposing a new
script, token revocation in Home Assistant, and Home Assistant releases older
than 2026.8 returning 404 on `/api/mcp/assist`.
