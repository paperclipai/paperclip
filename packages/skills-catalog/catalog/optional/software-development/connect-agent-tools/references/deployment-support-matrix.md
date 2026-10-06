# Deployment support matrix — self-hosted first

Paperclip runs as open-source software you host yourself, and as Paperclip
Cloud. **The self-hosted path is the primary one in this skill.** Nothing in the
documented workflow below requires a Cloud account, a managed Cloud OAuth
client, or any Paperclip-operated infrastructure.

Fill in a copy of this matrix for your own deployment before you claim that a
connector works. Do not copy the labels from this page into a report: they
record what has been established *here*, at the commits named below, and a
deployment you have not exercised is `untested` no matter what this file says.

## The four labels

Use exactly these, and never substitute one for another:

| Label | Means | Requires |
| --- | --- | --- |
| `verified` | Exercised on this deployment and the evidence is recorded. | A command, a run ID, or a provider-side artifact — with date, deployment mode, and commit. |
| `untested` | The path exists in source and is expected to work, but nobody ran it here. | The file:line or document you read, and the reason it was not exercised. |
| `unsupported` | The product refuses it on this deployment. | The guard that refuses it, quoted or cited by file:line. |
| `deferred` | Deliberately out of scope for now. | A reason and a named owner for the follow-up. |

`untested` is not a soft `verified`. A green test suite, a **Connected** badge,
a catalog card, and a successful board **Test** call are all compatible with a
connector no agent can actually use. Source-confirmed behaviour is `untested`
until someone runs it. The board **Test** call in particular is not evidence of
an agent's permissions — see **F2** below, where it returns `allowed` for an
agent whose own policy denies the call.

## Establish your deployment first

Two independent settings decide almost everything below. Read them from your own
instance's configuration, not from a product tier name.

| Setting | Env var | Values | Default |
| --- | --- | --- | --- |
| Deployment mode | `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted`, `authenticated` | `local_trusted` |
| Exposure | `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private`, `public` | `private` |

Source: `packages/shared/src/constants.ts` and `server/src/config.ts`
at Paperclip App commit `9335b7db10`. Both are also settable as
`config.server.deploymentMode` / `config.server.exposure` in the instance's
`config.json`, which is what `config.ts` reads after the environment.

One consequence is easy to miss and worth writing down, because it is what makes
the same-machine self-hosted path so capable:

> `local_trusted` **forces** exposure to `private`. `deploymentExposure` in
  `server/src/config.ts`
> ignores `PAPERCLIP_DEPLOYMENT_EXPOSURE` when the mode is `local_trusted`.

So a same-machine self-hosted instance can never land in the
`authenticated` + `public` combination that the private-endpoint guard refuses.

Three deployment shapes follow from this. Name yours before step 3 of the skill:

| Shape | Typical config | What it is |
| --- | --- | --- |
| **A. Self-hosted, same machine** | `local_trusted` (⇒ `private`) | Paperclip on your laptop or workstation, alongside the tools it drives. |
| **B. Self-hosted, server or VPS** | `authenticated` + `private` or `public` | Paperclip on a box you control, reached over your network or the public internet. |
| **C. Paperclip Cloud** | hosted, `authenticated` + `public` | Paperclip runs in Paperclip's hosted environment. |

Shape B splits further on one axis that matters more than exposure: whether the
instance has a **public HTTPS origin**. A VPS on a tailnet with private HTTPS is
a different case from one on a public domain, and the difference decides CIMD
and inbound chat callbacks — not OAuth in general.

### Shape B has two hard prerequisites that are easy to discover the hard way

Both were hit while filling this matrix, on `authenticated` + `public`:

1. **No embedded database.** Startup refuses:
   `authenticated public deployments require DATABASE_URL or
   config.database.connectionString; refusing embedded PostgreSQL fallback`.
   A public self-hosted instance needs an external PostgreSQL.
