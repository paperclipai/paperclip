# Enterpret MCP — acceptance test against the generic MCP-direct path

PAP-18519. Executed 23 September 2026 against Paperclip App commit
`1aeba0e6c2` on the `PAP-18464-connector-authoring-skills` branch, on a
disposable self-hosted instance started for this pass and torn down after it.
This is the acceptance test for the two connector skills shipped on PAP-18464:
Michael asked for an Enterpret connector, and both skills say to establish
first whether a catalog entry is needed at all.

**No Enterpret credential exists and none was requested.** Paperclip's connect
flow performs RFC 7591 dynamic client registration automatically and Enterpret's
`/register` is live, so pointing a connect flow at the live endpoint would have
created a client record at a vendor we have no relationship with. Everything
below is either an **unauthenticated public metadata read** of Enterpret, or a
run against a **loopback mirror** of Enterpret's published metadata. No client
was registered with Enterpret, no consent was given, no tool was called, and no
Enterpret data of any kind was read. No credential value appears in this file.

## 1. Provider metadata, reproduced

Read unauthenticated from this runtime on 23 September 2026, against DevRel's
readings of the same day. **No drift on any stated fact.**

| Fact | Reproduced |
| --- | --- |
| `POST https://wisdom-api.enterpret.com/server/mcp`, MCP `initialize`, no auth | `HTTP/2 401`, `server: uvicorn` |
| Challenge header | `Bearer realm="mcp", resource_metadata="https://wisdom-api.enterpret.com/server/mcp/.well-known/oauth-protected-resource", scope="mcp:read mcp:write"` — exact match |
| Trailing-slash form | `401`, empty `redirect_url` — no redirect, as stated |
| RFC 9728 doc | `resource` matches the endpoint; `authorization_servers: ["https://oauth.enterpret.com"]`; `scopes_supported: ["email","mcp:read","mcp:write"]` |
| RFC 8414 doc at `https://oauth.enterpret.com/.well-known/oauth-authorization-server` | `issuer` matches the issuer used to build the URL, so it is authoritative under the skill's Step 2 check. `/authorize`, `/token`, `/register`, `/introspect`, `/userinfo`; `jwks_uri` on Cognito `us-east-2_kLiRrPBis`; `code_challenge_methods_supported: ["S256"]`; `token_endpoint_auth_methods_supported: ["none"]`; `grant_types_supported: ["authorization_code","refresh_token"]` |
| `revocation_endpoint` | **absent**, confirmed — and absent from the OIDC document too |
| `/.well-known/openid-configuration` | `200` |

Three observations DevRel's list does not carry, all additive:

- Enterpret also serves the **RFC 9728 insertion form**
  `https://wisdom-api.enterpret.com/.well-known/oauth-protected-resource/server/mcp`
  and the bare origin form, both `200`, both returning the same document. Only
  the challenge-named suffix form is actually needed — see §2.
- A plain `GET` on the MCP endpoint also returns `401` with the same challenge,
  so discovery does not depend on issuing a JSON-RPC body.
- The OIDC document carries `service_documentation:
  https://docs.enterpret.com/mcp` and `id_token_signing_alg_values_supported:
  ["RS256"]`, neither of which appears in the RFC 8414 document.

## 2. The discovery ladder, against a mirror

Two independent runs, the same shape both times.

**Deterministic run.** `server/src/__tests__/generic-mcp-connection.test.ts`,
`describe("a vendor-shaped MCP-direct provider (PAP-18519)")` — four tests, all
passing, 70/70 in the file, server typecheck clean. The fixture copies
Enterpret's documents field for field onto DNS-pinned IP literals: same
challenge header including `realm` and `scope`, same protected-resource
document, same RFC 8414 document including `token_endpoint_auth_methods_supported:
["none"]`, PKCE `S256`, and **no** `revocation_endpoint`.

