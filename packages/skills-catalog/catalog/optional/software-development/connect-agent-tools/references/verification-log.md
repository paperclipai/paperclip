# Verification log — how the support matrix was filled

This is the evidence behind
[`deployment-support-matrix.md`](./deployment-support-matrix.md). Every
`verified` label in that file traces to a run recorded here.

Executed 19 September 2026 against Paperclip App commit
`9335b7db10425277bcb84ba8137d08c498324dba`, on **two disposable self-hosted
instances started for this pass and torn down afterwards**. No Cloud instance
was in reach. No third-party account was used beyond one public read-only
server. Nothing was installed, released, or written to anyone else's data.

The point of shipping this inside the package is that you can redo it. The
instance shapes, the disposable provider, and every command below are
reproducible on a laptop in well under an hour, with no Paperclip account and no
credential you do not already hold.

Run ids and connection ids appear truncated. They are here so you can see that
correlation between an agent run and a gateway invocation was actually
demonstrated, not to be looked up — they belong to instances that no longer
exist. No credential value, secret, private log, or account identifier appears
anywhere in this file.

## 1. The two instances

Read from each instance's `config.json` and confirmed against its live
`/api/health`. Neither instance had `PAPERCLIP_DEPLOYMENT_MODE`,
`PAPERCLIP_DEPLOYMENT_EXPOSURE`, or `PAPERCLIP_PUBLIC_URL` set in the
environment; the equivalent `config.json` keys are the source, which is what
`server/src/config.ts` reads after the environment.

| | **Instance A — shape A** | **Instance B — shape B** |
| --- | --- | --- |
| Deployment mode | `config.server.deploymentMode = local_trusted` | `config.server.deploymentMode = authenticated` |
| Exposure | **forced** `private` by `deploymentExposure` in `config.ts` | run as `private` **and** `public` |
| Public base URL | not set, not needed | `auth.publicBaseUrl` set and mandatory — see F7 |
| Bind | loopback `127.0.0.1:3810` | loopback `127.0.0.1:3820` |
| Database | embedded PostgreSQL | **external** PostgreSQL — embedded is refused, see F7 |
| Health `commit` | `9335b7db10…` | same |

`GET /api/companies/{companyId}/tools/runtime-health` → `supportMatrix`, read
with board access on each instance:

**Instance A, `local_trusted` (⇒ `private`):**

```json
{
  "remoteHttp": {
    "supported": true,
    "note": "mcp_remote MCP connections are supported in hosted cloud and local deployments."
  },
  "localStdio": {
    "supported": true,
    "note": "local_stdio is available for local trusted mode or through the configured trusted MCP runtime host."
  }
}
```

**Instance B, `authenticated` + `private`:**

```json
{
  "remoteHttp": {
    "supported": true,
    "note": "mcp_remote MCP connections are supported in hosted cloud and local deployments."
  },
  "localStdio": {
    "supported": false,
    "note": "local_stdio should stay disabled for authenticated/private; use mcp_remote or configure a trusted runtime worker."
  }
}
```

**Instance B, `authenticated` + `public`:** identical to the private block, with
the `authenticated/public` wording. The `supportMatrix` does **not** narrow for
public exposure; the private-endpoint refusal happens at connect time, not here.

## 2. The providers, and why these two

1. **A disposable loopback MCP server with `auth: "none"`** — a small "notes"
   server written for this pass, streamable HTTP on `http://127.0.0.1:38111/mcp`,
   storing notes in a scratch directory.

   Two reasons. `auth: "none"` means a real agent run needs no OAuth consent and
   no credential the tester is not authorized to hold. And a loopback endpoint
   is the one class a `local_trusted` instance may reach and Cloud may not, so
   it is the case that proves the most about the self-hosted column. It also
   makes an authorized write safe: the write target is a scratch directory, with
   no third-party account anywhere near it.

2. **DeepWiki (`https://mcp.deepwiki.com/mcp`), a real third-party public
   provider with `auth: "none"`.** Used on instance B so the public-endpoint row
   is proved against something outside the machine rather than by analogy.
   Read-only; nothing was written to it.