2. **An explicit, resolvable public base URL.** `auth.baseUrlMode` must be
   explicit and `auth.publicBaseUrl` is required
   (`packages/shared/src/config-schema.ts`). This value is not only
   browser-facing: the runtime hands it to spawned agents as their control-plane
   URL, so it must resolve **from the machine the runtime runs on**, not just
   from your browser. A placeholder hostname produces `getaddrinfo ENOTFOUND` on
   every MCP server and every API call in the agent's run, which reads exactly
   like a broken connector.

Also on shape B: `POST /api/bootstrap/claim` returns
`404 Browser first-admin claim is not available` unless exposure is `private`,
and a merely signed-up user is not an instance admin. Claim the admin while the
instance is `private`, then restart it as `public`. Changing `auth.publicBaseUrl`
invalidates existing board sessions.

## How this matrix was filled

Executed 19 September 2026 against Paperclip App commit
`9335b7db10425277bcb84ba8137d08c498324dba` on **two isolated instances started
for the purpose** — shape A (`local_trusted`, embedded PostgreSQL, loopback
`127.0.0.1:3810`) and shape B (`authenticated`, external PostgreSQL, run as both
`private` and `public`). Providers: a disposable loopback MCP notes server
written for the test, and DeepWiki (`https://mcp.deepwiki.com/mcp`), a real
third-party public server with `auth: "none"`.

**No Cloud instance was reachable.** Every Cloud cell below is `untested` or
`unsupported`, and none of it is inferred from a self-hosted result. The same
honesty runs in reverse: a shape-A pass is not shape-B evidence.

Full reproduction — instance configuration, the disposable provider, all nine
runbook scenarios with their commands and observed output, the correlated run
ids, the provider-side artifact, and every finding below in detail — ships in
this package: [`verification-log.md`](./verification-log.md).

## Matrix

### Transport and reachability

| Capability | A. Self-hosted, same machine | B. Self-hosted, server/VPS | C. Paperclip Cloud | Evidence |
| --- | --- | --- | --- | --- |
| `mcp_remote` to a public provider endpoint | `untested` | **`verified`** on `authenticated` + `public` | `untested` | B: DeepWiki connected, catalog refreshed to 3 tools, `read_wiki_structure` executed through the gateway, `decision: allowed`. |
| `mcp_remote` to a loopback endpoint (`127.0.0.1`) | **`verified`** | **`verified`** on `private`; **`unsupported`** on `public` | `unsupported` | A: connected, `healthStatus ok`, 7 tools, real agent runs against it. B `public`: `HTTP 400 {"code":"remote_http_private_endpoint"}` on connect, `HTTP 502` on refresh. Guard: `allowPrivateRemoteEndpoints`, `server/src/services/tool-access.ts`. |
| `mcp_remote` to a link-local address | `untested` | `untested` | `untested` | `isAlwaysDeniedLinkLocalIp` in `server/src/services/remote-http-endpoint-guard.ts` denies in every mode. Source-cited only; no live call was made. |
| `local_stdio` with an approved template | `untested` — instance declares it **supported** | `untested` — instance declares it **unsupported** in both exposures | `untested` | The live `supportMatrix` differs by shape (blocks quoted in the verification report). No stdio connection was created, so the capability itself is untested everywhere. |
| `rest_api` through the connected MCP gateway | `untested` | `untested` | `untested` | Not exposed through the gateway; needs an execution adapter. Runbook "Transport support and boundaries". |

**The self-hosted advantage is real and worth stating plainly:** shape A reaches
desktop apps, local files, and private-network services that Cloud cannot reach
from a hosted runtime, and the loopback row above is the executed proof. That is
not a Cloud defect, and it is not something to engineer around with a tunnel.
Pick the shape that matches the provider.

### Authentication

