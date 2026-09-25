---
name: author-connector-definition
description: >
  Author one Paperclip catalog connector definition: probe the provider MCP
  metadata, fix the five connection axes, add official branding, edit the
  generator source, regenerate, and get the catalog tests green with evidence.
  Mechanical authoring only; not research approval, not PR submission.
key: paperclipai/optional/software-development/author-connector-definition
recommendedForRoles:
  - engineer
tags:
  - mcp
  - connectors
  - app-definition
  - catalog
  - codegen
requires:
  - git
  - curl
  - node
  - pnpm
---

# Author Connector Definition

Turn a provider name into a reviewable catalog-connector change in the Paperclip
App, with executed evidence for every claim.

This skill owns the **mechanics** of one definition: the generator contract, the
slug allowlist, branding validation, the exact-count test assertions, and the
offline verification loop. It does not own the process around them.

**A catalog entry is a convenience layer, not a prerequisite.** The runbook is
explicit: an operator can connect any standards-compliant remote HTTP MCP
server from **Connect your own MCP server** or **Paste a config** with no
Paperclip code change at all, including servers that need browser sign-in
(`CONNECTOR-PLAYBOOK.md`, opening section). Check that the requester actually
needs a catalog entry before spending a single edit here.
`connect-agent-tools` owns that decision.

**Self-hosted first.** Everything this skill produces is authored and verified
against an App checkout and an instance you run yourself. Phases 8 and 9 of the
runbook are satisfied by an isolated self-hosted instance; no Paperclip Cloud
account is required to author, validate, or submit a connector. Where a method
is genuinely Cloud-gated — the curated `platform_shared` Paperclip-managed OAuth
profile is the one current case — record it as `unsupported` for self-hosted
rather than treating Cloud as the baseline.

**How this skill cites the product.** A file and a symbol you can grep for,
never a line number: line numbers drift between the read and the reader, and
this skill has already been caught citing four that had moved. Every source and
runbook citation below was re-read at App commit `18dac1e1` (24 September 2026).
If the commit in front of you disagrees, the commit wins — record the drift.

## Use This When

Trigger on a request that names a provider and asks for a catalog connector,
gallery card, or `AppDefinition` — for example "add a Neon connector", "put
Fireflies in the Connectors catalog", "author the app definition for X".

Also trigger when an existing definition needs an axis change: a new method, a
different `ownershipModes` set, a widened `scopesHint`, a corrected endpoint, or
a visibility change.

## Do Not Use This When

Hand the request to the right owner instead:

| Request | Owner |
| --- | --- |
| "Connect this MCP server for our company" | No code change. The operator uses **Connect your own MCP server** or **Advanced → Paste a config**. Say so and stop. |
| "My agent needs to use X" / "will this work self-hosted?" | `connect-agent-tools`. It owns the deployment decision, the smallest-path ladder, and the live proof. Come back here only if a catalog entry is genuinely the requirement. |
| "Research whether we should integrate X" | The requester's research process. Inside Paperclip Content, `prepare-mcp-integration` owns the research package and its human gate — but the runbook is now self-contained, so an external contributor does **not** need it. |
| "Open the connector PR" | Runbook Phase 12 plus the standard PR-preparation skill. This skill stops before any PR. |
| "The provider has no MCP server" | Out of scope. A manifest cannot wrap an arbitrary REST API, run an arbitrary local command, or register an OAuth client in a console Paperclip does not control. Report the boundary. |
| "Ship it" / "install it" / "release it" | Not authorized here. See **Authorization boundaries**. |

PR #13675 made the runbook self-contained so that "contributors can implement
a connector without access to an internal issue tracker", and removed the
separate private validation issue ("No separate private validation issue is
required", `CONNECTOR-PLAYBOOK.md`, **Step 9: Align With Production
Validation**). Treat `prepare-mcp-integration` as an internal convenience for
people working inside Paperclip Content, not as a gate a public contributor
must pass. When it does apply, that skill drives and calls this one for the
definition itself.

## Required Inputs

Collect these before step 1. Ask only for what you cannot determine safely.

1. **Provider name**, and the slug you intend to use (stable, lowercase,
   kebab-case).
2. **App repository checkout and target branch.** Record the exact commit you
   read the contract from; reread it before you edit.
3. **Who decided this provider should be in the catalog**, and on what basis.
   A public contributor's own reasoning, recorded in the PR, is sufficient —
   the runbook no longer requires a private research approval. Inside Paperclip
   Content, that decision is `prepare-mcp-integration`'s gate; if it applies and
   has not been taken, stop and route there.