3. **Not used: an OAuth provider.** Completing consent needs an authorized
   account on that provider. The unauthenticated metadata probe in the skill's
   quickstart is current; the consent half stays `untested`.

No catalog definition was authored. `CONNECTOR-PLAYBOOK.md` (opening section,
grep `Connect your own MCP server`) says the pasted-URL path needs no code
change, and it did not.

### Provider evidence record

| Item | Disposable notes | DeepWiki |
| --- | --- | --- |
| Endpoint | `http://127.0.0.1:38111/mcp` | `https://mcp.deepwiki.com/mcp` |
| Unauthenticated `initialize` | `HTTP 200`, `protocolVersion 2025-06-18`, `serverInfo disposable-notes/1.0.0` | `HTTP/2 200`, `serverInfo DeepWiki 2.14.3` |
| Auth | none | none |
| Registration / PKCE | n/a — no OAuth challenge | n/a — no OAuth challenge |
| Prerequisites | the server process running on the same host | public egress |
| Revocation | stop the process, delete the connection | delete the connection |
| Date read | 19 September 2026 | 19 September 2026 |

## 3. The nine production-validation scenarios

These are the runbook's scenarios (`doc/connections/CONNECTOR-PLAYBOOK.md`,
**Step 9: Align With Production Validation**). Environment for every row
unless stated otherwise: **instance A**, `local_trusted` + `private`, commit
`9335b7db10`, method key `connect-your-own-mcp-server` (pasted URL, `authMode:
none`).

### 1. Setup and consent — pass

- **Reproduce.** `POST /api/companies/{c}/tools/mcp/import-json` with a standard
  `mcpServers` block → one draft, `transport: mcp_remote`, no warnings. Then
  `POST /api/companies/{c}/tools/apps/connect` with `{link, name, authMode: "none"}`
  → draft connection, `enabled: false`, `config.unverifiedServer: true`. Then
  `POST …/tools/apps/{id}/finish` with explicit `enabledCatalogEntryIds`,
  `askFirstCatalogEntryIds` and `access.agentIds`.
- **Expected.** The no-code path completes with no code change, and access is not
  granted until the operator finishes the wizard.
- **Actual.** Exactly that. `finish` is where consent is expressed: it refuses an
  empty body, and the draft grants nothing until it is called.
- **Evidence.** Connection `f79c1799…` ended `status: active, enabled: true,
  healthStatus: ok`; activity rows `tool_app.connected` then `tool_app.finished`
  carrying `access: {agentIds: [...]}`.

### 2. Authentication — pass, for the two shapes exercised

- **Reproduce.** (a) an `authKind: "none"` connection, health-checked.
  (b) an `authKind: "api_key"` connection with
  `credentialRefs: [{placement: "header", key: "x-api-key", secretId}]`, where the
  secret is a synthetic string created through `POST /api/companies/{c}/secrets`
  and never printed.
- **Expected.** The credential reaches the provider as a header and is never
  stored or echoed in clear.
- **Actual.** The provider's own request log records the inbound request with
  `credentialHeaderKeys: ["x-api-key"]`, and the health check returned `ok`.
- **Not covered.** No OAuth path was exercised. That is `untested`, not passed.
- **Evidence.** Connection `9736bf6d…`; the redaction scan is scenario 9.

### 3. Catalog and configuration — pass, with an adverse finding

- **Reproduce.** `POST /api/tool-connections/{id}/catalog/refresh`, then read
  `…/catalog` and the effective profile.
- **Expected.** Discovery returns the reviewed actions with correct risk
  annotations, and selected access persists.
- **Actual, good half.** All 7 tools discovered. Risk classification is correct
  and automatic: `list_notes`, `read_note`, `count_notes`, `note_stats` and
  `export_notes` = `read`; `create_note` = `write`; `delete_note` =
  `destructive, isDestructive: true`. Selections persisted across refreshes: a
  tool whose profile entry was removed stayed off.
