# OpenAI Dot runner prototype

The reference prototype is now accompanied by an experimental Rust Runner
provider, dedicated `/mcp/runner` agent connection and durable broker. See
[OpenAI Dot with Paperclip Runner](openai-dot-runner.md) for setup and the
current qualification limits. The transport proof below remains specific to
this reference harness.

Built 2026-10-02 on the public MCP foundation from `codex/paperclip-mcp-experimental-setting`
(commit `a88448f77`), merged into the fresh `codex/dot-events-prototype` worktree.

This is a working **protocol prototype**, not a production-selectable Dot
agent. The default demo's Dot peer and task authority are synthetic. That demo
does not contact OpenAI, spend model credits, or modify an existing company.
The optional live lab below is intended to connect an actual Dot. The new provider
implements the runner's `HarnessDriver` contract and executes through
`HarnessDriverBackend`; it does not use the legacy HTTP adapter.

## Try it

After installing and building workspace dependencies:

```sh
pnpm prototype:dot
```

The command creates a temporary PostgreSQL database, company, user and task;
creates a real OAuth grant through PKCE and consent; starts two loopback HTTP
servers; subscribes to a signed event; and drives a runner assignment to
completion through authenticated MCP. It prints each successful stage and
removes the temporary state. Its synthetic Dot peer deliberately retries a
write concurrently to prove there is only one report. No credentials are
printed. This is a CLI demo, not a mock UI or a connection to your Dot account.