4. **Intended visibility**, which is a three-way choice, not a toggle:
   store-visible; connectable but unlisted (`APP_STORE_HIDDEN_SLUGS` — still
   reachable by direct URL or slug, so hiding is not withholding); or withheld
   (`availability: { available: false, reason }`, which refuses setup and
   renders the reason instead of a Connect action). A connector authored
   without a live provider proof belongs in the third state, not the second.
   See the visibility chain in `references/catalog-contract.md`.
5. **Location of the ingestion corpus** (`paperclip-content`), or the value for
   `PAPERCLIP_CONTENT_TEMPLATES`, *or* a decision to run the generator with
   `--definitions-only`. The corpus is in a non-public repository, but it is
   not a gate on authoring: `--definitions-only` skips it and still emits every
   definition and the positional registry, verified byte-for-byte. What it does
   not write is `app-definitions.ingestion-report.json`, which a provider with
   no capture of its own does not change anyway. See **Generator preconditions**
   in `references/catalog-contract.md`. Never edit the guard.
6. **The deployment you will validate on.** An isolated self-hosted instance is
   the expected answer and is sufficient.

Refuse to guess an endpoint, a scope set, or a risk tier. Each one is a
reviewable claim and must come from the provider's own metadata or documentation.

## Scope Boundaries

- **One provider per run.** Do not bundle two providers into one change.
- **Do not edit the generated JSON as a source of truth.** The durable source is
  the generator script — with nine documented exceptions. See
  `references/catalog-contract.md`.
- **Do not change global defaults.** Risk classification, the recommended access
  policy, and shared validators are not provider-local knobs. If the provider
  needs one changed, stop and say so.
- **Do not touch unrelated providers.** Generated output renumbers on insertion;
  that is expected. Any *semantic* change to another provider is a mistake.
- **Do not add server or UI code** until you have shown that the manifest cannot
  express the provider.

## Authorization Boundaries

- **Secrets stay in approved flows.** Never place a credential in the generator
  script, a definition, connection config, application metadata, a committed
  fixture, a comment, a screenshot, a trace, a HAR file, or a report. If you are
  handed a credential, propose it as a Paperclip secret immediately and never
  echo it. Assert absence in a test rather than merely not printing it —
  see **Asserting absence** below for the canary that does not false-positive.
- **No external writes during research.** Unauthenticated metadata reads are
  allowed. Dynamic client registration, consent, account mutation, and any write
  tool call are not research — they need explicit authorization.
- **No credential grants.** Do not create, share, or widen a connection grant.
- **No installs or releases.** Pushing, opening a PR, merging, deploying,
  installing a skill, or making a provider store-visible in a shipped build are
  all release-stage actions that require explicit human authorization. This
  skill ends at a verified local change.
- **No roadmap claims.** Do not write "coming soon" or promise a future method.

### Asserting absence

"Assert absence in a test" is easy to get wrong in one specific way, so here is
the shape that works.

The obvious canary — grep the definition for `/bearer|token|secret|key/i` —
fails on the checked-in catalog before you have added anything. `keyPlacement`
legitimately carries `"prefix": "Bearer "`, and at `18dac1e1` the shipped
definitions carry three such values (`"Bearer "`, `"Basic "`, `"Token token="`).
A canary that fires on a clean tree gets deleted within the week, which leaves
you with no canary at all.

Assert on **values and shapes**, not on the words that describe them:

```ts
it("ships no credential value for acme", () => {
  const definition = APP_DEFINITIONS.find((app) => app.slug === "acme")!;
  const fields = definition.methods.flatMap((m) => m.credentialFields ?? []);

  // A credential field declares how to collect a secret. It never carries one.
  for (const field of fields) {
    expect(field).not.toHaveProperty("value");
    expect(field).not.toHaveProperty("default");
  }

  // Value-shaped canary over the whole serialized definition. `"Bearer "` is a
  // scheme name and does not match; a real token does.
  expect(JSON.stringify(definition)).not.toMatch(
    /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  );
});
```

Executed at `d56a8a39d6` over the 79 checked-in definitions: the naive pattern
fires on **79 of 79**, the value-shaped one on **0 of 79**, and it still
matches `sk-…`, `ghp_…` and `xoxb-…` test strings.

The total moves whenever a provider lands — it was 72 a few days before this
line was written. Re-run both patterns instead of trusting the number. The
ratio is the claim, not the total.