- **Actual, adverse half.** See **F1**: a tool the provider adds *after* approval
  is auto-allowed on the next refresh.
- **Evidence.** Activity rows
  `tool_connection.catalog_refresh {discoveredCount: 5|6|7, quarantinedCount: 0}`.

### 4. Allowed execution — pass

- **Reproduce.** Narrow read: an agent run calling `list-notes` and `read-note`.
  Authorized write: `create_note` against the disposable store, promoted into the
  profile deliberately after the denial case was recorded.
- **Expected.** The read succeeds through the gateway; the write follows the
  effective policy.
- **Actual.** Both succeeded — `policyDecision: allow`, `reasonCode: allow_profile`,
  `status: succeeded`, with argument and result hashes recorded.
- **Evidence.** Invocation `38fa28e0…` (`read-note`, run `af9afa19…`) and the
  three invocations of run `135b2654…`.

### 5. Denied execution — pass on the agent path, fail on the board Test path

- **Reproduce.** The policy simulator
  (`POST /api/companies/{c}/tools/policy/test`) for four actor/tool pairs, plus
  live agent execution, plus the board test-call endpoint.
- **Expected.** Ungranted actors and unselected tools cannot execute, and a tool
  the policy hides does not appear in the listing.
- **Actual, agent path — correct.**

  | Actor | Tool | Decision |
  | --- | --- | --- |
  | granted agent | `list_notes` | `allow / allow_profile` |
  | granted agent | `create_note`, before promotion | `deny / deny_default` |
  | ungranted agent | `list_notes` | `deny / deny_default` |
  | granted agent, disabled connection | `list_notes` | `deny / deny_disabled_connection` |

  Hiding works too. In run `af9afa19…` the agent searched its session for both
  `create-note` and `create_note`, found neither, attempted the call anyway, and
  got `No such tool available` — a local dispatch failure, with **no request
  reaching the provider**, confirmed in the provider's request log.

- **Actual, board Test path — fails the scenario.** See **F2**.

### 6. Runtime delivery — pass on both instances

- **Reproduce.** Create an issue, assign it to the agent that has the connection
  installed, let the scheduler start a heartbeat run, then correlate
  `GET /api/companies/{c}/tools/runs/{runId}/decisions`.
- **Expected.** A real agent run's gateway call succeeds and correlates to the run.
- **Actual.** Two real runs on instance A, both `succeeded`:

  | Run | Calls | Result |
  | --- | --- | --- |
  | `af9afa19…` | `list-notes`, `read-note` | allowed; `create-note` absent from the session |
  | `135b2654…` | `create-note`, `read-note`, `list-notes` | all allowed |

  The tool namespace the agent used was
  `mcp__paperclip-assigned__mcp_disposable-notes-…_*` — the managed connection,
  not a side channel.

- **Provider-side readback.** Read from the provider's own store, not through
  Paperclip. The note file written by the agent contains:

  ```text
  Written by Notes Runner during connector verification.
  Heartbeat run id: 135b2654-…
  ```

  The artifact names the run that created it, and that run id matches the gateway
  invocation for `create-note`. That correlation is the whole proof: the agent,
  not the tester, did the work, and it went through the managed connection.

- **Instance B, `authenticated` + `public`.** Run `f027aa16…`, `succeeded`,
  one correlated invocation: `mcp.app-gallery-link-…:read-wiki-structure |
  allow | succeeded | args {"repoName": "paperclipai/paperclip"}`. The agent
  reported DeepWiki's 13 top-level sections verbatim, and separately attempted
  `read_wiki_contents` — the tool it was *not* granted at `finish` — which
  failed at local dispatch with no request reaching DeepWiki. So shape B has
  an allowed agent execution and a hidden-tool denial in the same run, against
  a real third-party provider. No provider-side readback there: DeepWiki is
  read-only.
- **It took three shape-B runs to get there, and both failures were findings
  rather than flakes.** Run 1 failed on `ENOTFOUND` because the mandatory
  `auth.publicBaseUrl` is also what the runtime hands spawned agents as their
  control-plane URL (**F8b**). Run 2 failed because the wizard had granted the
  policy but not the install (**F10**). Both agents refused to fabricate a result
  and reported the blocker accurately, which is why the failures were
  diagnosable.