| Capability | A. Same machine | B. Server/VPS | C. Cloud | Evidence |
| --- | --- | --- | --- | --- |
| `auth: "none"` remote MCP | **`verified`** | **`verified`** (both exposures) | `untested` | Connect → catalog → gateway execution on both instances. |
| API key / PAT in a header | **`verified`** | `untested` | `untested` | A: connection with `credentialRefs: [{placement: "header", key: "x-api-key", secretId}]`; the provider's request log shows the header arrived, and the value appears nowhere in Paperclip (see redaction row). |
| OAuth via dynamic client registration (RFC 7591) | `untested` | `untested` | `untested` | **DCR is instance-local.** Each instance registers its own public client against its own `/api/tools/oauth/callback`. "Cloud-hosted and self-hosted instances use the SAME path — the only per-instance difference is the hostname inside the redirect URI." `CONNECTOR-PLAYBOOK.md`, **Dynamic client registration (RFC 7591)**. Consent needs an authorized provider account; not exercised. |
| OAuth via CIMD | `untested`; falls through to DCR on loopback/plain HTTP | `untested` with a public HTTPS origin; falls through without one | `untested` | CIMD "requires a public HTTPS base URL … the authorization server has to fetch that document server-to-server, so loopback and plain-HTTP deployments fall through to the next tier." `GENERIC-REMOTE-MCP.md:94-104`. Neither test instance had a public HTTPS origin. |
| OAuth with a client you registered yourself | `untested` | `untested` | `untested` | Deployment-preconfigured `PAPERCLIP_TOOL_OAUTH_<PROVIDER>_CLIENT_ID` / `_SECRET` outranks every other tier — `safeOAuthEndpointUrl` in `server/src/services/tool-access.ts`. Not exercised. |
| OAuth redirect from a plain-HTTP non-loopback origin | n/a — loopback is HTTP-allowed | **`unsupported`** for `https-or-loopback-http` providers | n/a — Cloud is HTTPS | Fails fast with `oauth_redirect_origin_unsupported`; configure TLS. `CONNECTOR-PLAYBOOK.md`, **Redirect-URI constraints**. |
| Provider-generated secret-bearing URL | `untested` | `untested` | `untested` | Generic runtime path is complete. Treat the URL as a credential. |
| Paperclip-managed OAuth (`platform_shared`) | **`unsupported`** | **`unsupported`** | `untested` | Requires a reviewed Cloud connector profile and Cloud's fixed provider callback. `CONNECTOR-PLAYBOOK.md`, **Authentication support matrix**. |

**No Cloud account is required for self-hosted OAuth.** The playbook is explicit
that DCR needs neither Paperclip ID nor Paperclip Connect, and that
`id.paperclip.ing` authenticates operators only and never holds resource tokens.
Only the curated `platform_shared` profile is genuinely Cloud-gated, and it is
one row of this table, not the default path. Note that the whole OAuth block is
`untested` on every shape: it is source-confirmed, not exercised.

### Lifecycle

| Capability | A. Same machine | B. Server/VPS | C. Cloud | Evidence |
| --- | --- | --- | --- | --- |
| Connect by URL, no code change | **`verified`** | **`verified`** | `untested` | `POST …/tools/apps/connect` with a pasted link, then `/finish`. No catalog entry authored; `CONNECTOR-PLAYBOOK.md` (opening section, grep `Connect your own MCP server`) says none is needed, and none was. |
| Catalog discovery and risk classification | **`verified`** | **`verified`** | `untested` | A: `read` / `write` / `destructive` assigned correctly across 7 tools with no manual input. |
| Effective policy on the acting agent | **`verified`** | **`verified`** | `untested` | A: `allowedToolNames` moved `[] → [list_notes, read_note] → +create_note` as entries were added; an ungranted agent stayed `[]`. |
| Narrow read through the gateway | **`verified`** | **`verified`** | `untested` | A: two agent runs. B: DeepWiki `read_wiki_structure`. |
| Authorized write through the gateway, disposable resource | **`verified`** | `untested` | `untested` | A only. B's provider is read-only and no write was authorized there. |
| A real agent run correlated to its run ID | **`verified`** | **`verified`** | `untested` | A: runs `af9afa19…`, `135b2654…`. B: run `f027aa16…`, `allow / succeeded`. |
| Provider-side readback of the artifact | **`verified`** | n/a — read-only provider | `untested` | A: the note file on the provider's own store names the run that created it, and that run ID matches the gateway invocation. |
| Denied execution for an ungranted actor | **`verified`** on the agent path | **`verified`** for an unselected tool | `untested` | A: `deny / deny_default`; the write tool was absent from the granted agent's session and the attempted call never reached the provider. **Does not hold on the board Test path — see F2.** |
| Recoverable provider failure and recovery | **`verified`** | `untested` | `untested` | A: provider stopped → `healthStatus error`, `HTTP 502`; restarted → `ok`, no duplicate connection. |
| Catalog refresh after the provider changes | **`verified`, adverse** | `untested` | `untested` | A: three refreshes, each discovering a new tool — and auto-allowing it. **See F1.** |
| Revoke, then reconnect | **`verified`** | `untested` | `untested` | A: grant revoked → `organization_authorization_required`; connection disabled → `deny / deny_disabled_connection`; grant re-added → succeeds on the same connection ID. |
| Redaction of stored credentials | **`verified`** | `untested` | `untested` | A: 0 occurrences of the test credential across 1358 text/JSON columns, the whole instance tree, and five API surfaces — while the provider confirmed the header arrived. |

