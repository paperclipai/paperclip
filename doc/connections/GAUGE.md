# Gauge

Updated: 2026-10-08. Status: catalog definition reviewed against official
documentation and live provider metadata; live account qualification
outstanding.

Gauge (`withgauge.com`) measures how AI answer engines mention and cite a
brand, combines that with SEO, analytics and ads data, and runs a content
pipeline that can publish to a connected CMS. It appears in Apps and uses
Paperclip's shared remote-MCP connection, vault, catalog, grants, policies,
gateway, and audit trail. It is a resource connection, not Paperclip sign-in.
No plugin, database migration, or provider-specific runtime code is required.

Paperclip connects to Gauge's hosted MCP server at
`https://app.withgauge.com/mcp` (Streamable HTTP) with two methods:

- `mcp-oauth`: browser sign-in through Gauge's dynamic client registration.
  The user chooses one Gauge organization on the consent screen.
- `mcp-api-key`: an organization API key stored as a Paperclip secret and
  sent as an `Authorization: Bearer <key>` header.

This curated connection is the polished route: it provides branding, method
guidance, and a publish warning. The same URL can also be connected from
**Connect your own MCP server**. See
[Connecting any remote MCP server](./GENERIC-REMOTE-MCP.md).

## Service involvement

Gauge hosts the MCP resource and the authorization server. Paperclip stores
the OAuth tokens or the key as secret references, discovers tools with
`tools/list`, and sends the credential on every governed call. No
Paperclip-operated vendor relay is involved; cloud and self-hosted instances
use the same path.

## Endpoints

| Purpose | URL |
| --- | --- |
| MCP resource | `https://app.withgauge.com/mcp` |
| Protected-resource metadata | `https://app.withgauge.com/.well-known/oauth-protected-resource` |
| Authorization-server metadata | `https://app.withgauge.com/.well-known/oauth-authorization-server` |
| Authorize | `https://app.withgauge.com/mcp/oauth/authorize` |
| Token | `https://app.withgauge.com/mcp/oauth/token` |
| Dynamic client registration | `https://app.withgauge.com/mcp/oauth/register` |

The authorization server supports `authorization_code` and `refresh_token`,
PKCE `S256`, and public clients (`token_endpoint_auth_method: none`). It
advertises the scopes `mcp`, `openid`, `profile`, `email` and
`organizations`, and rejects unknown scopes with HTTP 400.

## Scopes

Paperclip requests only `mcp`, the scope that grants MCP access. The identity
scopes are not needed: Gauge selects the organization on its consent screen,
not through a scope. This is recorded as an explicit review in
[`tool-method-permission-reviews.json`](./tool-method-permission-reviews.json).

## Administrator setup

Browser sign-in:

1. In Paperclip, open **Apps → Browse → Gauge** and click
   **Continue to sign in**.
2. Sign in to Gauge, choose the organization, and approve access.

API key:

1. In Gauge, open **Settings → Integrations → API Keys** and click
   **Generate API Key**. Use a separate key for Paperclip so it can be deleted
   independently.
2. In Paperclip, open **Apps → Browse → Gauge**, open **Advanced**, choose
   **Use an API key**, paste the key, and click **Connect**.

After either method, set publish actions to **Ask first** or **Off** on the
connection's **Permissions** screen if agents run unattended.

To disconnect, remove the connection in Paperclip. For an API key, also
delete the key in Gauge under **Settings → Integrations → API Keys**, which
revokes every connection that uses it.

## Capabilities and policy

Gauge documents about 25 tools in these groups:

- AI visibility and citations: mentions, citations, answers, visibility and
  performance trends, and the sources and pages behind them.
- Topics and prompts: browse tracked prompts and answers; create, generate,
  move and tag prompts; bulk keyword updates, which replace each prompt's
  full keyword list.
- SEO and keyword reporting: organic rankings, volume, difficulty, and the
  keywords a domain or page ranks for.
- GA4, Search Console and PostHog reports, where those integrations are
  connected in Gauge.
- Google Ads and OpenAI Ads reporting.
- Content pipeline: brief, research, outline, write, review, images, and
  publish to a connected CMS as a draft, to staging, or live.