**Live-instance run.** A disposable self-hosted instance
(`local_trusted` + `private`, embedded PostgreSQL, loopback `127.0.0.1:38519`,
no `PAPERCLIP_PUBLIC_URL`) plus a loopback mirror server on
`127.0.0.1:38520` serving the same documents. Source for the mirror is in §6.

### Does discovery resolve from the 401 challenge alone?

**Yes, completely.** The operator supplies a URL and a name; nothing else.
From the live instance, `POST /api/companies/{c}/tools/apps/connect` with
`{link, name}` returned `HTTP 201` and this persisted `config.oauth`:

```json
{
  "issuer": "http://127.0.0.1:38520",
  "scopes": ["mcp:read", "mcp:write"],
  "resource": "http://127.0.0.1:38520/server/mcp",
  "authorizationUrl": "http://127.0.0.1:38520/authorize",
  "tokenUrl": "http://127.0.0.1:38520/token",
  "registrationUrl": "http://127.0.0.1:38520/register",
  "metadataUrl": "http://127.0.0.1:38520/server/mcp/.well-known/oauth-protected-resource",
  "codeChallengeMethodsSupported": ["S256"],
  "tokenEndpointAuthMethodsSupported": ["none"],
  "clientIdMetadataDocumentSupported": false
}
```

The provider's own request log shows the whole resolution costing **two**
metadata fetches per connection, in order, and nothing else:

```text
  GET  /server/mcp/.well-known/oauth-protected-resource
  GET  /.well-known/oauth-authorization-server
```

The insertion form Enterpret also serves was never fetched: the challenge names
the suffix form, and a named `resource_metadata` short-circuits Paperclip's own
candidate list (`discoverOAuthEndpoints`, `server/src/services/tool-access.ts`).
Because the issuer is pathless, RFC 8414 well-known insertion never applies and
the origin form is the only candidate — so the pathful-issuer ambiguity that
bites other vendors does not arise here.

**Consequence for the catalog definition: ship `serverUrl` only.** A definition
that also shipped an `authorizationEndpoint`/`tokenEndpoint` pair would make
those endpoints authoritative and skip discovery entirely, for good
(`oauthEndpointsForConnection` rung 1), including overriding endpoints a prior
discovery had persisted. There is nothing to gain here and a stale-endpoint
failure mode to acquire.

One behaviour worth naming, because it is not what the documents suggest: the
challenge's `scope="mcp:read mcp:write"` **wins over** the protected-resource
document's `scopes_supported`, so the `email` scope the resource advertises is
never requested. That narrowing is the provider's own, not a reviewed Paperclip
allowlist.

### What does the ladder do with no public HTTPS origin?

**It falls through to DCR, as the playbook says — but the public-origin
condition is not what decides it for this vendor.**

The playbook frames the Client ID Metadata Document rung as requiring a public
HTTPS `PAPERCLIP_PUBLIC_URL`. Enterpret's authorization server never advertises
`client_id_metadata_document_supported` at all, so the rung is missing on the
*server* side. Asserted both ways in the deterministic run: a loopback callback
and a public HTTPS callback with a resolvable metadata host both produce
`registrationSource: "dcr"`. On the live instance, with no public origin
configured at all, the wizard returned:

```json
{
  "kind": "oauth",
  "issuer": "http://127.0.0.1:38520",
  "resource": "http://127.0.0.1:38520/server/mcp",
  "registrationSource": "dcr"
}
```

and the authorization URL carried `code_challenge_method=S256`, a
`code_challenge`, `resource=<the MCP endpoint>` (RFC 8707) and
`scope=mcp:read mcp:write`. Registration sent `token_endpoint_auth_method:
"none"`, `grant_types: ["authorization_code","refresh_token"]`,
`response_types: ["code"]` and the instance's own callback — matching what
Enterpret's `token_endpoint_auth_methods_supported: ["none"]` requires.

The round trip completed: `status: active, enabled: true, healthStatus: ok`,
`clientRegistrationSource: "dcr"`, credentials as
`oauth.access_token` / `oauth.refresh_token` secret refs, never in the config
JSON.

