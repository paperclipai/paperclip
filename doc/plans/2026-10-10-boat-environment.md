# Boat environments

Status: implemented on experimental, unmerged branches. Local and staging qualification is recorded separately; remaining failures are explicit.

## Problem and finish line

Attach an existing Boat to a Paperclip environment. Several agents can run on
that computer, each with a persistent personal directory. Native Paperclip
Runner sessions stay warm for their configured timeout. A human can connect to
the shared desktop from a task's Computer tab, and native Codex can control that
same desktop. A Vite server started by the agent remains available across warm
turns and updates the human's browser through HMR.

Ship behind `enableBoatEnvironments`, disabled by default, on an unmerged branch
and PR. Verify locally and at the designated experimental staging instance using the same
source revision. V1 attaches computers; it does not provision or delete them.

## Product flow

1. Enable the experimental Boat environment feature. Add an environment with
   provider Boat, an existing Boat ID, and its API key. Paperclip stores the key
   as an encrypted secret. The Boat must have persistent storage enabled.
2. Assign agents to that environment. Use Paperclip Runner with Codex or Claude
   for native execution, or choose the explicit CLI engine for a legacy adapter.
   Set the native runner's warm timeout to the desired development window.
3. Start a task normally. Each agent uses its own persistent `AGENT_HOME` on the
   same Boat. Native Codex can use its computer tools on the shared desktop.
4. Open the task's Computer tab and click Connect. Use Open preview with the
   development server's port to open the private app URL in a browser tab. Vite
   may require that exact preview hostname in `allowedHosts`.

A dev server must detach from the provider tool's shell process group, for
example with `nohup setsid ... </dev/null >vite.log 2>&1 &`. It remains owned by
the runner and ends when that runner's warm timeout expires. The source files
persist; a later turn can restart the server. Connecting the desktop gives a
separate bounded viewer hold, not indefinite runner warmth.

## Usage (caller's view)

The existing environment orchestrator remains the entry point for all four
execution paths: native Codex, native Claude, legacy Codex, and legacy Claude.

```ts
const lease = await environmentRuntime.acquireRunLease(request);
const workspace = await environmentRuntime.realizeWorkspace(lease, intent);
const target = await resolveEnvironmentExecutionTarget(lease, workspace);
// Existing adapter/native execution consumes the command-backed target.
// Its exact session owner receives active, warm, and stopped transitions.
```

```ts
await agentFileStore.write(actor, agentId, edit); // live remote content + CAS
const viewer = await computers.connect({ companyId, issueId, environmentId, userId });
// viewer URL lives only in component memory; durable tab state stores IDs.
```

## Shape

Paperclip owns one durable computer ledger. A narrow Boat backend owns provider
API parsing, SSH registration, host-key pinning, private port authentication,
desktop credentials, resume, TTL renewal, and snapshot-preserving stop.

The `computers` module follows the repository's domain/application/adapters
boundaries. Its public entry point hides machine operations, owner generations,
port allocation, and process retirement. Existing adapters consume execution
capabilities; they do not call Boat APIs.

```ts
type ResourceAuthority =
  | { kind: "allocation"; providerLeaseId: string }
  | { kind: "computer-owner"; computerId: string; ownerId: string; generation: number };

type FileAuthority =
  | { kind: "controller-copy" }
  | { kind: "remote-persistent"; placementId: string; root: string; agentHome: string };

type ComputerOwner =
  | { kind: "runner"; sessionKey: string; phase: "starting" | "active" | "warm" | "retiring";
      runId: string; generation: number; idleDeadline: Date | null;
      port: number; process: ProcessClaim | null }
  | { kind: "viewer"; userId: string; expiresAt: Date; absoluteDeadline: Date }
  | { kind: "file-operation"; operationId: string; expiresAt: Date };

type ProcessClaim = { bootId: string; unitName: string; nonce: string; launchGeneration: number };
```

### Lifetime and ownership

- Bind each physical Boat to one company and one controller. An instance-wide
  environment row is not sufficient authorization for the shared desktop.
