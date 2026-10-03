---
name: connect-agent-tools
description: >
  Get a Paperclip agent working with an outside tool, self-hosted or Cloud:
  start from the workflow and its proof, establish the deployment and its real
  reachability, take the smallest supported connection path, and verify a real
  agent run with provider-side readback. Not for catalog authoring.
key: paperclipai/optional/software-development/connect-agent-tools
recommendedForRoles:
  - engineer
  - operations
tags:
  - mcp
  - connectors
  - integrations
  - connections
  - verification
requires:
  - curl
---

# Connect Agent Tools

Take "my agent needs to use X" to "an agent did the job through the managed
connection, and here is the artifact on X's side".

This skill owns the **decision and the proof**. It does not own catalog
mechanics; `author-connector-definition` does, and most runs never need it.

**Self-hosted Paperclip is the primary target.** Every step below works on an
instance you run yourself, on your own machine or on your own server, with no
Paperclip Cloud account, no managed Cloud OAuth client, and no Paperclip-operated
infrastructure. Cloud is covered as a third deployment shape, not as the
reference implementation. Where the two diverge, the divergence is written down
in [`references/deployment-support-matrix.md`](references/deployment-support-matrix.md)
with the guard or document behind it. Where that file says `verified`, the run
behind it — commands, observed output, and the correlated agent run — is in
[`references/verification-log.md`](references/verification-log.md), so you can
redo it rather than take the label on trust.

**How this skill cites the product.** A file and a symbol you can grep for,
never a line number: line numbers drift between the read and the reader, and
this skill has already been caught citing four that had moved. Every source and
runbook citation below was re-read at App commit `18dac1e1` (24 September 2026).
If the commit in front of you disagrees, the commit wins — record the drift.

## Use This When

- An agent cannot reach a tool it needs, and nobody has established why.
- Someone asks for "a connector for X" without having checked whether X is
  already connectable.
- A connection exists, shows **Connected**, and the agent still cannot do the
  job.
- Someone needs to know whether an integration will work on a server or in
  Paperclip Cloud, not just on their own computer.

## Do Not Use This When

| Request | Owner |
| --- | --- |
| "Add X to the Connectors catalog" and the catalog change is already approved | `author-connector-definition`. Come back here for the live proof. |
| "Research whether we should integrate X" as a company decision | The requester's research process. This skill reads provider metadata; it does not own an integration decision. |
| "Give agent Y access to the existing connection" | Operator action on the connection's grant and agent access. No new connection needed. |
| "Build the MCP server" | Product engineering. Report the gap (step 5) and stop. |
| "Ship it", "install it", "release it", "grant the credential" | Not authorized here. See **Authorization boundaries**. |

## Self-Hosted Quickstart

The smallest complete run, on an instance you host yourself. Use it as the
worked shape for step 3 path 2; it needs no Paperclip Cloud account and no
Paperclip code change.

**1. Establish the deployment.** Read `PAPERCLIP_DEPLOYMENT_MODE` and
`PAPERCLIP_DEPLOYMENT_EXPOSURE` from the instance's configuration. Unset means
`local_trusted`, and `local_trusted` forces `private`.

**2. Probe the provider read-only.** This is Neon's hosted MCP server, executed
19 September 2026:

```sh
curl -s -i -X POST "https://mcp.neon.tech/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

```text
HTTP/2 401
www-authenticate: Bearer error="invalid_token", error_description="No authorization provided", resource_metadata="https://mcp.neon.tech/.well-known/oauth-protected-resource/mcp"
```

Follow the pointer, then the issuer's authorization-server document:

```sh
curl -s "https://mcp.neon.tech/.well-known/oauth-protected-resource/mcp"
curl -s "https://mcp.neon.tech/.well-known/oauth-authorization-server"
```

```text
resource                = https://mcp.neon.tech/mcp
authorization_servers   = ["https://mcp.neon.tech"]