Fresh-worktree preparation (use the repository's pinned pnpm version):

```sh
pnpm install --no-frozen-lockfile
pnpm --filter '@paperclipai/server^...' --filter '!@paperclipai/paperclip-runner' --filter '!@paperclipai/ui' build
```

The local callback uses an injected transport restricted to one fixed synthetic
HTTPS URL and rewrites it to loopback. The production event transport retains
its HTTPS, public-IP DNS pinning and no-redirect checks.

## Connect a real Dot to the disposable lab

The separate live lab uses the real remote webhook transport, with no synthetic
Dot peer or callback override. It still uses synthetic task admission and one
projected `save_report` tool, so it is a transport acceptance test, not production
agent scheduling. It requires an existing Dot account with custom plugins.

Expose **only port 43127** through an HTTPS tunnel, then run:

```sh
cloudflared tunnel --protocol http2 --url http://127.0.0.1:43127 --no-autoupdate
DOT_LAB_ORIGIN=https://YOUR-TUNNEL-HOST pnpm prototype:dot:live
```

Add `https://YOUR-TUNNEL-HOST/mcp/paperclip` as an OAuth MCP plugin in the
account that owns the Dot. The consent page waits for local operator approval.
The lab prints a local `control.json` path; it contains a temporary credential,
must stay local, and is removed when the lab stops. The separate control port
(43128 by default) must never be tunneled. Inspect the pending client and return
origin before approving its exact request ID:

```sh
node server/scripts/dot-runner-live-control.mjs /path/to/control.json status
node server/scripts/dot-runner-live-control.mjs /path/to/control.json approve REQUEST_ID
```

The consent page then returns to ChatGPT. Give Dot the standing instruction
printed by the lab, including the exact company and inbox task IDs. Wait for a
verified `paperclip.dot.work_available` subscription in `status`, then publish
the assignment from Paperclip's side:

```sh
node server/scripts/dot-runner-live-control.mjs /path/to/control.json queue
node server/scripts/dot-runner-live-control.mjs /path/to/control.json status
```

The expected result is a signed event delivery, Dot reading and accepting the
assignment, a report saying `17 + 25 = 42`, and a structured runner completion.
A delivered webhook alone is not a passing test. `status` exposes the report,
runner transcript and delivery outcome only over authenticated loopback.
Keep the lab and tunnel running while ChatGPT loads the newly installed tools;
the plugin directory can list them before Dot can invoke them. A stopped quick
tunnel cannot be reused just by restarting the lab. A new tunnel address needs
a plugin configured for that address and fresh OAuth consent. Restarting the
lab also discards its OAuth client registrations and grants.
Stop the lab with the local control command (`... control.json stop`), then stop
the tunnel after the test. Use this command for reliable cleanup; development
process wrappers may terminate on a signal before asynchronous cleanup finishes.
The lab expires after two hours,
revokes its connection on graceful shutdown, and deletes its temporary database
and encryption key. It never opens the user's existing Paperclip database.

## Two directions, two explicit identities

```mermaid
sequenceDiagram
  participant Host as Paperclip host
  participant Runner as Dot runner bridge
  participant MCP as OAuth MCP + event outbox
  participant Dot as OpenAI Dot
  Host->>Runner: Admitted task + explicit grant/agent binding
  Runner->>MCP: Persist work_available references
  MCP->>Dot: Signed webhook wakeup
  Dot-->>MCP: Receipt (does not mean work started)
  Dot->>MCP: Read inbox and assignment; accept
  MCP->>Runner: Authenticated, bound commands
  Runner-->>Host: PRP turn.started
  Dot->>MCP: Call projected tools / report progress / propose result
  MCP->>Runner: Check current authority; deduplicate request ID
  Runner-->>Host: PRP progress and structured result
  Note over Host: Paperclip decides final task disposition
  Dot->>MCP: Personal Paperclip reads/writes while idle
  Note over MCP: These retain the consenting person's identity
```

Dot's always-available personal tools come from the merged public MCP connection.
They act as the person who consented. Agent participation is separate: a trusted
host binds an already admitted run to one OAuth grant, company, agent, task,
session and turn. Connecting or selecting a task never grants impersonation.
The registry has no MCP registration tool and no generic API executor.

## What is implemented

- `DotHarnessDriver`: one turn per admitted run, explicit acceptance, bounded
  lifetime, projected tools, progress and validated `paperclip.run_result.v1`
  completion. Reports normal PRP events consumed by the existing native backend.
- `createDotRunnerMcpBridge`: six tools on the existing authenticated endpoint:
  `paperclip_dot_inbox`, `paperclip_dot_read`, `paperclip_dot_accept`,
  `paperclip_dot_tool`, `paperclip_dot_progress`, `paperclip_dot_finish`.
  Bound tools are visible only to the selected grant with write consent.
- Optional `paperclip.dot.work_available` event on the existing durable outbox.
  Its `companyId` and `taskId` identify a designated standing inbox task. Each
  assignment can concern a different task; the event carries only IDs, and Dot
  retrieves the current assignment through authenticated tools. Existing
  authorization, encrypted callback material, signed verification, retry,
  expiration, rotation and unsubscribe behavior are reused.
- Matching duplicate commands share one receipt, including simultaneous writes.
  A changed retry is rejected. Ambiguous writes remain `unknown` and are not
  redispatched. Per-run receipts are memory-only in this prototype.
- Revocation/expiry prevents further accepted commands and ends event waiting.
  The live host authority callback runs for each new operation and before
  returning tool output. The host's tool dispatcher must enforce atomic domain
  permissions, pause, ownership, approvals and budget checks at the actual write.
- Usage and cost remain unknown. Delivery does not fabricate a started turn.
  Result acceptance proposes a disposition; it does not directly set issue status.

## Host wiring and the production gap

The detailed implementation proposal is in
[OpenAI Dot as a production Runner provider](plans/2026-10-02-openai-dot-runner-adapter.md).

The default app does **not** construct the bridge or advertise the Dot event.
The host must explicitly pass `enableDotPrototype: true` to
`createPublicMcpEvents`, pass the bridge as the fourth argument to
`publicMcpIngressRoutes`, and register a driver for a trusted admitted run.
The lab demonstrates that composition with synthetic admission and a single
synthetic projected tool. There is no production scheduling integration yet.

Do not enable this by supplying a fake Codex profile to the native execution
factory or by creating a heartbeat row from an MCP request. Production needs:

1. An explicit governed agent binding/consent and a qualified Dot provider in
   native admission, with task checkout, budgets, pause and policy checks.
2. Durable provider mailbox and command receipts, reconnect/recovery and
   reconciliation of uncertain tool outcomes. The event outbox already persists;
   this prototype's runner registry does not. After restart it refuses recovery.
3. Server-owned runtime tool projection/dispatch with ordinary audit receipts.
   The lab tool is not the production runner tool authority.
4. A stop policy that can handle remote autonomy honestly. Revoking Paperclip
   access cannot prove that Dot or its child tasks stopped. Active close reports
   `provider stop is unconfirmed`; interruption, steering and resume are not
   advertised. `dot-bridge:<session>` identifies this bridge, not an OpenAI task.
5. A reachable staging deployment, real Dot plugin onboarding, and a live
   event-triggered assignment before claiming client compatibility or release
   readiness. Hosted use also needs the companion Cloud broker deployed.

An existing in-flight external write can finish after revocation. Do not retry
with a fresh request ID to force a result. Inspect authoritative task state.
Unregister completed runs to release the bounded in-process registry.

## Intended live onboarding

1. Connect the existing Paperclip MCP plugin in developer mode and consent to
   the team and requested writes.
2. Explicitly bind that connection to the chosen Dot agent after the production
   admission work above. Show the identity and the standing inbox task.
3. Give Dot one standing instruction to subscribe to `paperclip.dot.work_available`
   for that inbox, inspect current assignments, accept intended work, use the
   projected tools, and finish with a structured result. Treat duplicate events
   as wakeups, never as another task. Avoid comment-acknowledgement loops.
4. Assign work in Paperclip and verify the entire loop with the actual account.

OpenAI now documents MCP Events for dots. Private developer-mode testing does
not require a public directory listing; public distribution is a separate review.
See [MCP Events](https://developers.openai.com/plugins/build/mcp-events),
[developer mode](https://developers.openai.com/api/docs/guides/developer-mode),
and [app review](https://developers.openai.com/plugins/deploy/app-review).

## Verification

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run src/drivers/dot/dot-harness-driver.test.ts
pnpm --filter @paperclipai/server exec vitest run src/__tests__/public-mcp.test.ts
pnpm prototype:dot
```

Runner tests cover native PRP validation, cross-company/grant/turn rejection,
unknown outcomes, concurrent retries, expiry, live authority checks, malformed
results, late writes, revocation and unsupported recovery. The MCP suite checks
real OAuth, event signatures, the opt-in catalog, personal-tool coexistence and
revocation. The CLI demo uses real TCP for both directions.

Recorded validation: eight runner tests passed; all 37 MCP tests passed; the
changed Dot scenario passed again after the final uncertainty-handling fix;
runner and server TypeScript checks passed; the loopback CLI demo passed.
Shared/server dependency builds and the runner TypeScript build also passed.
The repository-wide test/build, Rust provider qualification and hosted Cloud
acceptance were not run. Actual Dot acceptance is recorded below. This is not
a PR-ready production provider handoff.

Live-lab setup on 2026-10-02: the isolated server started, its public OAuth
discovery endpoint returned 200, and unauthenticated MCP requests returned 401.
The live script passed an explicit TypeScript check, and the 37 MCP regression
tests passed again after changing the bridge to a structural driver interface.
During that initial setup, no actual Dot connected or subscribed: native desktop automation was unavailable,
and the inspected browser account showed Dot creation rather than an existing
Dot. The temporary tunnel subsequently expired; it and the lab were stopped.
The later attempts below used the correct existing Dot account.

### Actual Dot attempt, 2026-10-02

With the existing Dot open in the correct Chrome profile, the user approved
installing the private `Paperclip Dot Lab` plugin and its lab-only OAuth grant.
The first real callback exposed a lab bug: OAuth consent request IDs are opaque
`pcmcp_request_` tokens, not UUIDs. The live script now validates that format.
Restarting the disposable database also erased ChatGPT's cached public client
registration. The exact public client ID and redirect URI were restored only in
the verified one-company lab database; no grant or token was inserted directly.
The normal consent and PKCE exchange then completed successfully.

Chrome briefly showed `ERR_BLOCKED_BY_CLIENT`; after the user handled/retried the
page, it showed the ordinary stale-client server error instead. The browser
block's originating component was not identified. No browser protection was
disabled. It should not be confused with the separately diagnosed OAuth error.

Observed live results:

- ChatGPT called authenticated `server/discover`, `tools/list`, and `events/list`
  using MCP 2026-07-28; all returned HTTP 200.
- The plugin UI showed its connected account, 10 read tools, 6 write tools, and
  all four event definitions, including the six Dot runner actions.
- Dot found `paperclip.dot.work_available` and recognized its argument schema.
  Initially it reported no Paperclip action tools in its runtime, including the
  read-only `paperclip_connection`. An explicit @ mention did not make them
  available immediately.
- Dot also reported that its event-subscription route requires a successful
  read-only connection check, so the reduced event-only test could not proceed.
- The lab observed **zero `tools/call` or `events/subscribe` requests**, zero
  subscriptions, and zero deliveries. No assignment was queued and no report
  was saved. This is live discovery/connection evidence, **not** an end-to-end
  task or event-wakeup pass.

The first lab and tunnel were stopped too early, revoking the temporary grant
and deleting its database. Dot subsequently reported that the action tools had
become available, but its connection check failed against that offline endpoint.
This does not establish a Dot runtime incompatibility. A fresh lab and tunnel
were connected as `Paperclip Dot Lab Retry`; the new server observed Dot calling
`paperclip_connection` successfully. The first plugin definition remains
installed with its expired endpoint. Production still needs the admission,
durable mailbox, recovery and tool-authority work above.

### Successful real Dot retry, 2026-10-02

The replacement private plugin completed fresh dynamic client registration,
normal OAuth consent and PKCE without manual database repairs. It used the real
Dot in the user's Chrome account and the public HTTPS tunnel. The lab retained
the ordinary callback verification, DNS/IP pinning and webhook signing checks.

Observed server evidence (UTC):

| Time | Observation |
| --- | --- |
| 22:16:30 | Dot called `paperclip_connection` successfully. |
| 22:17:00 | `events/subscribe` succeeded; the verified `paperclip.dot.work_available` subscription was present. |
| 22:17:24 | The operator queued the single assignment. Its webhook was observed as `delivered` after one attempt. |
| 22:17:48 | Dot called `paperclip_dot_inbox` after the event, without another chat prompt. |
| 22:17:56 | Dot read the assignment using `paperclip_dot_read`. |
| 22:18:10 | Dot accepted it; the native Runner emitted `turn.started`. |
| 22:18:23 | Dot called `save_report` through `paperclip_dot_tool`; the lab saved exactly one report: `Dot received the Paperclip event. 17 + 25 = 42.` |
| 22:18:38 | Dot submitted a valid `paperclip.run_result.v1`; the Runner emitted `run.result.proposed`, `turn.completed` and `run.terminal` with state `succeeded`. |
| 22:18:50 | `events/unsubscribe` succeeded; no subscription remained. |

Dot's final chat message confirmed event receipt and completion. It could not
confirm complete unsubscription from its client response, but the server
independently recorded the successful unsubscribe. Removing the subscription
also removed its delivery rows, so delivery was verified before that cleanup.
Dot separately disclosed an accidental cloud desktop app inventory call during
setup; it reported opening no app content and stopping immediately. This test
proves the transport and Runner handshake, not isolation of Dot's other tools.

This is a **real event-triggered, two-way transport acceptance pass** using the
new Runner backend. It still uses synthetic admission, one disposable task and
one projected tool. It does not establish production scheduling, recovery,
budget enforcement, arbitrary personal API operations, or reliable remote stop.
The replacement lab was left running for inspection under its two-hour expiry;
the test subscription was removed and no further assignment was queued.