- Use unique owners for attempts/sessions, separate from the physical Boat ID.
  Warm reuse advances the owner generation while retaining process identity and
  listener port. Late callbacks cannot retire the successor.
- Persist ownership before launch. Retire only the exact owned process group;
  use a user systemd unit with a generation/tombstone to reject delayed launches.
  A closed SSH socket does not prove descendants stopped.
- Persist machine operation intent before provider I/O. Close admission while a
  stop is unresolved. Boat exposes a stop operation ID/status; reconcile that
  operation before allowing a new admission. Never request forced stop.
- Suspend only when all owners have settled. Renew Boat's absolute TTL while
  owners require the computer. A timed-out controller operation is not proof
  that remote work ended. Preserve independent cleanup failures without
  replacing a successful task result.
- Native idle expiry fences admission and reserves the exact owner generation
  for graceful runner suspension. The checkpoint remains on Boat. A bounded
  30-second shutdown interval permits protocol close before mandatory exact
  descendant retirement; this is not extra usable warm time. Crash reconciliation
  hard-retires after that interval. Stale callbacks cannot close a successor.
  Controller restart reconciles durable owners and authenticates the same runner
  before resuming; it does not start duplicate work. Legacy completion has no
  warm holder.
- Human Connect creates a bounded hold using the runner warm timeout. Visible
  presence may renew a short liveness deadline within that bound; an idle open
  tab cannot keep the computer running forever. UI says Connect/Connecting.
- Detach fences new work, retires owned processes, and retains the computer and
  files. The backend has no physical-delete operation. Disabling the feature
  blocks new admission while preserving recovery and cleanup.

### Files and workspaces

Boat is authoritative for personal files and project/task bytes. Deterministic
company/agent roots remain distinct from protected provider HOME/CODEX_HOME and
runtime assets. First placement seeds an absent personal directory once; an
existing directory is adopted without replacement. Later turns deliver only
managed instructions, skills, and controlled credentials/configuration. Build-owned provider packs are
verified and cached by content digest within each agent's runtime directory.
New task sessions reuse those immutable bytes without repeating compression or
upload. Publication is atomic and never replaces an existing shared pack;
corrupt cache entries fail closed. A never-retried interrupted upload may retain
its private staging directory for operator cleanup. Managed instruction and skill
bundles use immutable per-attempt snapshots so read-only files from a prior
attempt cannot block preparation. Prior generated snapshots remain on disk in
this experimental version; automatic snapshot garbage collection is deferred.

The instruction editor reads and conditionally writes live remote bytes. It
limits traversal to 1,000 metadata entries and the existing content budget,
reads the configured entry independently, and reports partial results in both
the editor and exports. Path
confinement and atomic writes run on the remote host. Persistent placements
cannot enter the controller copy-back or working-copy deletion path. Moving an
agent to a different computer creates a separate placement; migration is outside
v1.

Realize project checkouts and task worktrees on Boat, before any host Git work.
Persist and validate repository, branch, and remote cwd there. Shared checkout
mode keeps ordinary Git contention; task worktrees remain independent. Initial
clone and worktree setup use a project-scoped remote lock so another agent cannot
mistake a partially created directory for a ready checkout. Native
recovery descriptors explicitly record remote authority. Both legacy adapters
use in-place workspace staging. Remote file browsing uses the same placement
authorization rather than interpreting remote paths on the controller.

### Transport and computer interface

The command-backed execution target carries an allocated listener port, file
authority, process ownership, and ingress capability. Generalize the existing
sandbox command consumer through one shared classifier, preserving existing
sandbox literals and allocation semantics rather than renaming all transports. Rust
runnerd already supports configurable ports; the host must propagate them.

Boat's private hosting URL bootstraps `_port_auth` server-side. Runner ingress
gets a clean WSS URL and secret Cookie header. PRP still authenticates the exact
runner. A local Paperclip controller needs no publicly reachable endpoint.