issuer                            = https://mcp.neon.tech
registration_endpoint             = https://mcp.neon.tech/api/register
authorization_endpoint            = https://mcp.neon.tech/api/authorize
token_endpoint                    = https://mcp.neon.tech/api/token
revocation_endpoint               = https://mcp.neon.tech/api/revoke
scopes_supported                  = ["read", "write"]
code_challenge_methods_supported  = ["S256"]
token_endpoint_auth_methods_supported = ["client_secret_post", "client_secret_basic", "none"]
client_id_metadata_document_supported = <absent>
```

**3. Read the result.** The issuer matches the host used to build the URL, so
the document is usable. A `registration_endpoint` plus `none` and `S256` means
the DCR tier applies — and DCR is instance-local, so this works identically on a
self-hosted instance and on Cloud. CIMD is not advertised, so the public-HTTPS
requirement that tier carries is irrelevant here. **No Cloud account, no managed
OAuth client, and no public origin are needed for this provider.**

**4. Connect it.** The operator uses **Connect your own MCP server** and pastes
`https://mcp.neon.tech/mcp`. No catalog entry, no code change. Start writes at
**Off**.

**5. Prove it.** Step 5 of this skill. A **Connected** badge is not the proof;
a real agent run with provider-side readback is.

What this quickstart claims, precisely. The probe output above is executed
against Neon. The **connect and consent for Neon specifically** are `untested`
here, because OAuth consent needs an authorized Neon account.

The rest of the shape is not hypothetical. The same no-code path — connect by
pasted URL, catalog discovery, effective policy, a real agent run correlated to
its run ID, provider-side readback, revoke and reconnect, credential redaction —
is **`verified` on self-hosted**, on two isolated instances, against a loopback
MCP server and against DeepWiki, a real third-party public server. Run IDs and
provider-side artifacts are in
[`references/deployment-support-matrix.md`](references/deployment-support-matrix.md).
What that buys you is confidence in the path, not in your provider: your run
still has to produce its own proof, and the whole OAuth column remains
`untested` on every deployment shape.

## Required Inputs

Collect these before step 1. Ask for what you cannot establish safely.

1. **The workflow.** What the agent should accomplish, in one sentence.
2. **The proof.** The artifact you will open on the provider's side afterwards.
   If the requester cannot name one, the workflow is still being designed — say
   so and stop there.
3. **Deployment shape.** Where this Paperclip runs: the same computer as the
   provider, a server or VPS, or Paperclip Cloud. Ask; do not infer it from the
   URL someone pasted in a browser.
4. **Provider identity** and its official documentation URL. Not a search
   result, not a third-party list.
5. **Who can authorize what.** Which operator can finish a connection, and
   whether any live write has been authorized. Absent that, this run ends at a
   read-only proof.

## Scope Boundaries

- **One tool, one workflow per run.** Breadth after the first real success.
- **Do not weaken a guard to make a test pass.** The private-endpoint check, the
  link-local denial, the transport rules and the risk annotations are the
  product's boundaries, not obstacles.
- **Do not widen permissions or grants.** Use the narrow authorization you were
  given and name what is missing.
- **Do not change global defaults**, shared validators or risk classification.
- **Do not add server or UI code** before showing that no supported path exists.

## Authorization Boundaries

- **Secrets stay in approved flows.** Never place a credential in a config file,
  a comment, a screenshot, a trace, a HAR file, a fixture or a report. If you
  are handed one, propose it as a Paperclip secret and never echo it.
- **Unauthenticated metadata reads are research.** Dynamic client registration,
  consent, and any write tool call are not. They need explicit authorization.
- **No credential grants.** Do not create, share or widen a grant.
- **No installs, deploys, pushes, PRs or releases.**
- **No new provider writes or runtime changes** without their own authorization,
  even when a read-only proof succeeded.
- **No roadmap claims.** Do not promise a future transport or a Cloud
  capability that has not shipped.

## Step 1 — Write Down The Workflow And The Proof

Two sentences, recorded in the task before anything else:

- The job: "the on-call agent opens a database branch before a migration test".
- The proof: "the branch is visible in the provider's console, and the agent's
  run shows the tool call that created it".