**So for a Paperclip-owned Enterpret connection there is no OAuth app to
register in advance, on any deployment.** Neither Paperclip ID nor Paperclip
Connect participates.

### What happens at revoke time with no `revocation_endpoint`?

This is the one that decides runbook scenario 8, and the answer is split.

**Paperclip's half works.** Same connection, same agent, same tool, before and
after `DELETE /api/tool-connections/{id}`:

```text
before  granted agent -> get_graph_schema (selected at finish)  allowed=True   allow_profile
before  granted agent -> run_graph_query  (not selected)        allowed=False  deny_default
after   granted agent -> get_graph_schema                       allowed=False  deny_disabled_connection
```

**The provider's half does not happen at all.** Across the whole pass the
provider received **zero** requests to any revocation or introspection path —
because Paperclip never looks for one. `revocation_endpoint` is read nowhere in
`server/src`, and the persisted `config.oauth` has no slot for it among its 30
keys. Revocation is enforced entirely at the Paperclip boundary; the access
token stays valid at the vendor until it expires on its own.

This is the same posture already recorded for Railway
(`RAILWAY.md:139`), so it is a known class rather than an Enterpret surprise.
But it means **scenario 8 can never read `verified` end to end for Enterpret**.
The honest label is "Paperclip-side enforced, provider-side residual", and the
connector doc must tell the operator to revoke in the Enterpret dashboard as a
second, manual step. If that is unacceptable, the fix is an RFC 7009 client in
the broker plus a vendor that advertises the endpoint — Enterpret advertises
neither, so this is a provider gap, not a Paperclip one.

## 3. Does this need a catalog entry at all?

**Not for connectivity. Yes for governance.** Both halves are executed, not
argued.

### What an operator gets today, with no code change

Both operator-facing entry points work against the mirror on the live instance,
with zero Paperclip code:

**Paste a config** — `POST /api/companies/{c}/tools/mcp/import-json`:

```json
{"drafts":[{"name":"enterpret","transport":"mcp_remote","status":"draft",
  "config":{"url":"…/server/mcp"},"credentialRefs":[],"credentialFields":[],"warnings":[]}]}
```

**Connect your own MCP server** — `POST /api/companies/{c}/tools/apps/connect`
→ `201`, discovery as §2, DCR, consent, active connection, catalog refreshed,
all ten documented tools discovered, wizard `finish` binding one tool to one
agent with `defaultAction: "deny"`.

### What is missing, and it is not cosmetic

**The adverse finding, reproduced on both the deterministic run and the live
instance.** With no `annotations` on the tools — and Enterpret's live
annotations have never been observed — Paperclip infers risk from names alone,
and files **all ten as `read`**:

```text
tool                       riskLevel    destructive
execute_cypher_query       read         False
find_user_quote            read         False
get_graph_schema           read         False
get_organization_details   read         False
get_query_examples         read         False
get_schema                 read         False
run_graph_query            read         False
search_graph_fields        read         False
search_graph_values        read         False
search_knowledge_graph     read         False
```

`run_graph_query` and its legacy alias `execute_cypher_query` execute
operator-supplied queries against Enterpret's customer-feedback graph, and the
provider itself advertises an `mcp:write` scope. The wizard shows the operator
ten reads and no changes. That is the single strongest argument for a curated
entry: **curated method labels and a reviewed risk tier are the fix, and there
is no other place to put them.**

Everything else the generic path cannot supply, field for field against
`packages/shared/src/app-definitions/notion.json`:

| What a catalog entry adds | What the pasted URL gives instead |
| --- | --- |
| `slug` — one stable identity | `applicationKey: "app-gallery:link:<uuid>"`, synthesized per connection. Two operators pasting the same URL get two unrelated applications and nothing knows they are the same vendor. |
| `name`, `description`, `branding.logoUrl` | the operator's typed name; `description: "Connected app at <url>"`; no logo |
| `categories`, `featured` | no store visibility at all |
| `riskTier` | nothing; per-tool risk inferred from names, wrongly, as above |
| curated method labels / `guidanceMd` | raw tool names and the provider's own descriptions |
| reviewed scope allowlist | the provider's own challenge `scope`, unreviewed |
| `requiredResourceFilters` | none |
| `ownershipModes` | no gate on whether Paperclip may auto-register at this vendor |
| `redirectConstraints` | no fail-fast; a bad origin surfaces as a vendor-side error |
| quarantine of newly advertised tools | `quarantineNewEntries: false` and `unverifiedServer: true` are set together for a pasted URL — see **F1** in the connect-agent-tools verification log: a server that advertises a new tool after approval has it auto-allowed on the next refresh, whatever its risk tier |

**Recommendation.** Build the catalog entry, and say plainly in the proposal
that its value is curation rather than connectivity. It should ship `serverUrl`
only, `ownershipModes: ["dcr"]` (Enterpret needs no pre-provisioned app),
`redirectConstraints` probed separately, a reviewed scope list, and explicit
per-method risk for `run_graph_query` / `execute_cypher_query`. F1 should be
fixed on its own merits regardless — a curated entry quarantines new tools, and
that is precisely the protection a pasted URL lacks.

## 4. The nine production-validation scenarios

Runbook matrix at `CONNECTOR-PLAYBOOK.md`, **Step 9: Align With Production
Validation**. **Every row that names
Enterpret itself is `not run`, for one reason: there is no authorized
credential, and registration, consent and tool calls are out of bounds.** The
mirror result is recorded beside it, because the mirror exercises Paperclip's
code against Enterpret's advertised shape and that is what Paperclip can be held
to.

Environment for every mirror result: disposable self-hosted instance, commit
`1aeba0e6c2`, `local_trusted` + `private`, loopback bind, method key
`connect-your-own-mcp-server` (pasted URL, discovered OAuth).

### Self-hosted, same machine

| # | Scenario | Against Enterpret | Against the mirror |
| --- | --- | --- | --- |
| 1 | Setup and consent | **not run** — consent needs an authorized Enterpret login | **pass** — import-json → connect → authorize → callback → finish, no code change |
| 2 | Authentication | **not run** — no credential | **pass** — DCR, PKCE S256, RFC 8707 resource, `iss` validated, tokens vaulted as secret refs |
| 3 | Catalog and configuration | **not run** — an authenticated `tools/list` has never been observed, so the live tool set is documentation only | **pass with an adverse finding** — 10/10 discovered, selections persist; all 10 misclassified `read` (§3) |
| 4 | Allowed execution | **not run** — a tool call against the live server is out of bounds | **partial** — policy allows the selected tool (`allow / allow_profile`); no gateway call executed this pass. The equivalent agent-run execution is proven for this code path in the connect-agent-tools verification log, scenario 4 |
| 5 | Denied execution | **not run** | **pass** — unselected tool `deny / deny_default`; archived connection `deny / deny_disabled_connection` |
| 6 | Runtime delivery | **not run** | **not run this pass** — no agent heartbeat run was started. Proven for the identical generic path in the connect-agent-tools verification log, scenario 6 |
| 7 | Refresh and recovery | **not run** | **not run this pass** — provider-down and token-refresh cycles were not exercised. Token refresh in particular is untested for this shape and should be covered before the entry ships |
| 8 | Revoke and reconnect | **not applicable as a pass** — Enterpret advertises no `revocation_endpoint`, so no provider-side revocation exists to verify | **partial, and it cannot become a pass** — Paperclip-side denial proven; zero revocation calls made, none possible; reconnect not exercised |
| 9 | Activity and secret handling | **not run** | **pass** — 13 activity rows (`tool_app.connected`, `tool_app.oauth_connected`, `tool_app.finished`, `tool_connection.archived`, …); synthetic token canary found 0 times across `tools/connections`, `activity`, `secrets`, `tool-connections/{id}`, `tool-connections/{id}/activity` and the whole instance file tree, while the non-secret `client_id` is visible as expected |