Run the same value-shaped canary over every artifact you produce, not only the
definition: your report, any fixture, and any captured output. A credential that
never reached the definition but did reach the report is the same incident.

## Step 1 — Discover The Current Contract

Read from the recorded commit, not from memory and not from a stale worktree:

- `doc/connections/CONNECTOR-PLAYBOOK.md` — the authoring runbook. Read its
  **five axes**, **reuse-path classification** (MCP-direct / OpenAPI-shim /
  vendor-deep-wrapper), **risk tiers S1–S4**, and the **production validation**
  evidence matrix in Step 9. Since PR #13675 that matrix lives in the runbook
  itself, and it is the list your evidence must answer.
- `doc/connections/GENERIC-REMOTE-MCP.md` — the no-code baseline, so you can
  tell the requester when they do not need you. It also documents the OAuth
  client-resolution tiers and which of them need a public HTTPS origin.
- `doc/connections/CHAT-CONNECTOR-UX.md` — **only if the provider is a chat or
  email provider.** It owns step navigation, the step-owned footer, credential
  instructions, provider handoffs, personal identity linking, the optional
  message test, and management states. Do not apply Slack's steps or credential
  types to a provider that does not work that way, and do not skip it when they
  apply. The `connect-agent-tools` skill's `references/chat-and-email.md` is
  the short routing layer over it.
- `doc/connections/README.md` — the identity/connections boundary. Every
  connector is a plane P2 resource credential, never a sign-in authenticator.
  Sign-in tokens are never reused as resource tokens; `id.paperclip.ing` never
  stores resource tokens.
- `scripts/ingest-app-definitions.mjs` — the generator. Read its corpus guard,
  its `brandingFor`, its tuple mapper, and its `validateApp`.
- `packages/shared/src/types/app-definition.ts` — the field contract.
- `packages/shared/src/app-definitions.ts` — the slug allowlists and the
  recommended access defaults.
- `packages/shared/src/app-definitions.test.ts` — the assertions your change
  must satisfy.

**Finding the sibling skill's files.** Installed catalog skills do not
materialize under their bare slug. A run sees
`connect-agent-tools--<hash>/`, where the suffix is generated per package, so
`../connect-agent-tools/references/…` resolves to nothing and a relative link
written that way is dead the moment the skill is installed rather than read out
of a checkout. Resolve the directory before you read it:

```sh
find "$(dirname "$PWD")" -maxdepth 1 -name 'connect-agent-tools*' -type d
```

Inside an App checkout the bare name is correct; both forms appear, and only
one of them is the one an installed reader has.

Then read `references/catalog-contract.md` in this skill for the file-by-file
map and the assertions that carry exact counts. Treat that reference as a
starting index, not as a substitute: if it disagrees with the commit you read,
the commit wins, and you record the drift in your report.

## Step 2 — Probe The Provider, Read-Only

First establish where the MCP server runs and which process connects to it.
For a desktop server, loopback means the connector runtime's machine, not the
user's browser or a cloud worker. Record desktop/open-document prerequisites;
do not invent hosted OAuth for a same-machine, unauthenticated server. If the
current transport or egress policy cannot support it, report the runtime gap.

For OAuth providers, these unauthenticated requests inspect the transport and
auth axes. Skip OAuth discovery for a provider that does not use OAuth.

**Do not `curl` these URLs directly.** After the first request, the server
picks where you go next: `resource_metadata` comes out of its challenge, and
the issuer comes out of the document that URL returns. A hostile endpoint can
point either at cloud metadata at `169.254.169.254`, at a loopback service, or
at a public hostname whose DNS record is `127.0.0.1` — and a bare `curl` will
go there with your network position. Set up `safe_curl` from
[references/safe-discovery.md](references/safe-discovery.md) first. It
validates scheme, port, userinfo and every resolved address before anything is
sent, pins the connection to the addresses it validated so DNS cannot move the
request afterwards, refuses to go through a proxy — which would resolve the
hostname itself and make the pinning meaningless — and follows no redirect.
Refusal is exit 2 and means nothing left the machine.

```sh
source ./safe-fetch.sh   # see references/safe-discovery.md

safe_curl "$SERVER_URL" -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
# Read resource_metadata out of the WWW-Authenticate challenge, then:
safe_curl "$RESOURCE_METADATA_URL"          # RFC 9728 -> authorization_servers
safe_curl "$ISSUER/.well-known/oauth-authorization-server"   # RFC 8414
```

A refusal is a finding, not an obstacle to route around. Record the URL the
provider supplied and what it resolved to, and escalate it — a catalog
connector whose discovery points inside the authoring network does not ship.