Everything below is in service of the second sentence. A **Connected** badge, a
catalog card and a green test suite are not it.

## Step 2 — Establish Where This Runs

Two locations, routinely conflated: where Paperclip's runtime executes the call,
and where the provider's server is. Only the runtime's view of the network
counts.

Name one of three deployment shapes. Do not infer it from a product tier, from
a URL someone pasted in a browser, or from the absence of an error — read the
instance's actual configuration.

| Shape | Typical config | Call originates from | Check |
| --- | --- | --- | --- |
| **A. Self-hosted, same machine** | `PAPERCLIP_DEPLOYMENT_MODE=local_trusted` | That computer | Can the runtime reach the service *and* the files it needs? Desktop app running, document open, correct user session. |
| **B. Self-hosted, server or VPS** | `authenticated`, plus `private` or `public` exposure | That server | Is the endpoint reachable from the server, not merely from the requester's browser? Does the instance have a public HTTPS origin, and does anything here actually need one? |
| **C. Paperclip Cloud** | hosted, `authenticated` + `public` | A hosted environment | Is the integration supported and tested from the Cloud runtime? Nothing on anyone's laptop is reachable. |

Shapes A and B are the primary path. Work them first and completely; treat C as
a separate deployment that needs its own evidence.

Self-hosted does not imply desktop-compatible. A locally launched MCP server
that only calls a vendor's hosted API is portable; one that drives an open
desktop app, local files or a private network needs those where the runtime is.

Two configuration facts decide most of what follows, both re-read at
`18dac1e1`:

- `local_trusted` **forces** exposure to `private` (`deploymentExposure` in
  `server/src/config.ts`). A shape-A instance can never reach the
  `authenticated` + `public` combination that the private-endpoint guard
  refuses.
- Paperclip refuses private, loopback and reserved MCP addresses only on a
  deployment that is both authenticated and publicly exposed
  (`allowPrivateRemoteEndpoints` at `server/src/services/tool-access.ts`,
  mirrored in `tool-gateway.ts`), and refuses link-local addresses in
  every mode (`server/src/services/remote-http-endpoint-guard.ts`).

Read those at the commit in front of you and record it. Never propose a tunnel,
a proxy or an exception to get around the guard.

**An agent cannot read its own deployment's support matrix, but an operator
always can.** `GET /api/companies/:companyId/tools/runtime-health` returns the
live `supportMatrix` for the instance and requires board access: a run-scoped
agent credential gets `403 {"error":"Board access required"}`, while a board
actor on an instance they own reads it fine (both executed 19 September 2026;
route at the `tools/runtime-health` handler in
`server/src/routes/tool-access.ts`). So if you are the agent, ask the operator
to run it and paste the `supportMatrix` block, or read the configuration
directly. Do not guess it, and do not report the `403` as though the surface
were unavailable — it is available to the person you are asking.

Label every capability you establish **verified**, **untested**, **unsupported**
or **deferred**, each with its reason. Fill in a copy of
[`references/deployment-support-matrix.md`](references/deployment-support-matrix.md)
rather than inventing your own labels. A local success is never Cloud evidence,
and Cloud success is never self-hosted evidence.

If the provider is a chat or email provider, read
[`references/chat-and-email.md`](references/chat-and-email.md) now — the inbound
delivery mechanism, not the deployment tier, decides whether a public HTTPS
origin is a real prerequisite.

## Step 3 — Take The Smallest Supported Path

Work down. Stop at the first path that does the job. The runbook states the
governing principle: "A catalog entry is a convenience layer, not a
prerequisite. An operator can connect any standards-compliant remote HTTP MCP
server from **Connect your own MCP server** or **Paste a config** with no
Paperclip code change at all — including servers that need browser sign-in."
(`CONNECTOR-PLAYBOOK.md`, opening section.)

1. **An existing connector.** Check the catalog and the provider pages first. If
   a connector exists and the workflow still fails, this is a configuration,
   grant or permission problem — diagnose that, do not build.