### Operator verification surfaces

| Capability | Self-hosted, your own instance | Evidence |
| --- | --- | --- |
| `GET /api/companies/:companyId/tools/runtime-health` returns the live `supportMatrix` | **`verified`** for a board actor | Read on both instances; both `supportMatrix` blocks are quoted in the verification report. |
| `GET …/tools/gallery`, `…/tools/connections` | **`verified`** for a board actor | Both returned data to the board actor on the owning instance. |

**Who you are decides whether you can read this.** A run-scoped *agent* JWT gets
`403 {"error":"Board access required"}` on all three routes — executed
19 September 2026 against an instance the agent does not administer. A **board
actor on an instance you own reads them fine.** So: an agent cannot read its own
deployment's support matrix and must ask the operator to paste the
`supportMatrix` block, but an operator is never blocked from it. Do not infer
deployment capability from a product name, a URL someone pasted in a browser, or
the absence of an error.

### Chat and email

Every cell is `untested`: no chat or email provider was connected in the
verification pass. Inbound chat is the one place where a public HTTPS origin is a
hard prerequisite rather than a preference, and it depends on the provider's
delivery mechanism, not on Paperclip's tier.

| Capability | A. Same machine | B. Server/VPS | C. Cloud | Evidence |
| --- | --- | --- | --- | --- |
| Inbound delivery by public HTTPS callback | **`unsupported`** without a public origin | `untested` with a public HTTPS origin; `unsupported` without | `untested` | "For a public callback, distinguish having HTTPS from being reachable by the provider. A private-network HTTPS URL alone is not proof of public reachability." `CHAT-CONNECTOR-UX.md:77-79`. |
| Inbound delivery by outbound socket or polling | `untested` | `untested` | `untested` | Provider-dependent. Establish the mechanism before asserting a prerequisite — `CHAT-CONNECTOR-UX.md:18-22`. |
| Personal identity linking, membership approval | `untested` | `untested` | `untested` | Separate from resource setup; see `references/chat-and-email.md`. |

A self-hoster without a public origin is not out of options: choose a provider
whose inbound path is a socket or polling, or put the instance behind a real
public HTTPS origin. Do not tell them Cloud is the only answer, and do not embed
a server tutorial in the wizard — link maintained setup documentation
(`CHAT-CONNECTOR-UX.md:81-84`).

## Three findings that change what you should tell an operator

These are reproducible product behaviours at commit `9335b7db10`, not advice.
Until they change, the skill's guidance has to account for them. Each one below
has its executed reproduction and a suggested fix in
[`verification-log.md`](./verification-log.md) §4, along with six further
findings that do not change the advice.

### F1 — a pasted MCP server can widen its own permissions after approval

On every catalog refresh, newly discovered entries are added to the
connection's active managed profile unless `quarantineNewEntries` is set — and
for a **user-pasted URL** it is explicitly set to `false`
(`server/src/services/tool-access.ts`, grep `unverifiedServer: true`, in the
same expression that flags the connection `unverifiedServer: true`). Curated
gallery apps and Paperclip-managed cloud connectors *do* quarantine. The
least-trusted class does not.