### 7. Refresh and recovery — pass on recovery, fail on refresh

- **Reproduce.** Stop the provider → health-check → gateway call. Restart →
  health-check → refresh.
- **Expected.** Failures are recoverable, identity and policy survive, no
  duplicate connection.
- **Actual.** Down: `healthStatus: error`, `healthMessage: "fetch failed"`,
  `HTTP 502 {"code": "runtime_error"}`. Up: `healthStatus: ok` on the next check,
  same connection id, grants and profile intact, connection count unchanged.
  Refresh itself carries **F1**; the down-state gateway error carries **F3**.

### 8. Revoke and reconnect — pass, with a reporting gap

- **Reproduce.** `DELETE /api/tool-connections/{id}/grants/{grantId}` → policy
  simulator and a live gateway call. Then
  `POST …/grants/installations {"isDefault": true}` → a live gateway call.
- **Expected.** Revocation blocks later execution; reconnect reuses the intended
  identity.
- **Actual.** After revocation the gateway refuses: `{"error": {"message":
  "Organization authorization is required", "reasonCode":
  "organization_authorization_required"}}`, logged as `call_failed`. Disabling
  the connection refuses earlier, at policy: `deny /
  deny_disabled_connection`. After re-adding the installation the same read
  succeeds again, on the same connection id, with a new grant id and no
  duplicate connection. The gap is **F4**.

### 9. Activity and secret handling — pass

- **Reproduce.** Read `…/tool-connections/{id}/activity` and
  `…/companies/{c}/activity`. Then scan for the synthetic header value across the
  database, the instance file tree, and the API.
- **Actual, activity.** 20 connection events and 49 company `tool_*` rows, each
  carrying actor type, decision, reason code, tool, risk, and run/issue
  correlation — for example `policy_decision | allow | allow_profile |
  mcp.disposable-notes-…:read-note | agent` paired with
  `call_completed | tool_completed`, and
  `call_failed | deny | organization_authorization_required` for the
  revoked-grant attempt.
- **Actual, redaction.**

  | Surface scanned | Occurrences of the secret value |
  | --- | --- |
  | Instance database, all 1358 `text` / `varchar` / `json` / `jsonb` columns | **0** |
  | Whole instance tree — config, `.env`, logs, run logs, storage, backups | **0** |
  | `GET …/tools/connections`, `GET /tool-connections/{id}`, `GET …/secrets`, `GET …/activity?limit=50`, `GET …/tool-connections/{id}/activity` | **0** |
  | Provider-side request log | **0** — the header key is recorded, the value never is |

  The value was nonetheless delivered: the provider recorded the inbound
  `x-api-key` header on the health check. Stored encrypted, projected at call
  time, never echoed.

## 4. Findings

Reproducible product behaviour at commit `9335b7db10`, not advice. F1, F2 and
F10 are the three that change what this skill is allowed to tell you; they are
restated in
[`deployment-support-matrix.md`](./deployment-support-matrix.md) so you meet
them at the step where they bite. The rest are recorded here only.

### F1 — a pasted MCP server can widen its own permissions after approval

On every catalog refresh, newly discovered entries join the connection's
active managed profile unless `quarantineNewEntries` is set — and for a
**user-pasted URL** it is explicitly set to `false`, in the same expression
that flags the connection `unverifiedServer: true`
(`server/src/services/tool-access.ts`, grep `unverifiedServer: true`). Curated
gallery apps and Paperclip-managed cloud connectors *do* quarantine. The
least-trusted class does not.

**Executed, on the recommended wizard path.** A connection was finished with
exactly two tools enabled (`list_notes` allowed, `create_note` ask-first) and
access limited to one agent. The provider then advertised `export_notes`, which
returns every note body in one response. After one `catalog/refresh`, with no
operator action:

```text
policy test: granted agent → export_notes  ⇒  allow / allow_profile
new-tools review queue: {"pendingCount": 0, "tools": []}
```

**Executed proof that risk tier does not gate it.** On a second connection, a
deliberately partial profile — 3 of 4 tools allowed, the write removed — was
refreshed after the provider advertised `delete_note`. Paperclip classified it
correctly as `riskLevel: destructive, isDestructive: true`, and then allowed it:
`allow / allow_profile`, `newToolsPendingCount: 0`.

**Suggested fix.** Default `quarantineNewEntries: true` for
`unverifiedServer: true` connections, so new entries land in the existing
new-tools review queue instead of the allow list. The queue, the
`newToolsPendingCount` field and the review endpoint all exist already; only the
default is wrong. A narrower version: quarantine any new entry classified
`write` or `destructive`, whatever the connection class.

### F2 — the board "Test as agent" call runs with the board's authority

`executeTestCall` builds a session with `actorType: "user"` and the board user's
id, then asks the policy service to decide. Agent tool profiles bind to agents,
so the board user is not subject to them.

| Call | Expected from the agent's policy | Actual |
| --- | --- | --- |
| Test as the **ungranted** agent, `list_notes` | denied (`allowedToolNames: []`) | `HTTP 200 {"decision": "allowed"}`, read returned |
| Test as the **granted** agent, `create_note`, before promotion | denied (`deny / deny_default`) | `HTTP 200 {"decision": "allowed"}` — **and the file was created on the provider** |

The policy simulator, asked the same questions with `actorType: "agent"`, answers
correctly.

**Why it matters.** On the surface an operator reaches for first — a Test button
labelled with an agent — an ungranted agent does execute, and a write the
agent's own policy forbids lands on the provider. Validating a connector through
Test alone records a false pass, in both directions.

**Suggested fix.** Either evaluate the test call under the selected agent's
policy and surface the board override explicitly, or relabel the surface "Test
as board" and show the agent's own decision beside the result.

### F10 — the connect wizard grants the policy but not the install

`POST …/tools/apps/{id}/finish` with `access: {agentIds: [...]}` creates the
tool-profile binding — the agent's `allowedToolNames` correctly lists the
chosen tool — but creates **no `tool_connection_install` row**. Agent
readiness (`usableConnectionForAgent`, the `usable` predicate in
`server/src/services/connection-intents.ts`) requires the connection to be
both installed for the agent and permitted:

```ts
const usable = (connection) => connection
  && installedIds.has(connection.id) && permittedIds.has(connection.id)
  && connection.status === "active" && connection.enabled && …
```

With `installs: []` the first clause fails, so the tool never enters the agent's
session. Both instances, both wizard-created connections:

```text
GET /api/tool-connections/{id}/installs        ⇒ {"installs": []}
GET …/tools/profiles/effective/agents/{agent}  ⇒ allowedToolNames: ["read_wiki_structure"]
                                                 installedConnections: []
```

On instance B this produced a genuinely confusing run: the agent found the
connection, got `state: "needs_user_action", reason: "Review identity and access
for this agent"`, raised a connection request, and correctly refused to fake the
answer — while the board's own access view showed the tool allowed
(`allowedCount: 1`) and the connection `active / enabled / ok`. Adding the
install with `PUT …/installs`, the only change, made the same agent's next run
succeed.

**Suggested fix.** Have `finish` write the installs implied by its own `access`
argument, or have the connection detail view show "allowed but not installed"
instead of a green badge.

### F3 — a provider that is down reports as a missing tool

With the provider stopped, a gateway call returned
`HTTP 404 {"error": "Tool \"list_notes\" not found", "reasonCode": "tool_not_found"}`.
The same code comes back when the connection is merely disabled. Meanwhile
`health-check` correctly reported `runtime_error / fetch failed`. Distinguish
"upstream unreachable" from "tool absent from the catalog" in the gateway's
reason code.

### F4 — revocation is enforced, but the policy view still says allow