The Computer tab reuses the existing task side panel. Board/company/environment
authorization precedes Connect. Moonlight credentials are no-store, no-referrer,
memory-only, and refreshed before expiry. Human and agent input share one
desktop without a Paperclip mutex.

Native Codex gets an explicit server-authorized local stdio computer binding:
`/opt/ascii/cua-driver/cua-driver mcp --socket /run/ascii-cua/driver.sock`.
This is separate from assigned Apps and is materialized into its isolated
provider configuration.

Preview access validates an owned app port and performs an authenticated browser
launch to the hosted origin. HMR uses the same origin/cookie. Durable preview
records contain attachment and port identity, never bearer URLs. A machine
suspension ends ordinary processes; a later task restarts its server from the
preserved files.

## Synthesis decision

Base: host-owned computers and remote placement. The competing provider-owned
design reused the sandbox plugin consumer but required new durable plugin CAS
and scheduling infrastructure while Core still needed ownership callbacks and
remote file authority. Keeping the ledger in Core makes those policies have one
owner and avoids exposing plugin bookkeeping to file, recovery, and UI callers.

Grafts from the provider-owned proposal: use an explicit allocation/attached-owner
resource union with durable warm settlement before acknowledgment, and distinguish
editor conflict checks from arbitrary shell writes. Hash checks reject an already
stale editor save; an uncooperative shell writer can still race atomic replacement.
Do not add a second provider ledger. Both proposals independently
converged on remote file authority, exact process ownership, bounded viewers,
reserved ports, and no dependency on the unfinished computer task-admission stack.

The independent cross-judge scored the provider-owned design 18/25 and host-owned
design 20/25. Parent scores were 19/25 and 22/25 respectively, agreeing on the base.
The five criteria were journey coverage, ownership/recovery, interface depth,
integration/deployment, and implementability/evidence. Two independent designs
used gpt-6-astra; the cross-judge used gpt-6.1-sol. Neither review certifies the
implementation. Machine-action generation, owner-claim generation, and process
launch identity must be separate; a host database fence alone cannot cancel an
already accepted Boat stop. Reconcile the provider stop ID before new admission.

## Nicky's work

- Reuse merged agent lifecycle work (#15343, #15631), including its single
  admission/readiness owner. Do not introduce a parallel agent state machine.
- Reuse configurable runnerd ports from #15353, already in this checkout.
- Core #15406 (`codex/plugin-task-execution`) separates attempts from machines,
  but its open contract does not yet have a native heartbeat startup consumer.
  Its identity lessons apply; cherry-picking it does not implement Boat.
- Keep desktop access separate from task admission. Provisioned-computer stacks
  that delete machine volumes on release do not fit attach-only Boat semantics.
  Detach must preserve the existing computer and its files.

## Tradeoffs and risks

We accept a Core computer domain in exchange for one owner of shared lifetime
and storage policy. We accept one Unix user in exchange for a shared desktop;
separate folders are organizational separation, not a security boundary. We
accept remote editing depending on Boat availability in exchange for honest file
authority.

Cold startup and remote editing depend on Boat availability and can take minutes.
Managed snapshots and abandoned private uploads retain disk space until operator
cleanup. Forced Kubernetes policy remains authoritative; Boat cannot bypass it.

## Qualification and delivery

The finish line is four real runner paths, persistent separate homes on one
computer, native Codex computer use, a human-controlled browser desktop, and
Vite hot reload across warm turns. Idle expiry must stop owned processes while
preserving files; reconnect must not duplicate execution. Detach and feature-off
behavior must retain cleanup, and routes must enforce company access.

[Validation and evidence](2026-10-10-boat-validation.md) distinguish browser
journeys from process receipts and automated checks. Each result retains its
source revision. A connection probe, a generated screenshot, or an agent's
statement alone does not prove the complete journey. Staging hot reload remains
blocked by the test browser; it is not counted as passed.

Implementation is split into [Core #15813](https://github.com/paperclipai/paperclip/pull/15813)
and dependent [UI and acceptance #15804](https://github.com/paperclipai/paperclip/pull/15804).
Both remain unmerged.