Executed: a connection finished with exactly two tools enabled and access limited
to one agent. The provider then advertised `export_notes`, which returns every
note body in one response. After one refresh, with no operator action:
`policy test ⇒ allow / allow_profile`, `new-tools review queue: pendingCount 0`.
Risk tier does not gate it either — a newly advertised `delete_note`, correctly
classified `destructive`, was also auto-allowed.

**What this means for the skill's advice.** "Start writes at Off and promote
deliberately" is not durable on this build: the server decides. If you paste a
URL you do not control, re-check the effective profile after every refresh, and
treat the connection's tool set as provider-controlled rather than
operator-controlled.

### F2 — the board "Test as agent" call runs with the board's authority

`executeTestCall` builds a session with `actorType: "user"` and the board user's
ID. Agent tool profiles bind to agents, so the board user is not subject to them.

Executed: testing as an **ungranted** agent returned
`HTTP 200 {"decision":"allowed"}` and the read succeeded. Testing `create_note`
as an agent whose policy denied it returned `allowed` — **and the file was
created on the provider.** The policy simulator, asked the same questions with
`actorType: "agent"`, answers correctly.

**What this means for the skill's advice.** A board Test call is not evidence
about an agent, in either direction: it can pass where the agent would be denied,
and it can perform a write the agent's own policy forbids. Use the policy
simulator (`POST /api/companies/{c}/tools/policy/test` with `actorType: "agent"`)
for permission questions, and a real agent run for execution questions.

### F10 — the connect wizard grants the policy but not the install

`POST …/tools/apps/{id}/finish` with `access: {agentIds: [...]}` creates the
tool-profile binding but **no `tool_connection_install` row**. Agent readiness
requires both (the `usable` predicate in
`server/src/services/connection-intents.ts`), so the tool never enters the
agent's session. Both wizard-created connections, on both instances, showed
`installs: []` alongside a correct `allowedToolNames`. The board's access view
showed the tool allowed and the connection green; the agent got
`needs_user_action` and could not run.

**What this means for the skill's advice.** After finishing the wizard, check
`GET /api/tool-connections/{id}/installs` — not just the effective profile.
`PUT …/installs` is the one-call fix. This is exactly the "Connected badge, agent
still cannot do the job" failure the skill names in **Use This When**, reproduced
on the path the skill recommends.

## Deferred

| Item | Reason | Owner |
| --- | --- | --- |
| Cloud parity for every row above | No Cloud instance was reachable, and the self-hosted-first priority defers it | Operator with a Cloud instance, after self-hosted |
| OAuth (DCR / CIMD / own client) on any shape | Needs an authorized provider account | Operator with a provider account |
| `local_stdio` execution | The live `supportMatrix` says shape A supports it, which is not the same as running it | Unclaimed. Needs a shape-A operator to create one `local_stdio` connection from an approved template and run a gateway call through it. Everything needed is in [`verification-log.md`](./verification-log.md) §1 and §3; swap the transport. |
| Chat and email inbound delivery | Out of scope for the first pass | Unclaimed. Needs an operator with a chat provider and a decision on inbound mechanism — see [`chat-and-email.md`](./chat-and-email.md) for the questions to settle first. |
| Shape-B write execution and provider-side readback | The shape-B provider is read-only | Operator with a writable third-party provider |
| Link-local denial | Source-cited only; no live call | Low priority — the guard is unconditional |

## Source commits

| Source | Revision | Read |
| --- | --- | --- |
| Paperclip App | `9335b7db10` on `master` | 19 September 2026 |
| `doc/connections/CONNECTOR-PLAYBOOK.md`, `doc/connections/CHAT-CONNECTOR-UX.md` | merged by PR #13675 at `c9e867797939fe069278c4ae660f86f7692ed866` | 19 September 2026 |

Re-read these before relying on a line number. The runbook moved 214 lines in
PR #13675 alone; if a citation disagrees with the commit in front of you, the
commit wins and you record the drift.
