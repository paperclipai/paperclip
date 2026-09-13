# Connecting any remote MCP server

Paperclip can connect a standards-compliant remote HTTP MCP server without a
Paperclip code change. A curated `AppDefinition` is a **convenience layer** —
branding, tailored fields, scoped defaults, support copy — not a prerequisite.

This is the documented baseline for connecting anything. Read
[Connection authoring runbook](./CONNECTOR-PLAYBOOK.md) when you want to add the branded
convenience layer on top for a vendor Paperclip should promote.

Accepted in the [generic remote MCP plan](/PAP/issues/PAP-17078#document-plan),
implemented in [PAP-17087](/PAP/issues/PAP-17087).

## The two routes

| Route | Where | Use it when |
| --- | --- | --- |
| Guided URL | **Apps → Connect an app → Connect your own MCP server** | You have the server's address. Paperclip probes it and walks you through whatever it needs. |
| Paste a config | **Advanced → Paste a config** | A README gave you an `mcpServers` snippet, or the server needs headers with names Paperclip could not guess. |

Both routes normalize through the same backend contract, so auth discovery,
secret handling, catalog refresh and review cannot diverge between them.

**Advanced → Run your own** is a separate, higher-trust path for local stdio
commands and is deliberately not covered here.

Don't know the address or the headers? The question-mark control beside
**Paste a config** gives you a request you can hand to an agent: it asks the
agent to consult the vendor's current documentation and reply with one
paste-ready `mcpServers` JSON object using credential *placeholders*, plus notes
on how to obtain each credential. Paste only the JSON block back into Paperclip;
Paperclip reads the header names from it and asks you for the values, which it
stores as Paperclip secrets.

## What the guided URL flow does

After you paste an address and press **Check link**, Paperclip probes the
endpoint and branches:

| Endpoint says | You get |
| --- | --- |
| Nothing needed | Discovered actions, straight to review. |
| Needs authorization, and publishes discoverable OAuth metadata | **Sign in to continue** — a browser sign-in at the provider. |
| Needs authorization, but no discoverable sign-in | A prompt to add the key or headers its docs list, under **Advanced authentication**. |
| Needs a client you registered yourself | A prompt for a client ID and secret. The draft connection is kept — you don't start over. |
| Not a valid address / private network / unreachable | The specific problem and which field to change. |

An unknown server is labelled **Unverified server** with its host shown, at every
step through review, access and install. Reads are enabled for review;
state-changing actions start off; newly discovered actions are quarantined until
reviewed. That is the same treatment a curated connection gets.

### Advanced authentication

Collapsed by default. Open it when the server's docs are specific:

- **No sign-in needed** — the server is open to anyone with the address.
- **Key or token** — sent as an `Authorization` header.
- **Custom headers** — for servers that name their own headers.
- **Browser sign-in** — optionally with a client ID and secret you registered
  yourself, for providers that require preregistration.

Every value you enter becomes a Paperclip secret. Values are write-only: they
never appear in stored config JSON, logs, activity details, API responses after
write, or UI readback. Only header *names* are shown in review and diagnostics.

Paperclip refuses to send header names it manages or that belong to the
transport — `Host`, `Cookie`, `Content-Length`, `Transfer-Encoding`,
hop-by-hop headers, and anything under `Proxy-*` or `Sec-*` — and rejects
values containing line breaks or control characters. This is enforced in shared
code (`packages/shared/src/mcp-remote-headers.ts`), checked at the API boundary,
and re-checked in the service immediately before the header is projected onto a
real request.

## How sign-in gets a client

You never choose this; Paperclip resolves it and the wizard shows none of it.
Recorded here for security review and diagnostics. In preference order:

1. **Deployment-preconfigured client.** `PAPERCLIP_TOOL_OAUTH_<PROVIDER>_CLIENT_ID`
   / `_SECRET`, or the unsuffixed `PAPERCLIP_TOOL_OAUTH_CLIENT_ID` / `_SECRET`.
   Always wins when set.
2. **Client ID Metadata Document (CIMD).** When the authorization server
   advertises `client_id_metadata_document_supported`, Paperclip presents the URL
   of its own published metadata document as the `client_id`. Nothing is
   registered. **Requires a public HTTPS base URL** (`PAPERCLIP_PUBLIC_URL`):
   the authorization server has to fetch that document server-to-server, so
   loopback and plain-HTTP deployments fall through to the next tier.
   The document is served unauthenticated at `/api/tools/oauth/client-metadata`
   and contains only this deployment's callback and the grant/response/auth
   methods Paperclip uses — no company, connection or secret data.
3. **Dynamic client registration (RFC 7591).** When the authorization server
   advertises a `registration_endpoint`. Paperclip registers a public client
   (`token_endpoint_auth_method: none`, `application_type: web`, PKCE S256).
4. **Manual preregistered client.** The client ID and secret you paste under
   **Advanced authentication → Browser sign-in**.

A generic connection may register (tiers 2 and 3) **only after** validated
protected-resource and authorization-server discovery actually produced a
metadata document, and only on an explicit operator connect action. An endpoint
that merely returns a 401 does not earn a registration.

### Client binding

Client material is bound to the authorization-server issuer, the MCP resource
URL, the callback URI, and the company. If any of those change:

- a Paperclip-minted client (CIMD or DCR) is **re-registered**;
- a client you supplied yourself is **not** — Paperclip stops and asks you to
  re-enter it, because it cannot register on your behalf in a console it does
  not control.

Credentials are never reused across issuers or across companies.

### Endpoint addresses are validated before they are used

Every OAuth endpoint address is chosen by the remote server — in discovered
metadata, in a `WWW-Authenticate` hint, in a pasted config, or in a gallery
default — and the authorization endpoint additionally becomes a top-level browser
navigation. All of them are parsed by one shared validator
(`checkOAuthEndpointUrl` in `@paperclipai/shared`) and must be:

- **`https:`.** Plain `http:` is refused, except for a loopback host under the
  local-development policy (the same policy that allows private remote
  endpoints), and except for this deployment's own origin.
- **Free of embedded credentials.** `https://accounts.google.com@evil.test/…`
  reads as the wrong site to a human, so Paperclip refuses it.
- **Free of a fragment**, and a well-formed absolute URL.

`javascript:`, `data:`, `file:` and friends are therefore refused before they can
reach `window.location`. The board applies the same validator to the address it
receives, so an unsafe value cannot pass the API boundary and then execute at the
navigation boundary. A refusal is reported as
`oauth_<kind>_endpoint_rejected` (422) and the unsafe value is never persisted on
the connection.

An address that passes is still only an address: a valid HTTPS authorization page
can be a phishing page. The redirect screen names the host you are being sent to,
and the **Unverified server** label stays visible for an endpoint with no curated
definition.

### Protocol conformance

- RFC 8707 `resource` on authorization, token, and refresh requests, naming the
  canonical MCP endpoint (origin + path, no query or fragment), so the
  authorization server can audience-restrict the token to that server.
- RFC 9728 protected-resource discovery, path-aware first
  (`/.well-known/oauth-protected-resource<path>`) then origin.
- RFC 8414 authorization-server discovery for issuers with a path, in the
  spec's insertion form (`/.well-known/oauth-authorization-server<path>`) and
  the widely deployed OIDC suffix form (`<path>/.well-known/...`). A metadata
  document whose `issuer` disagrees with the issuer used to build the discovery
  URL is discarded.
- RFC 9207 `iss` validated against the persisted expected issuer when the
  authorization server returns it. A mismatch refuses the code rather than
  exchanging it. An absent `iss` is tolerated — it is optional and widely
  omitted.
- PKCE S256, exact redirect/state binding, and SSRF/private-network and redirect
  limits are unchanged from the curated path.

The discovered auth kind, issuer, and resource are persisted on the connection,
so refresh, reconnect, revoke and diagnostics all use the generic path instead of
falling back to `authKind: none` semantics.

## Curated definitions remain optional

A curated definition matching a pasted endpoint is offered as a branded
shortcut beside the generic form — never instead of it. A definition adds labels,
logos, field validation, scoped defaults and support copy. It does **not** unlock
a separate execution capability, and it must not create a second connection or
change ownership.

The bespoke [PostHog connection](./POSTHOG.md) is the worked example: it is the
polished route for most users, and PostHog is also connectable generically
through this page with either a key or browser sign-in.

## Verifying

Deterministic coverage lives in
`server/src/__tests__/generic-mcp-connection.test.ts`, which stands up an
in-process MCP server plus authorization server. It needs no network and no
vendor credentials, and every case connects by URL without naming a gallery app.
A credentialed vendor smoke (for example live PostHog OAuth) may be recorded by
QA but is not required for deterministic verification.

### Opt-in generic Notion live smoke

`pnpm smoke:notion-generic-live` exercises the generic **Advanced → Paste a
config** route against `https://mcp.notion.com/mcp`. It is intentionally outside
the normal unit, browser, and CI-required suites. Run it only against an
already-running, browser-reachable HTTPS Paperclip instance with these bindings
provided by the execution environment:

- `PAPERCLIP_E2E_BASE_URL`, `PAPERCLIP_E2E_EMAIL`, and
  `PAPERCLIP_DEV_LOGIN_PASSWORD` for the target instance;
- `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_RUN_ID`, and
  `PAPERCLIP_TASK_ID` for the control plane;
- the approved on-demand secret binding
  `access.notion_generic_flow_test_account`, delivered by the agent secret API
  under its normalized key `generic-flow-test-account`, for the existing Notion
  test account.

If that account requires an emailed one-time code, also set `AGENTMAIL_API_KEY`
and `NOTION_AGENTMAIL_INBOX_ID` for the already-configured forwarding inbox. The
smoke loads the AgentMail SDK only after Notion presents the code challenge,
accepts only a fresh authenticated Notion message, fills the code once in
memory, and never records the message, address, or code.

Check the URL, health endpoint, and binding metadata without retrieving the
credential value or opening a browser:

```sh
pnpm smoke:notion-generic-live -- --dry-run
```

The live command retrieves the credential only after the safe preflight and
Paperclip login succeed. It disables trace, video, and HAR capture, takes only
post-callback screenshots, enables and invokes only `notion-get-self`, proves
`notion-create-pages` remains locally denied, and removes its uniquely named
connection in a `finally` cleanup. Its `summary.json` and PNG files contain
sanitized IDs, decisions, outcomes, and endpoint origins/paths only; they
default to `PAPERCLIP_RUN_SCRATCH_DIR`, or to `NOTION_EVIDENCE_DIR` when set.

Run the credential-free harness checks with:

```sh
node --test scripts/smoke/notion-generic-live.test.mjs
```