2. **A compatible MCP endpoint, connected by URL.** No code change. All of these
   must hold: an `http`/`https` MCP endpoint; reachable from the runtime;
   authentication in a shape Paperclip drives (OAuth advertised through RFC 9728
   / RFC 8414 metadata, a key presented as a header, a provider-generated
   secret-bearing URL, or none); and an OAuth client Paperclip can obtain
   (preconfigured, CIMD, dynamic registration, or one the operator registered).
   Name which condition failed rather than improvising.

   **None of those four conditions needs Paperclip Cloud.** DCR is
   instance-local: each instance registers its own public client against its
   own `/api/tools/oauth/callback`, and "Cloud-hosted and self-hosted
   instances use the SAME path — the only per-instance difference is the
   hostname inside the redirect URI" (`CONNECTOR-PLAYBOOK.md`, **Dynamic
   client registration (RFC 7591)** — grep `use the SAME path`). CIMD is the
   one tier that needs a public HTTPS `PAPERCLIP_PUBLIC_URL`, and a deployment
   without one falls through to DCR rather than failing. A self-hoster whose
   provider cannot do DCR registers their own client and sets
   `PAPERCLIP_TOOL_OAUTH_<PROVIDER>_CLIENT_ID` / `_SECRET`. The only genuinely
   Cloud-gated path is the curated `platform_shared` Paperclip-managed OAuth
   profile; if that is the only option, say so and stop rather than implying a
   self-hosted equivalent exists.
3. **A catalog definition.** Only when a *reusable, branded, reviewed* entry is
   the actual requirement, and only with the App repository and its ingestion
   corpus available. This is a shared-source change that ends in review and a
   release, not a connection anyone can use today. Hand it to
   `author-connector-definition` and come back here for the proof. If the
   repository or corpus is unavailable, say so plainly — path 2 is not a lesser
   substitute for it, and the reverse is also true.
4. **No supported transport or network path.** Go to step 5.

Before any provider round-trip, probe read-only and record the date:

```sh
curl -s -i -X POST "$SERVER_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
# For an OAuth challenge, follow resource_metadata, then the issuer's
# authorization-server document. Discard a document whose issuer disagrees with
# the issuer used to build the URL.
```

Record the endpoint and its trailing-slash behaviour, the unauthenticated
status and challenge, the metadata URLs, the exact issuer, whether registration
and PKCE `S256` are advertised, the provider's full `scopes_supported` and the
narrower set you will request, documented prerequisites (plan, admin consent,
desktop app, open document, region, tenant), and the revocation procedure.
Mark as **unprobed** anything that would require registering or authenticating,
and never guess it.

## Step 4 — Configure Within Authorization

Have the authorized operator finish the connection. Then, before claiming
anything:

- Start writes at **Off** on a server nobody has reviewed and promote
  deliberately. Re-run **Refresh actions** after the server changes.

  **Then re-check the profile, because promotion is not durable.** A
  connection created from a pasted URL is flagged `unverifiedServer: true` and
  `quarantineNewEntries: false` in the same expression — grep
  `unverifiedServer` in `server/src/services/tool-access.ts` — so every catalog
  refresh auto-allows whatever new tools the provider has started advertising,
  including ones classified `destructive`. Verified by execution at
  `9335b7db10` and still present at `18dac1e1`; see **F1** in
  [`references/deployment-support-matrix.md`](references/deployment-support-matrix.md).
  On a server you do not control, the tool set is provider-controlled, not
  operator-controlled. Say that out loud in your report.

- **Check that the connection is installed on the agent, not merely
  permitted.** Finishing the wizard with `access: {agentIds: [...]}` writes
  the tool-profile binding but no install row, and readiness needs both (the
  `usable` predicate in `server/src/services/connection-intents.ts`). The
  symptom is a green **Connected** badge and an allowed tool the agent cannot
  see. Verified on two instances — **F10** in the same reference.

  ```sh
  curl -s -H "Authorization: Bearer $TOKEN" \
    "$BASE/api/tool-connections/$CONNECTION_ID/installs"
  # {"installs": []} means the agent still cannot use it, whatever the badge says.
  ```