Record, with the date you read it: the endpoint and its trailing-slash
behaviour; the unauthenticated status and challenge; the protected-resource and
authorization-server metadata URLs; the exact issuer; authorize, token,
registration and revocation endpoints; whether `token_endpoint_auth_method:
none` and PKCE `S256` are advertised; the provider's full `scopes_supported` and
the narrower set you will request; documented prerequisites (plan, admin
consent, preview enrolment, region, tenant identifier); and the revocation
procedure.

Discard an authorization-server document whose `issuer` disagrees with the
issuer used to build the URL.

Mark as **unprobed** anything you could not establish without registering or
authenticating — the redirect-URI constraint usually falls here, because probing
it properly means attempting registration. An unprobed constraint is omitted
from the definition and reported as a gap, never guessed.

## Step 3 — Fix The Five Axes In Writing

Record all five before editing anything: transport, authentication, OAuth client
ownership, credential source, grant identity. Then record the **reuse path** the
runbook asks for — MCP-direct, OpenAPI-shim, or vendor-deep-wrapper — with the
reason a lighter path is or is not enough. A provider name alone is not a
classification: a read-only method and a method that sends messages or changes
infrastructure can carry different risks and belong in different rows.

Then record the two judgements that reviewers will challenge:

- **Risk tier** (`S1`–`S4`), and why. Classify `S4` when the normal catalog
  includes payments, external sends, refunds, production deployment, deletion,
  or tenant-wide administration.
- **Scope allowlist**, and what it costs. A narrow allowlist is the right
  default; state plainly which tools will fail at call time because of it.

If discovery worked, ship **only** `serverUrl` in `defaults`. A complete
`authorizationEndpoint` + `tokenEndpoint` pair is authoritative and suppresses
discovery permanently, including endpoints a previous discovery persisted. Ship
that pair only for a provider that publishes no usable metadata, and say in your
report that you now own keeping it current.

## Step 4 — Branding Before Generation

Generation fails closed without a branding row, so do this first. Obtain the
official mark from the provider's brand kit, product site, or official
repository; prefer SVG; never use a favicon proxy, a scraped icon, or an
imitation. Add the asset and its manifest row, then run the two brand checks in
`references/catalog-contract.md`.

If you cannot obtain an official mark, stop and report it. A placeholder is
acceptable only in an explicitly labelled local fixture and must never be
proposed for release.

## Step 5 — Author, Register, Generate

1. Add the provider to the generator source. Prefer the existing tuple shape and
   the existing `method()` helper over a hand-built object.
2. Register the slug so the definition is reachable. A definition that generates
   cleanly but is absent from the slug allowlist is invisible in the product —
   this is the most common silent failure.
3. Regenerate. Read the whole diff. Expect positional renumbering in the
   generated registry; reject any semantic change to another provider.

## Step 6 — Verify Offline, Then Report Honestly

Run the deterministic ladder in `references/catalog-contract.md`. When you must
verify without mutating the checkout, build the isolated harness described in
`references/offline-verification.md` — it runs the real generator, the real
brand validators, and the real catalog tests against a copy, and includes a
fidelity check that proves the harness reproduces the checked-in output
byte-for-byte before you trust any result from it.

Then split your evidence into three explicit buckets and never blur them:

- **Executed** — the exact command and its real output.
- **Source-inspected** — read and reasoned about, not run. Server, UI and
  browser suites usually land here when you have no instance.
- **Not done** — including every account-bound step. A green catalog test is not
  provider validation, and a mocked OAuth test is not a live connect.

Then answer the runbook's nine production-validation scenarios — setup and
consent, authentication, catalog and configuration, allowed execution, denied
execution, runtime delivery, refresh and recovery, revoke and reconnect,
activity and secret handling (`CONNECTOR-PLAYBOOK.md`, **Step 9: Align With
Production Validation** — the scenario table) — with **pass / fail / not run /
not applicable** and a reason for the last two, plus environment, method key,
commit, and accessible redacted evidence. Offline authoring legitimately
produces a column of "not run"; what it must never produce is a blank or an
optimistic one.

Report those results per deployment, self-hosted first, using the four labels
in the `connect-agent-tools` skill's `references/deployment-support-matrix.md`.
A pass on a
self-hosted instance makes that row `verified` for self-hosted and leaves Cloud
`untested`; the reverse is equally true.

## Optional Live Acceptance Handoff

