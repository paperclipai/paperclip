# Neon

Updated: 2026-10-02. Status: catalog definition reviewed against official
documentation and live provider metadata; live account qualification
outstanding.

Neon appears in Apps and uses Paperclip's shared remote-MCP OAuth connection,
vault, catalog, grants, policies, gateway, and audit trail. It is a resource
connection, not Paperclip sign-in. No plugin, provider-specific runtime code,
or database migration is required.

Paperclip connects to Neon's hosted MCP server at `https://mcp.neon.tech/mcp`.
The connection supports two explicit methods:

- browser OAuth, recommended for Neon accounts; or
- a Neon API key stored as a Paperclip secret and sent as an
  `Authorization: Bearer ...` header.

Paperclip does not silently fall back from OAuth to an API key. The selected
method is saved on the connection and reused for reconnects.

This curated connection is the polished route: it provides branding, optional
project pinning and read-only controls, field validation, and tailored
guidance. None of it is *required* to reach Neon's server. Neon can also be
connected generically from **Connect your own MCP server** by pasting
`https://mcp.neon.tech/mcp`, with no Paperclip-specific code involved. See
[Connecting any remote MCP server](./GENERIC-REMOTE-MCP.md).

## Service involvement

Neon hosts both the MCP resource and its OAuth authorization service on the
same origin. Paperclip discovers the OAuth endpoints, dynamically registers the
client, stores returned credentials as secret references, and handles the
callback at `/api/tools/oauth/callback`. No Paperclip-operated vendor relay is
involved; cloud and self-hosted instances use the same path.

```mermaid
sequenceDiagram
    actor A as Administrator
    participant P as Paperclip
    participant M as mcp.neon.tech

    A->>P: Choose Sign in with Neon
    P->>M: GET /.well-known/oauth-protected-resource/mcp
    M-->>P: Authorization server: https://mcp.neon.tech
    P->>M: GET /.well-known/oauth-authorization-server
    M-->>P: authorize, token, register, revoke endpoints; scopes read, write
    P->>M: POST /api/register (dynamic client registration)
    M-->>P: Client registration
    P-->>A: Open browser authorization (scope: read write, PKCE S256)
    A->>M: Approve access
    M-->>P: Redirect to /api/tools/oauth/callback
    P->>M: POST /api/token (authorization code)
    M-->>P: Access and refresh tokens
    P->>M: tools/list on /mcp with optional projectId and readonly query
    M-->>P: Neon tool catalog
```

The hosted endpoints retrieved on 2026-10-02:

| Purpose | Endpoint |
| --- | --- |
| MCP resource (Streamable HTTP) | `https://mcp.neon.tech/mcp` |
| Protected-resource metadata | `https://mcp.neon.tech/.well-known/oauth-protected-resource/mcp` |
| Authorization-server metadata | `https://mcp.neon.tech/.well-known/oauth-authorization-server` |
| Authorize | `https://mcp.neon.tech/api/authorize` |
| Token | `https://mcp.neon.tech/api/token` |
| Dynamic client registration | `https://mcp.neon.tech/api/register` |
| Revoke | `https://mcp.neon.tech/api/revoke` |
| Paperclip callback | `/api/tools/oauth/callback` |

The authorization server advertises `code` responses, PKCE `S256`,
`authorization_code` and `refresh_token` grants, `none` client authentication
for registered public clients, and exactly two scopes: `read` and `write`.
Paperclip requests both so the connection has the write surface described
below; the read-only switch narrows the server itself rather than the token.
Caller widening beyond the reviewed scopes is rejected.

Neon's older SSE endpoint (`https://mcp.neon.tech/sse`) is deprecated and
returns `410 Gone` on or after 2026-10-01. Paperclip does not offer it.

## Administrator setup

1. In **Apps → Browse**, choose **Neon**.
2. Explicitly choose **Sign in with Neon** or **Use an API key**.
3. Continue directly with Neon's defaults. No project ID is required.
4. Open **Advanced** only when you need to pin the connection to one
   **project ID** or force **Read-only mode**.
5. For OAuth, continue through browser consent. For API-key setup, create a
   key in Neon Console → **Settings → API keys** and paste it into Paperclip.
   Prefer a project-scoped key, which Neon limits to one project with Editor
   rights; personal and organization keys reach every project the account can
   access. Never put the key in connection configuration or a URL.
6. Review discovered actions on the connection's **Permissions** screen. Every
   discovered action starts **Allowed**, including writes and destructive
   actions. Set deletion, branch reset, and compute mutations to **Ask first**
   where operator review is wanted.

Use a public HTTPS Paperclip origin or a loopback HTTP origin such as
`http://localhost:3100`. A plain HTTP tailnet hostname is not loopback; use
HTTPS or change the local canonical origin before connecting.

When configured, Paperclip appends `projectId=<id>` and `readonly=true` as
query parameters on the server URL, exactly as Neon documents. The same URL is
used for catalog discovery and tool execution, and a caller cannot override it.
Neon documents a repeatable `category=<name>` filter as well; Paperclip's
tenant fields serialize lists as one comma-joined value, so that filter is not
offered. Use the per-action Off / Ask first / Allowed controls to narrow the
catalog instead.

## Capabilities and policy

The catalog is discovered live from the actual provider schemas. Neon groups
its tools into these categories:

| Category | What the tools do | Classification |
| --- | --- | --- |
| `docs` | Look up Neon documentation | Read |
| `schema`, `observability` | Inspect tables and columns, compare schemas, query logs, check availability | Read; may expose application data |
| `projects`, `branches`, `endpoints` | List, create, describe, delete projects and branches; manage roles, databases and computes | Write or destructive |
| `snapshots` | Create, restore and schedule snapshots | Write or destructive |
| `querying` | Execute SQL, apply schema changes, run diagnostics | Write; read-only mode limits SQL to `SELECT` |
| `neon_auth`, `data_api` | Provision Neon Auth, manage OAuth providers, enable or disable the Data API | Write |
| `functions`, `storage` | Deploy functions, manage buckets and objects | Write or destructive |

Neon enforces the account, organization, and project permissions behind the
credential. The optional project pin and read-only switch are enforced by
Neon's server, not by Paperclip. `requiredResourceFilters: ["project"]` is
reviewed policy metadata that names the boundary operators should set; it is
not a local allowlist.

Neon's own guidance: the hosted server grants broad database management
capabilities, so always review and authorize actions before execution, and
prefer development or testing projects over production data.

## Vendor

- App key: `neon`
- App name: Neon
- Reuse classification: MCP-direct
- Reason for classification: official hosted Streamable HTTP server with
  RFC 7591 dynamic registration and documented bearer API keys; common fields
  represent every documented option Paperclip can serialize.
- Security tier: S4
- Plugin needed? No.

## Transport and auth

- Transport: `mcp_remote`
- Endpoint: `https://mcp.neon.tech/mcp`
- Auth modes: OAuth (DCR, PKCE) or API key
- OAuth scopes: `read`, `write` (explicit, reviewed)
- Key scope: whatever the Neon key carries; Paperclip cannot widen it
- Credential owner: company or user grant through the standard access screen
- Secret storage: `company_secrets` refs only
- Revocation: Neon publishes `/api/revoke`; Paperclip removal revokes the
  grant and deletes stored secrets

## Resource filters

- Required filters: none on the default path
- Optional filters: `projectId` (query `projectId`), `readOnly` (query
  `readonly=true`, omitted when off)
- Write-enabling filters: none; writes depend on the credential and on
  read-only mode being off
- Filters enforced by: Neon's hosted server

## Manifest

- slug: `neon`; name: Neon; categories: `data`
- branding: `/brands/apps/neon.png` (official touch icon, both themes)
- docsUrl: `https://neon.com/docs/ai/neon-mcp-server`
- methods: `mcp-oauth` (Sign in with Neon, `dcr`), `mcp-api-key` (Use an API
  key, `customer`, `Authorization: Bearer` header)
- tenantFields: `projectId` (text, advanced, `^[a-z0-9-]+$`, max 64),
  `readOnly` (checkbox, advanced, default off)
- riskTier: S4; requiredResourceFilters: `project`
- urlPatterns: `https://mcp.neon.tech/*`; redirectConstraints:
  `https-or-loopback-http`

Source of truth: the `neon` block in `scripts/ingest-app-definitions.mjs`, the
ledger row in `packages/shared/src/self-serve-mcp-research.json`, and the two
reviews in `doc/connections/tool-method-permission-reviews.json`. Regenerate
with `pnpm connections:ingest-app-definitions` (or `--definitions-only`
without the research corpus).

## Wizard path

- User path: Apps → Browse → Neon → method → Access → Connect.
- Configuration steps: none required; Advanced holds project pin and
  read-only mode.
- Error states: discovery or OAuth failures stay inline on Connect with a
  retry of the same saved connection; an invalid project ID is rejected before
  the provider is contacted.
- Redacted metadata shown: method, pinned project ID, read-only flag. Tokens
  and keys are never shown.

## Governance defaults

- Default profile and bindings: the standard connection profile; every
  discovered action starts Allowed under the current product default.
- Policies: operators narrow destructive categories to Ask first or Off on the
  Permissions screen.
- Quarantine rules: the shared defaults; no Neon-specific exceptions.

## Brand provenance

Neon's own app icon, the black tile with the green logomark, is used because the
bare logomark from the brand kit is a thin outline that reads weakly at 24–36px
on the light frame. The file is Neon's official touch icon, copied byte-for-byte
on 2026-10-02 and used unchanged in both themes (Neon's brand colours are
black and `#34D59A`).

| File | Source | SHA-256 |
| --- | --- | --- |
| `ui/public/brands/apps/neon.png` (180×180) | `https://neon.com/apple-touch-icon.png`, the icon linked from `https://neon.com/` | `a6cf4b0772b06a5a64ccfefbfb8b7a1af56e0876eb10c9052f43c8624f4a0b61` |

The brand kit at `https://neon.com/brand` publishes the bare logomark as SVG
(light and dark colour variants) but no vector of the tile; the raster official
icon is preferred over a locally composed SVG so the artwork stays the
vendor's own.

## Validation hook

- Environment: definition review on 2026-10-02 against `origin/master`;
  no Neon account was used.
- Metadata probe: both `.well-known` documents above returned HTTP 200 with the
  endpoints and scopes recorded here. An unauthenticated `initialize` on
  `/mcp` returned HTTP 401 with
  `WWW-Authenticate: Bearer ... resource_metadata="https://mcp.neon.tech/.well-known/oauth-protected-resource/mcp"`.
- Deterministic tests: manifest shape, store visibility, artwork, reviewed
  scopes, scope-widening rejection, URL projection of the project pin and
  read-only flag, and invalid project ID rejection.
- Connect evidence, catalog evidence, allowed read, governed write,
  denied case, revoke, audit: not run. Each exposed method still needs the
  full live lifecycle with a Neon development project before this connection
  is considered qualified.