- Check the *effective* tool inventory and permissions of the agent that will
  actually run the workflow. A connected badge proves neither.
- Check that the instance executes tasks at all. A review or worktree instance
  can suppress execution, which looks exactly like a provider failure.
- If a self-hosted agent run fails on *everything* with `401` or
  `getaddrinfo ENOTFOUND`, suspect the runtime's environment before the
  connector. A Paperclip server started from inside another agent's run inherits
  that run's `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY` and hands them to the
  agents it spawns; and on shape B, `auth.publicBaseUrl` is what spawned agents
  get as their control-plane URL, so it has to resolve from the runtime's own
  machine.

## Step 5 — Verify A Real Result

Four kinds of evidence, in increasing strength. Never blur them.

| Evidence | Proves | Does not prove |
| --- | --- | --- |
| Generator, schema and unit tests | The definition fits tested contracts | Anything about the provider |
| A board **Test** call | That the endpoint can execute that action *for the board* | Anything at all about the agent — see below |
| The policy simulator with `actorType: "agent"` | What the agent's policy decides | That the call would actually succeed |
| A real agent run, with gateway audit events correlated to that run ID | An agent used the managed connector | That the output is correct |
| Provider-side readback of the artifact | The expected result exists and is usable | Any other workflow, provider or deployment |

Only the last two answer the original question.

**The board Test call is labelled with an agent and does not run as one.**
`executeTestCall` builds the session with `actorType: "user"` and the board
user's ID, and agent tool profiles bind to agents. Executed 19 September 2026:
testing as an *ungranted* agent returned `HTTP 200 {"decision":"allowed"}` and
the read succeeded; testing a write the agent's policy denied also returned
`allowed` — **and created the file on the provider.** So Test produces false
passes in one direction and unintended writes in the other. Use
`POST /api/companies/{c}/tools/policy/test` with `actorType: "agent"` for
permission questions, and a real run for execution questions. Detail: **F2** in
[`references/deployment-support-matrix.md`](references/deployment-support-matrix.md).

1. Start a real, bounded agent task — the workflow from step 1. Do not
   manufacture heartbeat rows and do not count a synthetic session.
2. Correlate connection and tool-invocation events with that exact run ID, and
   inspect the tool namespaces actually used. An assistant's claim that it used
   a tool is not evidence.
3. Read the artifact back on the provider. For visual output, inspect the
   rendered image for real content — a screenshot call can return success before
   rendering finishes, and a blank image is not acceptance. Use a bounded
   read-only recheck, then report the gap rather than waiting indefinitely.
4. For an authorized write, target an explicitly disposable resource, save the
   returned resource ID and pass it to later calls instead of relying on "the
   active document". Reconcile provider state before retrying a timed-out write;
   a local checkpoint is not an atomic transaction with the provider. Never
   delete existing user content as cleanup.

A direct provider plugin, a raw API call, a browser action or an unrelated MCP
server reaching the same service can help you diagnose and can never count as
acceptance. If one contaminates a run, exclude the run.

Then exercise the applicable negative and lifecycle cases in the authorized
sandbox. Do not invent your own list: the runbook's **production validation**
section is the canonical one, and PR #13675 moved it into the runbook precisely
so contributors no longer need a private validation issue for it. Its nine
scenarios are setup and consent, authentication, catalog and configuration,
allowed execution, denied execution, runtime delivery, refresh and recovery,
revoke and reconnect, and activity and secret handling
(`CONNECTOR-PLAYBOOK.md`, **Step 9: Align With Production Validation** — the
scenario table).

Record **pass**, **fail**, **not run** or **not applicable** per scenario with a
reason for the last two, plus environment, method key, commit, reproduction
steps, expected and actual result, and accessible redacted evidence. Then map
each result into the four deployment labels in
[`references/deployment-support-matrix.md`](references/deployment-support-matrix.md):
a scenario that passed on your self-hosted instance makes that row `verified`
**for that deployment only** and leaves the other columns `untested`.

