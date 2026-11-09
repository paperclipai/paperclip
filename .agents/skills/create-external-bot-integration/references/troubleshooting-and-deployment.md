# Troubleshooting, test environments, and Cloud delivery

## Contents

- [Start with the failing boundary](#start-with-the-failing-boundary)
- [Stable public ingress is part of the test fixture](#stable-public-ingress-is-part-of-the-test-fixture)
- [Concrete OAuth and routing checks for the Dot implementation](#concrete-oauth-and-routing-checks-for-the-dot-implementation)
- [Symptom → discriminator → next action](#symptom--discriminator--next-action)
- [Keep one reproducible environment manifest](#keep-one-reproducible-environment-manifest)
- [Coordinate all Cloud pieces](#coordinate-all-cloud-pieces)
- [Classify a failure before retrying](#classify-a-failure-before-retrying)
- [Close the environment deliberately](#close-the-environment-deliberately)

## Start with the failing boundary

Do not use “OAuth is broken” for every setup failure. Trace these independent paths:

```text
A. Provider backend -> public origin -> discovery, MCP, token exchange
B. Provider browser -> authorization page -> preview/consent -> provider callback
C. Agent runtime -> loaded plugin actions -> authenticated read/tool calls
D. Paperclip event worker -> verified callback -> bot wake -> mailbox/challenge
E. Paperclip scheduler -> managed lease -> Runner -> tools -> finalizer -> cleanup
```

For each, collect a timestamp, exact failing operation, status/visible error,
correlated access log, and which party observed it. The developer's browser, the
provider's browser, and the provider's backend can have different reachability.
An absent request in complete ingress logs means that attempt did not reach the
app; it does not identify the upstream blocking rule.

## Stable public ingress is part of the test fixture

Prefer one stable HTTPS origin on port 443 reachable by both provider clients.
Keep issuer/resource, token exchange, authorization redirect, and callback
configuration consistent. Do not rotate tunnel hostnames as the first response to
every failure: each new URL can require a different plugin, fresh registration,
new pairing prompt, and subscription cleanup.

Self-hosted testing may need a tunnel or authorized public reverse proxy. Dot
eventually used a stable public proxy forwarding to the test machine. That is an
observed useful arrangement, not a requirement to provision new infrastructure
for every integration. Use the user's supported deployment/network options.

Tailscale-specific diagnostic: local MagicDNS may resolve a hostname to a private
tailnet address while outside clients use Funnel. Test public ingress independently;
local curl success does not establish public access. Tailscale Serve and Funnel
have different reachability. Never infer a provider port ban from one timeout.

`ERR_BLOCKED_BY_CLIENT` alone does not identify Cloudflare or a server bot filter.
Use server logs and the actual consent page, not only `/api/health`: Dot once
blocked the health navigation while the required sign-in page loaded. Do not
bypass browser security warnings or a provider's access controls. Use supported
configuration or an authorized reachable endpoint and preserve the exact uncertainty.

## Concrete OAuth and routing checks for the Dot implementation

These routes describe the October 9 candidate; discover current equivalents.

| Surface | Historical expectation |
| --- | --- |
| `/mcp/runner` unauthenticated | `401` and `WWW-Authenticate` with resource metadata; not an HTML sign-in page. |
| `/.well-known/oauth-protected-resource/mcp/runner` | Public JSON for the exact resource and authorization server. |
| `/.well-known/oauth-authorization-server/mcp/runner/oauth` | Public JSON for issuer and endpoints. |
| `/mcp/runner/oauth` | Dedicated agent-resource issuer; personal MCP issuer remained separate. |
| `/dot-connect/:requestId` | Public pairing page, scoped by request and one-use pairing capability. |
| `/api/dot-mcp/requests/:requestId` and exact pairing operations | Publicly routable aliases with request/code checks; reject personal assistant request IDs. |
| Normal board, connection management, ordinary personal consent | Retain normal session/role requirements. |

For read-only health checks, substitute the configured origin; do not send tokens:

```sh
curl --max-time 15 -sS -D - -o /tmp/dot-resource-metadata.json \
  'https://YOUR_CONFIGURED_ORIGIN/.well-known/oauth-protected-resource/mcp/runner'
curl --max-time 15 -sS -D - -o /tmp/dot-auth-metadata.json \
  'https://YOUR_CONFIGURED_ORIGIN/.well-known/oauth-authorization-server/mcp/runner/oauth'
```

Inspect JSON and redirect behavior, then exercise the actual provider discovery.
Do not interpret these curl checks as provider qualification. Keep browser cookies
and tokens out of pasted logs; use the existing authenticated test client when a
protected operation must be inspected.

ChatGPT's historical client metadata preferred `private_key_jwt` while also
advertising `none`. Paperclip originally rejected it instead of negotiating its
supported public-client method with PKCE. Inspect the complete advertised methods;
do not disable authentication or exact redirect/resource validation to work around
a preference mismatch. Keep S256 PKCE and current registration checks.

An optional `PAPERCLIP_MCP_AUTHORIZATION_ORIGIN` supported a different authorized
browser ingress to the same instance, while `PAPERCLIP_PUBLIC_URL` retained the
MCP resource/issuer/token origin. This was a workaround for different client
reachability, not an OAuth requirement. Use only explicitly configured trusted
origins and verify callback/CSRF/issuer behavior. Prefer a single working origin.

## Symptom → discriminator → next action

| Symptom | Evidence to inspect | Action and proof |
| --- | --- | --- |
| OAuth discovery times out | Public metadata vs actual provider access logs | Fix the failing ingress/client path; do not keep editing valid metadata when no request arrives. |
| Unknown client or redirect URI after restart | Persisted registration vs provider's cached client | Restore the intended persistent fixture or re-register through supported setup. Do not reset DB repeatedly. |
| Invalid request ID | Actual ID representation | Treat protocol IDs as opaque unless contract says otherwise; the lab incorrectly required a UUID. |
| Grant exists but provider is not connected | Complete same browser flow through callback/token exchange | A server grant row alone is not completed OAuth. Avoid mixing separate callback sessions. |
| Tools listed in settings, absent to bot | Actual tool invocation in active conversation | Supported refresh/attach/restart, bounded once per diagnosis; preserve endpoint and mark intervention. |
| Subscription verified but no bot action | Delivery record, mailbox, challenge/acceptance receipt | Separate callback receipt from model execution. Report latency; inspect actionable work before resending. |
| Ready connection, task admission says unpaired | Saved agent binding/config revision | Fix atomic pairing persistence; do not require another manual form save. |
| Agent created paused before pairing | Lifecycle preparing/verifying vs manual pause | Use lifecycle-specific setup eligibility; preserve actual pause/approval gates. |
| Anonymous consent spins/reloads | Background session probes returning expected 401 | Public consent must tolerate them without global reload; protected board routes retain session recovery. |
| Ordinary assignment works, idle work cannot acquire sandbox | Service construction / plugin context | Use app-configured admission service and test both entry points. |
| Remote Runner connects to localhost | Launched transport endpoint vs private managed ingress | Use the authenticated remote transport supplied by the execution target. |
| Image lacks provider support | Actual packaged Runner digest/capabilities | Fail before dispatch; publish compatible artifact and test installed path. |
| Recovery finds sandbox but no process identity | Marker, fingerprint and original checkpoint | Capture identity before dispatch; reconcile missing evidence rather than launch replacement work. |
| Remote PID has implausible start time | Whether controller inspected its own PID table | Obtain birth identity from the remote sandbox, not a colliding local PID. |
| Finished task starts again after comment | Mailbox + scheduler wake receipt | Consume only when exact comment read succeeds; test unread-at-finish and read-before-finish. |
| Missing file leaves run waiting forever | Pending tool receipt and error dispatch | Settle definite read failures; preserve unknown outcome only for genuinely ambiguous effects. |
| Terminal run blocks all new tasks | Assignment still active despite terminal run | Reconcile/fence it and release resources without claiming external stop. |
| Cancelled job has creating/pending-cleanup sandbox | Provider allocation and deletion receipts | Track until destroyed or explicitly pending with owner; retry only per provider semantics. |
| New deployment vanishes mid-test | Fleet auto-rollout vs direct candidate | Use supported test-tenant pinning with authorization; record current serving revision. |

## Keep one reproducible environment manifest

Before a test drive or deployment, resolve current worktree/artifacts and reuse a
suitable isolated checkout. Do not reset the user's primary checkout. Create a new
managed worktree when appropriate, preserving unrelated work. Record:

```text
Repository / worktree / branch / app SHA:
Runner artifact platform / digest / advertised capabilities:
Ingress repository / SHA / relevant routing version:
App image / immutable digest:
Local host / port / data directory / process ownership:
Public origin / authorization origin / forwarding target:
Tenant / company / agent identifiers (private evidence only):
Sign-in entry and credential reference (no secret values):
Grant/binding status / subscription / pending code expiry (no code value):
Current case / run / assignment / lease:
Owner of each server, proxy, build, sandbox, and cleanup:
Environment retention agreement / next gate:
```

Use synthetic fixtures, not a production database clone containing private company
data or signing keys. Verify launcher arguments, selected instance, port mapping,
and data persistence after restart. A label such as `default` is not proof of
process ownership. Never kill unrelated databases or clear shared IPC globally.
If resource pressure blocks the fixture, inspect owned processes or use the
approved remote test path; preserve unrelated sessions.

Verify sign-in is usable before handing over a URL. Deliver access/resume details
through an appropriate private path. If the user is still testing or the bot is
loading tools, keep the endpoint alive under the agreed bounds. Stopping it made
the first “tools unavailable” diagnosis premature. Announce an intentional expiry
and explain how to resume; do not assume a stopped shell process remains a service.

## Coordinate all Cloud pieces

Cloud qualification requires the tenant app, public ingress, managed provider
plugin/configuration, and packaged Runner artifact. The UI flag alone is not
enablement. Inspect guards in UI, scheduler, backend, remote launcher, and Cloud
front door. Use scoped route exceptions that retain endpoint authentication rather
than removing browser-session guards wholesale.

Pairing and MCP must remain reachable without a managed job. If a sleeping tenant
returns a waking-up page, wait for the actual lifecycle transition, then test the
correct metadata response. Delay creating expiring pairing codes until the tenant
image is deployed and serving. A 3.4 GB image transfer consumed meaningful setup
time during Dot qualification; do not burn the code's lifetime watching a build.

Record whether a test overrides the sandbox binary with a locally built artifact.
That proves the code can run, not that the published default image is correct.
Match platform and provider capability; a Mac controller's current binary cannot
stand in for a Linux sandbox artifact. Digest/capability checks should fail clearly
before an assignment is offered.

For the historical private `paperclip-cloud` repository, the supported targeted
deployment CLI was `scripts/deploy-stack.mjs <workspace-url> <ref> --plain`, with
`--resume <request-id>` for the same operation. Inspect current help/runbook before
using it. Do not invent or replay old tenant IDs, deployment requests, or secrets.
Preserve one request through prepare/build/check/deploy/verify; duplicated requests
make provenance and recovery harder. No fleet-default change is implied by a
single test-tenant deployment.

## Classify a failure before retrying

- **Product:** deterministic missing context, bad state transition, wrong endpoint,
  lost receipt. Reproduce, fix, and rerun the affected contract.
- **Provider:** tool loading, wake delay, refusal, unsupported control. Capture the
  actual provider result and test a supported recovery; don't manufacture success.
- **Infrastructure:** capacity, registry 429/504, image transfer, npm resolver,
  provider allocation. Verify whether work/effects started; use bounded recovery.
- **Evidence/test:** controller didn't restart, stale build, nonce visible in prompt,
  wrong image, scripted client presented as real. Correct the experiment.

For an unchanged transient build failure, one targeted infrastructure retry is a
reasonable initial bound. If it fails again, report the precise remaining gate
or investigate the new cause; do not loop reruns or change registry/security
configuration without a task-grounded reason. Resume the existing deployment.
If code changes, re-evaluate which earlier evidence applies to the new candidate.

Keep broad test runs tied to a frozen revision. Stop superseded owned runs when
safe, retain their results, and run the affected suites plus required final gates.
Do not claim a full local suite passed because failing tests passed individually;
state focused results and final CI separately.

## Close the environment deliberately

After the final task, inspect leases and actual provider resources. Expired lease
status alone is weaker than a successful sandbox deletion receipt. Preserve a
requested review instance with access and resumption information; release owned
disposable compute. For an authorized reset, account for provider account link,
Paperclip binding/grant, event subscription/automation, and cached configuration.
Disconnecting one layer can leave an enabled provider automation behind.

Report qualified, review-ready, merged, deployed, and canary-verified separately.
Never say an instance received a fix until its serving revision and relevant
ordinary-use behavior establish it.
