# UniFi connection

Agents can read a UniFi Network deployment through the community
[`pete-builds/mcp-unifi`](https://github.com/pete-builds/mcp-unifi) MCP server.
The readable data covers devices, clients, networks and VLANs, WLANs,
firewall and routing, WAN and site health, and events. With approval, the
same server can also change that network if its operator has enabled writes.

This document follows the template in
[Connection Authoring Runbook](./CONNECTOR-PLAYBOOK.md) and records exactly what
was and was not verified.

**Status: catalog connector with deterministic tests only.** It has not been
connected to a live UniFi console or mcp-unifi server. See
[Validation Hook](#validation-hook).

**Release path:** the **bearer token** method (`mcp-bearer-token`) targets
`https://{unifiMcpHost}:{unifiMcpPort}/mcp`. That URL is a TLS reverse proxy in
front of the customer's own mcp-unifi container.

Provider docs and mcp-unifi `v0.25.0` source (tag `v0.25.0`, released
2026-10-02, MIT) were read on 2026-10-07.

## Vendor

- App key: `unifi`
- App name: UniFi
- Owner: unassigned
- Reuse classification: **MCP-direct (community server)**.
  - Ubiquiti does not publish an MCP server.
  - mcp-unifi is a third-party, MIT-licensed, self-hosted server that speaks
    Streamable HTTP.
  - It is not a Ubiquiti service and Ubiquiti does not support it.
  - The endpoint is per-customer and comes from a URL template.
- Security tier: **S3**. If the server allows writes, its tools can block
  clients, restart or adopt devices, change firewall, WLAN, VLAN, and routing
  settings, and restore a whole configuration.

### Why a catalog entry at all

Operators could already paste the URL into "Connect your own MCP server". The
catalog entry adds UniFi-specific governance that the generic path cannot give:

- a reviewed, exact read allowlist;
- Ask first for every other tool;
- quarantine for tools that appear in later server releases;
- setup guidance for layered read-only operation.

That guidance matters because mcp-unifi names many mutations without write
verbs (`trigger_speedtest`, `locate_device`, `reconnect_client`). The generic
classifier treats those as reads.

### Read-only is layered

No single layer is trusted to keep the connection read-only:

1. **UniFi key.** The UniFi API key comes from a dedicated **View Only** local
   administrator. The UniFi console rejects writes regardless of what the MCP
   server sends.
2. **Server mode.** mcp-unifi runs with `MCP_UNIFI_READONLY=true`. Mutating
   tools are hidden from `tools/list` and refused if called.
3. **Paperclip governance.** Only reviewed reads start Allowed. Everything
   else is Ask first, and new tools are quarantined (see [Actions](#actions)).

## Transport And Auth

- Transport: `mcp_remote`, Streamable HTTP.
- Endpoint: `https://{unifiMcpHost}:{unifiMcpPort}/mcp`. `unifiMcpPort` is an
  advanced field that defaults to `443`.
- Auth: `api_key`. Paperclip sends one of the server's `MCP_UNIFI_AUTH_TOKENS`
  values as `Authorization: Bearer <token>` (`keyPlacement` header). mcp-unifi
  refuses to start its HTTP transport without a token unless
  `MCP_UNIFI_AUTH_REQUIRED=false` is set. Never set that on a reachable
  interface.
- **Two separate credentials:**
  - The **mcp-unifi bearer token** is stored in Paperclip as a company secret
    ref.
  - The **UniFi API key** (`UNIFI_API_KEY`, sent by mcp-unifi as `X-API-Key`
    to the console's local API) stays on the mcp-unifi host. Paperclip never
    sees it and cannot narrow it.
- HTTPS only.
  - Curated URL templates must be `https://`, and the server rejects resolved
    non-HTTPS URLs.
  - The container's own port `3714` serves plain HTTP, so a TLS reverse proxy
    is required.
- Host validation: `unifiMcpHost` must be a bare DNS name. Schemes, paths,
  ports, and userinfo are rejected so they cannot be smuggled into the URL
  template.
- Private network reachability follows the generic remote-endpoint guard.
  Private addresses are allowed only when the deployment is not authenticated
  and public.
- Paperclip ID / Paperclip Connect involvement: **none.** Both credentials are
  customer-managed, and the endpoint is the customer's own server.

### Connection Flow (mandatory)

```mermaid
sequenceDiagram
    participant O as Operator
    participant U as UniFi OS console
    participant S as mcp-unifi (behind TLS proxy)
    participant P as Paperclip instance
    O->>U: Add local admin with View Only role
    O->>U: As that admin, Control Plane → Integrations → create API key
    O->>S: Run mcp-unifi with UNIFI_API_KEY, MCP_UNIFI_READONLY=true, MCP_UNIFI_AUTH_TOKENS
    O->>S: TLS reverse proxy, allow only Paperclip's address
    O->>P: Connect UniFi, method mcp-bearer-token, host + bearer token
    P->>P: Validate host, resolve https URL, store token as secret ref
    P->>S: POST initialize + tools/list, Authorization: Bearer <token>
    S-->>P: Read tools only (mutating tools hidden in read-only mode)
    P->>P: classifyRisk (exact reviewed reads), Ask first for the rest
    P->>O: Finish setup; later-discovered tools quarantined
    Note over P,U: On a tool call: P → S (bearer token) → U local API (X-API-Key, View Only)
```

### Credential residual risk

- **UniFi API keys carry the role of the admin who created them.** Ubiquiti
  documents no per-key scopes. A key minted by a Full Management or Super Admin
  account can do anything on the console, so a **View Only** admin is required
  (setup steps, warnings, and credential helper text). Whether every UniFi OS
  release lets a View Only admin create a key comes from Ubiquiti help and
  community reports. It has not been confirmed on a live console here.
- **The bearer token** grants whatever the mcp-unifi server exposes. That is
  why `MCP_UNIFI_READONLY=true` and the View Only key both matter. The token is
  stored only as a company secret ref, never in connection config, and the
  tests assert it is not echoed.
- **Revocation:**
  - Remove the token from `MCP_UNIFI_AUTH_TOKENS` and restart the server.
  - Delete the API key in UniFi OS, or remove the View Only admin.
  - Or disconnect in Paperclip.
- mcp-unifi writes a JSONL audit log (`MCP_UNIFI_AUDIT_PATH`) of every tool
  call, which can be used to cross-check Paperclip's own tool-call records.

## Administrator Setup (mandatory)

1. Run a UniFi OS console with UniFi Network 9 or newer.
2. In UniFi OS → Admins & Users, add a dedicated **local** administrator with
   the **View Only** role for Network. Do not use an owner, Super Admin, or
   Full Management account.
3. Sign in as that administrator. Under Settings → Control Plane →
   Integrations, create an API key.
4. Run mcp-unifi `0.25.0` or newer, pinned to a reviewed release rather than
   `latest`:

   ```bash
   docker run -d --name mcp-unifi -p 127.0.0.1:3714:3714 \
     -e UNIFI_HOST=192.168.1.1 \
     -e UNIFI_API_KEY_FILE=/run/secrets/unifi_view_only_key \
     -e MCP_UNIFI_READONLY=true \
     -e MCP_UNIFI_AUTH_TOKENS="$(openssl rand -hex 32)" \
     ghcr.io/pete-builds/mcp-unifi:0.25.0
   ```

   - Keep `MCP_UNIFI_MODULES_ENABLED` at its default (`network`). The Protect
     and Access modules expose camera imagery and door, credential, and
     visitor data, which this connector does not review as reads.
   - Set `UNIFI_VERIFY_SSL=true` or `UNIFI_PINNED_CERT` so the server verifies
     the console's certificate.
5. Put a TLS reverse proxy (Caddy, nginx, Traefik) in front of
   `127.0.0.1:3714`, serving `/mcp` on a host name with a valid certificate.
   Allow only Paperclip's egress address to reach it.
6. In Paperclip, open Apps → UniFi. Paste the proxy host name and one bearer
   token from `MCP_UNIFI_AUTH_TOKENS`, then keep no other copy of the token.

## Resource Filters

None. The resource boundary is the View Only admin's site access plus the
modules enabled on the server. Paperclip cannot narrow it further.

## Manifest

Authored in `scripts/ingest-app-definitions.mjs` and generated to
`packages/shared/src/app-definitions/unifi.json`:

- One method: `mcp-bearer-token`, `mcp_remote`, `api_key`, `ownershipModes:
  ["customer"]`, `grantKinds: ["organization"]`, risk tier S3.
- Tenant fields: `unifiMcpHost` (required, bare host) and `unifiMcpPort`
  (advanced, default `443`).
- Credential field `authorization`, placed as `Authorization: Bearer`.
- `setupPrerequisite` with the steps above. Warnings cover:
  - the community, non-Ubiquiti server;
  - the View Only key;
  - `MCP_UNIFI_READONLY=true`;
  - Ask-first defaults and quarantine;
  - HTTPS only.
- URL pattern `https://unifi-mcp.*/mcp` recognizes pasted URLs that follow
  the documented `unifi-mcp.<domain>` host convention. Self-hosted servers have
  no fixed domain, so other host names use the setup form directly.
- Branding: `ui/public/brands/apps/unifi.svg` is the UniFi Network app logo.
  - It was extracted from the inline `NetworkLogo` SVG on
    <https://www.ui.com/> (retrieved 2026-10-07).
  - Paths and colors are unchanged. Only element ids were renamed.
  - It is paths and gradients only, with no scripts or external references.
  - UniFi is a Ubiquiti trademark and is used only to identify the
    integration.

## Actions

mcp-unifi v0.25.0 registers 136 tools across three modules. Its tool
annotations (`readOnlyHint` / `destructiveHint`) match its internal
`@audited(mutates=...)` flag for every tool. 74 are reads: 48 Network, 8
Protect, and 18 Access. Risk is assigned per tool by `classifyRisk` with
`sourceTemplateKey === "unifi"`:

| Tools | Risk | Default |
| --- | --- | --- |
| The 48 Network-module reads in `UNIFI_READ_TOOLS` (`list_devices`, `list_clients`, `list_networks`, `list_wlans`, `list_firewall_*`, `get_site_health`, `get_wan_status`, `audit_open_ports`, `backup_config`, …) | read | Allowed |
| Protect and Access reads (`list_cameras`, `get_snapshot`, `list_motion_events`, `list_credentials`, `get_door`, `list_visitors`, …) | write | Ask first |
| Unannotated or non-destructive mutations (`update_*`, `create_*`, `set_*`, `toggle_*`, `trigger_speedtest`, `locate_device`, `reconnect_client`, `rename_device`, …) | write | Ask first |
| `destructiveHint: true` tools (`block_client`, `restart_device`, `restore_config`, `delete_*`, `confirm_destructive_action`, …) | destructive | Ask first |
| Any tool added in a later release | write (or destructive) | Quarantined, then Ask first |

- Names are matched **exactly**. A later read-looking tool such as
  `list_vouchers` stays a write until it is reviewed into the allowlist.
- A reviewed read that reports `readOnlyHint: false` or `writeHint: true` is
  downgraded to write. `destructiveHint: true` always wins.
- Unreviewed tools never become reads, even with `readOnlyHint: true`.
  Without this rule, the generic classifier would read `trigger_speedtest`
  and Protect camera reads as reads.
- With `MCP_UNIFI_READONLY=true`, mutating tools never appear in the catalog.
  The rows above apply only if an operator turns that mode off.
- `backup_config` returns the full network configuration. mcp-unifi replaces
  WLAN passphrases, VPN keys, and RADIUS secrets with a redaction sentinel.
  `list_port_forwards`, `list_firewall_rules`, and `list_dhcp_leases` still
  reveal internal topology, so treat the connection as sensitive.

## Wizard Path

Apps → UniFi → **Use an MCP server token** → setup prerequisites → host (and
advanced port) + token → catalog review → finish. Reviewed Network reads
start Allowed and everything else starts Ask first.

## Governance Defaults

- `recommendedDefaultsForApp`: `access: "all_agents"`,
  `askFirstRiskLevels: ["write", "destructive"]` (same as Enterpret).
- `quarantineNewEntries: true` on connect. The reviewed catalog is preserved
  on refresh and reconnect, so tools that appear later (for example after an
  mcp-unifi upgrade or enabling another module) are quarantined with
  `pending_review`.
- Turning off `MCP_UNIFI_READONLY` or using a write-capable UniFi key needs a
  separate operator decision for each deployment.

## Validation Hook

Deterministic coverage (no live UniFi console):

- `packages/shared/src/app-definitions.test.ts`: manifest shape, URL
  resolution for ports 443 and 8443, host and port validation, store
  visibility, branding, and Ask-first defaults.
- `server/src/__tests__/tool-access-service.test.ts`:
  - risk classification for reviewed Network reads, Protect and Access reads,
    verb-less mutations, destructive tools, and spoofed `readOnlyHint` on
    unreviewed names;
  - a gallery connect that sends the bearer token to the resolved `/mcp` URL
    without echoing it into config;
  - quarantine of a new read-looking tool on refresh;
  - rejection of a scheme, path, or port smuggled into `unifiMcpHost`.

**Outstanding live proof** (not run):

- Mint a View Only API key and confirm that the console rejects a write made
  with it.
- Run mcp-unifi with `MCP_UNIFI_READONLY=true` behind TLS, and confirm that
  `tools/list` returns only reads.
- Connect from Paperclip and run a safe read (`list_devices`,
  `get_site_health`).
- Confirm refresh quarantine after an mcp-unifi upgrade.
- Revoke the token, then the key.

For a hardware-free smoke test, mcp-unifi's `STUB_MODE=true` returns canned
devices.