Offline authoring does not certify the connector for production. When the user
separately authorizes live testing, read
[Live acceptance](references/live-acceptance.md). Otherwise hand that checklist
to the tester and mark it not executed. The reference does not authorize grants,
provider writes, runtime changes, deployment, or installation.

Keep four results separate: static validation, board Test calls, a real agent
run through the managed connector, and verified provider-side output. Only the
last two establish that an agent can complete the tested workflow.

## Stop Conditions

Stop and report rather than working around any of these:

- An applicable research gate has not been taken, or does not cover this
  provider.
- The change needs `app-definitions.ingestion-report.json` refreshed and the
  ingestion corpus is unavailable. Authoring a definition does not — use
  `--definitions-only`.
- The provider has no compatible MCP server, or needs a transport with no execution
  path.
- The only viable method is Cloud-gated (`platform_shared` Paperclip-managed
  OAuth). Record it as `unsupported` for self-hosted and hand it to product
  engineering; do not imply a self-hosted equivalent.
- The provider requires a registration or approval that a customer cannot
  complete. Retain the research with an unavailable reason and expose no connect
  action.
- No official artwork is obtainable.
- The manifest cannot express the provider without new shared runtime code.
- A test assertion would have to be weakened rather than updated.
- A raw credential appears anywhere. Treat it as an incident: revoke and rotate,
  remove the evidence, trace every response, log and audit path, and add a
  canary regression test.
- The change would need a global default, a risk classification, or a shared
  validator to move.

## Output Contract

Deliver exactly this, and nothing that implies more:

1. **The change** — generator source edit, branding asset and manifest row, slug
   registration, regenerated output, and the one test-count update, as a diff or
   a working tree. No commits pushed, no PR.
2. **A source map** — every file you changed and every claim you relied on, with
   the commit and the file:line evidence for each.
3. **A provider evidence record** — endpoint, metadata URLs, issuer, advertised
   registration and PKCE support, scopes considered versus requested, risk tier
   with reasoning, and the date you read each one. No tool inventory you did not
   observe. No credentials.
4. **Verification results** — executed, source-inspected and not-done, each with
   real command output for the executed set, plus the runbook's nine
   production-validation scenarios marked pass / fail / not run / not
   applicable.
5. **A deployment support matrix** — self-hosted same-machine, self-hosted
   server/VPS, and Cloud, each capability labelled `verified`, `untested`,
   `unsupported` or `deferred` with its evidence or named follow-up owner. Use
   the `connect-agent-tools` skill's `references/deployment-support-matrix.md`
   as the shape.
6. **Remaining gaps** — unprobed constraints, the account-bound lifecycle, and
   anything a reviewer must authorize before release.
7. **An explicit statement** of what did not happen: no push, no PR, no deploy,
   no install, no credential grant, no external write.

## Verification Checklist

Tick each item only with evidence, and mark the ones you could not run:

- [ ] Endpoint and auth mode come from the provider's own metadata, dated.
- [ ] Issuer in the authorization-server document matches the issuer used to
      fetch it.
- [ ] `defaults` ships only `serverUrl` for a discovery-capable provider, or the
      hard-coded pair is justified and owned.
- [ ] `scopesHint` is the reviewed minimum, not the discovered set.
- [ ] Risk tier is justified against the provider's actual mutation surface.
- [ ] `ownershipModes` reflects what the provider advertises; `dcr` omitted for
      a provider Paperclip must not auto-register.
- [ ] Official artwork present, manifest row added, both brand checks pass.
- [ ] Slug registered so the definition is connectable at the intended
      visibility.
- [ ] Generator source and generated output are consistent in one change.
- [ ] Generated diff contains no semantic change to another provider.
- [ ] Catalog tests pass, with count assertions updated rather than weakened.
- [ ] Required, non-advanced fields are the minimum, and any addition to the
      default-path allowlist is justified.
- [ ] No credential value appears in any file, output, or report.
- [ ] Reuse path (MCP-direct / OpenAPI-shim / vendor-deep-wrapper) is recorded
      with the reason a lighter path is or is not enough.
- [ ] For a chat or email provider, `CHAT-CONNECTOR-UX.md` was read and applied;
      for every other provider it was correctly not applied.
- [ ] All nine production-validation scenarios are marked pass / fail / not run
      / not applicable, with reasons for the last two.
- [ ] The deployment support matrix is filled in, self-hosted first, with the
      four labels and no Cloud row claimed as `verified` without Cloud evidence.
- [ ] Account-bound lifecycle recorded as outstanding if it was not run.
- [ ] Report states executed versus source-inspected versus not done.