- Memory files and saved skills: list, read, create and edit.
- Action Center: list, create, assign, set due dates and update status.
- Ask Gauge: natural-language questions answered from the organization's
  data.

Tool names were not captured during this review because it needed a signed-in
account. The generic `classifyRisk` rules apply: `publish`, `create`,
`update`, `set` and similar verbs are writes, and `delete` or `remove` is
destructive. Bulk keyword replacement and live CMS publishing are the
highest-impact actions. The method warnings and the API-key helper tell
operators to put publish actions behind Ask first. If live discovery shows
mutations with read-like names, add a reviewed `gauge` rule to
`classifyRisk`, as Superagent has.

## Transport and auth

- Transport: `mcp_remote`, Streamable HTTP (SSE is also documented).
- OAuth: DCR, public client, PKCE, scope `mcp`. Connects as the approving
  user, limited to the chosen organization.
- API key: `Authorization: Bearer <key>`. Keys are bound to one
  organization, are not scoped, and carry no user identity. Requests are
  attributed to the organization. Paperclip cannot narrow an issued key.

## Resource filters

None. Gauge documents no query or header options that narrow the hosted
server. Each connection is already limited to one organization; narrow further
with per-action policies.

## Manifest

| Field | Value |
| --- | --- |
| Slug | `gauge` |
| Category | `analytics` |
| Methods | `mcp-oauth` (`dcr`, S3, scope `mcp`); `mcp-api-key` (`customer`, S3) |
| Server URL | `https://app.withgauge.com/mcp` |
| Credential | `authorization`, password, required |
| Key placement | header `Authorization`, prefix `Bearer ` |
| Console links | docs `https://docs.withgauge.com/help/mcp` |

The definition is generated from the `gauge` row in
`packages/shared/src/self-serve-mcp-research.json` and the `gauge` branch of
`specialMethodsFor` in `scripts/ingest-app-definitions.mjs`.

## Wizard path

`/apps/connect?source=gauge` defaults to **Sign in with Gauge**. Both methods
share one `write` capability profile, so there is no capability picker, but
the access step shows its description, including the publish warning, before
sign-in. Under
**Advanced**, **Use an API key** shows the key field; **Connect** stays
disabled until a key is entered. A successful sign-in or key check and tool
discovery lead to the connection's Permissions screen.

## Governance defaults

- Default profile and bindings: the standard connection profile; every
  discovered action starts Allowed under the current product default.
- Policies: operators narrow publish and bulk-edit tools to Ask first or Off
  on the Permissions screen.
- Risk: the generic `classifyRisk` rules.
- Quarantine rules: the shared defaults; no Gauge-specific exceptions.

## Brand provenance

Gauge's site ships only a 32×32 favicon, below the catalog's 128px minimum.
The same orange "G" gauge mark is the avatar of Gauge's official GitHub
organization (`withgauge`, whose profile links `https://withgauge.com/`),
published as a 460×460 transparent PNG. That file is used unchanged in both
themes.

| File | Source | SHA-256 |
| --- | --- | --- |
| `ui/public/brands/apps/gauge.png` (460×460) | `https://avatars.githubusercontent.com/u/213101673?v=4&s=512` | `bf1f63a5d30b7f6af1064b74f5f66bf5ea6454d6036a068bf8b0c926fa3f37a6` |

## Validation hook

- Environment: definition review on 2026-10-08 against `origin/master`; no
  Gauge account was used.
- Metadata probe: an unauthenticated `initialize` on `/mcp` returned HTTP 401
  with `resource_metadata`; both `.well-known` documents returned the
  endpoints and scopes above; dynamic client registration succeeded for a
  loopback redirect; the authorize endpoint accepted `scope=mcp` (redirect to
  Gauge sign-in) and rejected an unknown scope with HTTP 400.
- Deterministic tests: manifest shape, store visibility, artwork, URL
  recognition, reviewed scope, bearer-header placement, and the connect
  form's sign-in default, the publish warning before sign-in, and API-key
  gating.
- Connect evidence, catalog evidence, allowed read, governed write, denied
  case, revoke, audit: not run. Both methods still need the full live
  lifecycle with a Gauge organization before this connection is considered
  qualified.