**Run the self-hosted lifecycle first and completely.** Cloud parity is
follow-on work, and an untested Cloud column is `untested` — never `verified`
by analogy with a self-hosted pass. One happy path does not clear a security or
shared-runtime review.

When the path is path 3 and live testing has been separately authorized, the
`author-connector-definition` skill's `references/live-acceptance.md` is the
longer checklist for the same gate; use it rather than restating it.

## Stop Conditions

Stop and report rather than working around any of these:

- The requester cannot name the artifact that would prove success.
- The provider has no MCP endpoint, or needs a transport with no execution path.
- The endpoint is only reachable from somewhere the runtime is not.
- A guard would have to be widened, a tunnel opened, a global default changed,
  or a risk annotation downgraded.
- The provider requires a registration or approval the customer cannot
  complete.
- Path 3 is the real requirement and the App repository or its ingestion corpus
  is unavailable to you.
- A live write is needed and has not been authorized.
- A raw credential appears anywhere. Treat it as an incident: revoke and rotate,
  remove the evidence, trace every response, log and audit path, and add a
  canary regression test.

## Output Contract

Deliver exactly this, and nothing that implies more:

1. **The workflow and the proof**, as written in step 1.
2. **A filled deployment support matrix**, in the shape of
   `references/deployment-support-matrix.md`: a row per capability, a column per
   deployment shape you care about, and every cell labelled `verified`,
   `untested`, `unsupported` or `deferred` with the guard, provider fact,
   executed command or named follow-up owner behind it, plus the commit or
   document date you read it from. Self-hosted columns come first and are
   expected to be the most complete.
3. **The path taken**, and why the smaller ones were ruled out.
4. **A provider evidence record** — endpoint, metadata URLs, issuer, advertised
   registration and PKCE support, scopes considered versus requested,
   prerequisites, and the date of each read. No credentials. No tool inventory
   you did not observe.
5. **Evidence, in the four separate buckets** of step 5, with the real run ID
   and correlated invocations for anything you call an agent run.
6. **Negative and lifecycle results**: passed, failed, pending, not applicable.
7. **Remaining gaps** — unprobed constraints, untested deployments, and anything
   a reviewer must authorize before this is relied on.
8. **An explicit statement** of what did not happen: no grant, no install, no
   deploy, no push, no PR, no unauthorized write, no configuration left changed.

## Verification Checklist

Tick each item only with evidence, and mark the ones you could not run:

- [ ] The workflow and its provider-side proof are written down.
- [ ] Runtime location and provider location are both established, not assumed.
- [ ] The deployment shape (A, B or C) is named from actual configuration, not
      from a product tier.
- [ ] The reachability verdict cites the current guard or provider document,
      with a date or commit.
- [ ] The support matrix is filled in, self-hosted columns first, with every
      cell labelled `verified` / `untested` / `unsupported` / `deferred`.
- [ ] No step of the delivered workflow requires a Cloud account, a managed
      Cloud OAuth client, or private infrastructure — or, if one does, that
      step is labelled `unsupported` for self-hosted rather than assumed away.
- [ ] The smallest supported path was taken, and the rejected ones are named.
- [ ] Provider metadata was read unauthenticated and dated; nothing was
      registered during research.
- [ ] Requested scopes are the reviewed minimum, with the cost stated.
- [ ] The acting agent's effective tools and permissions were inspected.
- [ ] Instance execution was confirmed before any provider was blamed.
- [ ] A real agent run exists, with audit events correlated to its run ID.
- [ ] The artifact was read back on the provider and inspected, not inferred
      from a success response.
- [ ] Negative and lifecycle cases are recorded with per-case status.
- [ ] No credential value appears in any file, output or report.
- [ ] Temporary configuration changes are listed and restored.
- [ ] The report separates executed, source-inspected and not done.