After the organization grant was revoked, the policy simulator kept answering
`allow / allow_profile` while the live call failed with
`organization_authorization_required`. Enforcement is correct; the operator's
"who can do what" view is not. Fold grant state into the simulated decision, or
annotate the result with the credential-resolution outcome.

### F5 — `PAPERCLIP_HOME` loses to an ancestor `.paperclip/config.json`

`resolvePaperclipConfigPath` (`server/src/paths.ts`) walks up from
`process.cwd()` looking for `.paperclip/config.json` and only then falls back to
the home-derived path. Starting the server from inside a checkout with
`PAPERCLIP_HOME=<isolated>` therefore loads the **checkout's** config and binds
a different instance's database, while the banner reports the isolated paths.
`PAPERCLIP_CONFIG=<path>` is the override that actually wins.

This matters to anyone following `doc/DEVELOPING.md`, which recommends isolating
with `PAPERCLIP_HOME` / `--data-dir`. Use `PAPERCLIP_CONFIG`, and check the bound
database before you trust an "isolated" instance — a start against the wrong
database can apply pending migrations to it.

### F6 — a server started inside an agent's run hands its children that run's control-plane URL

Starting an instance from inside an agent's shell carries that run's
`PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_RUN_ID` and friends. The
agent the instance spawns inherits them, points at the *other* instance, and
gets `401` on every call including its own MCP servers — a failure that reads
exactly like a broken connector. Restarting under `env -i` with only the
variables the instance needs fixes it. Troubleshooting rule: **if a self-hosted
agent run 401s on everything, check which `PAPERCLIP_*` variables the server
process inherited.**

### F7 — `authenticated` + `public` has two hard prerequisites

Both were found by hitting them:

1. `StartupRefusalError: authenticated public deployments require DATABASE_URL or
   config.database.connectionString; refusing embedded PostgreSQL fallback`. A
   public self-hosted instance cannot use the embedded database at all.
2. `auth.baseUrlMode must be explicit when deploymentMode=authenticated and
   exposure=public`, plus `auth.publicBaseUrl` required
   (`packages/shared/src/config-schema.ts`).

Neither is a defect. Both are the first two walls a self-hoster hits, which is
why they are in the shape-B row of the matrix.

### F8 — first-admin claim, and what the public base URL silently controls

**F8a.** `POST /api/bootstrap/claim` returns
`404 Browser first-admin claim is not available` unless exposure is `private`,
and a merely signed-up user is not an instance admin (`Instance admin required`
on the first board mutation). The way through: claim the admin while the
instance is `private`, then restart it as `public`.

**F8b.** `auth.publicBaseUrl` is not only browser-facing — it is what the agent
runtime gives spawned agents as their control-plane URL. With a placeholder
hostname, a shape-B agent run fails with `getaddrinfo ENOTFOUND` on every MCP
server and every API call. **On shape B it must resolve from the machine the
runtime runs on, not just from the operator's browser.** Changing it also
invalidates existing board sessions.

### F9 — the gateway's MCP client sends `tools/list` with no `initialize`

The provider's request log shows Paperclip posting `tools/list` directly, with no
preceding `initialize` handshake and no `MCP-Protocol-Version` header. The
disposable server is lenient and answered. A strict MCP server may reject an
uninitialised session, which would present as a connector that health-checks
green in testing and fails against a compliant provider. Not confirmed against a
strict implementation — an observation, not a defect.

## 5. What was not covered

- **Cloud: nothing.** No Cloud instance was reachable. Every Cloud cell in the
  matrix is `untested` or `unsupported`, and none of it is inferred from a
  self-hosted result.
- **OAuth on every shape.** Needs an authorized provider account.
- **`local_stdio` execution.** The live `supportMatrix` differs between shapes A
  and B, which is itself useful, but no stdio connection was created or run.
- **Chat and email.** Not touched.
- **Shape-B write execution and provider-side readback.** The shape-B provider is
  read-only.
- **Link-local denial.** Source-cited only; no live call.

F1 and F2 need product decisions rather than more testing. Both reproduce from
this document in under ten minutes on a fresh instance.