### Self-hosted, server / VPS

**untested**, with one exception that carries. The only axis that differs from
same-machine is the callback origin: public HTTPS instead of loopback. The
deterministic run asserts both origins against this vendor shape and gets
`registrationSource: "dcr"` either way, because the authorization server never
advertises a Client ID Metadata Document. So **scenario 2's client-resolution
answer is established for server/VPS**; scenarios 1 and 3–9 were not run there
and must not be inferred from the same-machine column.

### Cloud

**untested.** No Cloud instance was in reach and no Cloud evidence exists. Do
not infer any row from the self-hosted columns.

## 5. What is still needed, and who owns it

To move rows 1–7 and 9 from `not run` to a real result against Enterpret,
someone must supply **one authorized Enterpret workspace identity**, in either
of the two forms Enterpret documents:

- an Enterpret account that may complete the OAuth consent screen for a
  Paperclip-owned tenant (scopes `mcp:read mcp:write`, and `email` if the
  reviewed allowlist keeps it); or
- an Enterpret-issued Bearer auth token — dashboard → Settings → Enterpret MCP →
  Generate — placed in the `Authorization` header, which Enterpret expires after
  six months, so the connector doc must carry a rotation note.

Authorizing dynamic client registration at `oauth.enterpret.com` is part of that
grant and is not implied by either form. **DevRel owns the handoff.** Nothing in
this pass requested or created an Enterpret credential.

Scenario 8 does not become a pass with any credential. It needs Enterpret to
advertise a `revocation_endpoint` and Paperclip to gain an RFC 7009 client.

## 6. Reproducing this

The deterministic half needs nothing but the repository:

```bash
pnpm vitest run server/src/__tests__/generic-mcp-connection.test.ts -t "PAP-18519"
```

The live half needs a disposable instance and the mirror below. Start the
instance with `paperclipai onboard -y --data-dir <scratch> --no-install-service`,
pin `server.port` and `database.embeddedPostgresPort` in
`<scratch>/instances/default/config.json` to free ports, then
`paperclipai run --data-dir <scratch> --force`. Strip inherited `PAPERCLIP_*`
environment variables or the CLI will send another instance's credentials to the
new one. Kill it by the pid in `runtime-info.json` when finished.

The mirror serves Enterpret's published documents with the two origins rewritten
to loopback. It contacts nothing, stores nothing, and logs header *keys* only —
so no credential can reach its log.

```js
// mirror.mjs — node mirror.mjs 38520
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const port = Number(process.argv[2] ?? 38520);
const ORIGIN = `http://127.0.0.1:${port}`;
const MCP_PATH = "/server/mcp";
const MCP_URL = `${ORIGIN}${MCP_PATH}`;
const CHALLENGE =
  `Bearer realm="mcp", resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource", scope="mcp:read mcp:write"`;

const PROTECTED_RESOURCE = {
  resource: MCP_URL,
  authorization_servers: [ORIGIN],
  scopes_supported: ["email", "mcp:read", "mcp:write"],
};

// Verbatim Enterpret RFC 8414 field set. No revocation_endpoint: that absence
// is the point of the fixture, so do not add one.
const AUTHORIZATION_SERVER = {
  authorization_endpoint: `${ORIGIN}/authorize`,
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  introspection_endpoint: `${ORIGIN}/introspect`,
  issuer: ORIGIN,
  jwks_uri: `${ORIGIN}/jwks.json`,
  registration_endpoint: `${ORIGIN}/register`,
  response_types_supported: ["code"],
  scopes_supported: ["email", "mcp:read", "mcp:write"],
  token_endpoint: `${ORIGIN}/token`,
  token_endpoint_auth_methods_supported: ["none"],
  userinfo_endpoint: `${ORIGIN}/userinfo`,
};

// Enterpret's documented tool list plus the three legacy aliases it still
// serves. No annotations, because none have ever been observed.
const TOOLS = [
  "get_organization_details", "get_graph_schema", "get_query_examples",
  "search_graph_fields", "search_graph_values", "run_graph_query",
  "find_user_quote", "get_schema", "execute_cypher_query",
  "search_knowledge_graph",
].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } }));

const requestLog = [];
const issuedCodes = new Set();
const issuedTokens = new Set();

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requestLog.push({
    at: new Date().toISOString(), method: req.method, path: url.pathname,
    headerKeys: Object.keys(req.headers).sort(),
    authorizationPresent: Boolean(req.headers.authorization),
  });

  if (url.pathname === "/__requests") return send(res, 200, requestLog);

  // Enterpret answers all three RFC 9728 forms with the same document.
  if (url.pathname === `${MCP_PATH}/.well-known/oauth-protected-resource`
    || url.pathname === `/.well-known/oauth-protected-resource${MCP_PATH}`
    || url.pathname === "/.well-known/oauth-protected-resource") {
    return send(res, 200, PROTECTED_RESOURCE);
  }
  if (url.pathname === "/.well-known/oauth-authorization-server"
    || url.pathname === "/.well-known/openid-configuration") {
    return send(res, 200, AUTHORIZATION_SERVER);
  }

  if (url.pathname === "/register" && req.method === "POST") {
    const body = JSON.parse(raw || "{}");
    return send(res, 201, {
      client_id: `mirror-client-${randomUUID()}`,
      redirect_uris: body.redirect_uris, grant_types: body.grant_types,
      response_types: body.response_types,
      token_endpoint_auth_method: body.token_endpoint_auth_method,
      client_name: body.client_name,
    });
  }

  // Stands in for the consent screen: no human, so it approves at once.
  if (url.pathname === "/authorize") {
    const code = `mirror-code-${randomUUID()}`;
    issuedCodes.add(code);
    const redirect = new URL(url.searchParams.get("redirect_uri"));
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
    redirect.searchParams.set("iss", ORIGIN);
    res.writeHead(302, { location: redirect.toString() });
    return res.end();
  }

  if (url.pathname === "/token" && req.method === "POST") {
    const body = new URLSearchParams(raw);
    if (body.get("grant_type") === "authorization_code" && !issuedCodes.has(body.get("code"))) {
      return send(res, 400, { error: "invalid_grant" });
    }
    const token = `mirror-access-${randomUUID()}`;
    issuedTokens.add(token);
    return send(res, 200, {
      access_token: token, refresh_token: `mirror-refresh-${randomUUID()}`,
      expires_in: 3600, token_type: "Bearer", scope: "mcp:read mcp:write",
    });
  }

  if (url.pathname === MCP_PATH) {
    const supplied = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!issuedTokens.has(supplied)) {
      return send(res, 401,
        { error: "invalid_token", error_description: "Missing or invalid access token" },
        { "www-authenticate": CHALLENGE });
    }
    const rpc = JSON.parse(raw || "{}");
    if (rpc.method === "initialize") {
      return send(res, 200, { jsonrpc: "2.0", id: rpc.id, result: {
        protocolVersion: "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "enterpret-shape-mirror", version: "1.0.0" } } });
    }
    if (rpc.method === "tools/list") {
      return send(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { tools: TOOLS } });
    }
    return send(res, 200, { jsonrpc: "2.0", id: rpc.id ?? null, result: {
      content: [{ type: "text", text: "mirror acknowledged. This server holds no data." }] } });
  }

  return send(res, 404, { error: "not_found" });
}).listen(port, "127.0.0.1", () => console.log(`mirror listening on ${MCP_URL}`));
```

The redaction check in scenario 9 works because the mirror prefixes its tokens
`mirror-access-` / `mirror-refresh-`: those prefixes are a synthetic canary that
can be grepped safely across the API and the instance tree.

## 7. Service involvement

Neither Paperclip ID nor Paperclip Connect participates. DCR is instance-local:
each instance registers its own public client at the vendor and uses its own
`/api/tools/oauth/callback`. Cloud and self-hosted use the same path; only the
hostname inside the redirect URI differs.
