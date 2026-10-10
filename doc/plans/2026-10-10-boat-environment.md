# Boat environments

Status: architecture selected; implementation integrated; live product verification in progress.

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
- Native idle expiry releases its owner after runner termination. Controller
  restart reconciles durable owners and authenticates the same runner before
  resuming; it does not start duplicate work. Legacy completion has no warm
  holder.
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
managed instructions, skills, and controlled credentials/configuration.

The instruction editor reads and conditionally writes live remote bytes. Path
confinement and atomic writes run on the remote host. Persistent placements
cannot enter the controller copy-back or working-copy deletion path. Moving an
agent to a different computer creates a separate placement; migration is outside
v1.

Realize project checkouts and task worktrees on Boat, before any host Git work.
Persist and validate repository, branch, and remote cwd there. Shared checkout
mode keeps ordinary Git contention; task worktrees remain independent. Native
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

Implementation must still prove PRP/reconnect, exact descendant retirement,
four real runtime paths, and native computer-tool image/approval handling.
Forced Kubernetes policy remains authoritative; Boat cannot bypass it.

## Evidence and verification

Provider qualification already demonstrated strict pinned SSH, private HTTP and
Cookie-authenticated WSS upgrade, Cua MCP initialization, an embedded Moonlight
desktop, user systemd units, and Vite HMR preserving unsaved browser input.
These are provider checks, not proof of Paperclip integration.

The completion matrix must pass locally and at the target staging instance:

1. Native Codex, native Claude, legacy Codex, and legacy Claude run simple tasks.
2. Two agents share one Boat with distinct homes and ports; cancellation of one
   leaves the other running.
3. Warm turns retain the exact runner process and Vite server. A task edit changes
   the visible preview without reload and preserves unsaved browser input.
4. Connect works for running and stopped computers; human input and native Codex
   screenshot/click/type address the same visible desktop.
5. Last-owner timeout suspends the machine; resume retains files. Viewer presence
   is bounded. Restart reconnects without duplicate execution.
6. Detach retains files; feature-off preserves cleanup; company access is enforced.

Retain source SHA, runtime versions, task/run IDs, sanitized URLs, screenshots,
process/stop receipts, deployment campaign and serving SHA, costs, and final
resource state. Run focused tests first, then required typecheck, tests, build,
module boundaries, and UI token gates before PR handoff. Never merge to master.

## Current implementation status

The computer ledger, Boat backend, execution target, persistent file access, and
Computer panel are integrated. Legacy Codex and Claude use explicit CLI engines
for in-place homes. Native Codex and Claude retain their native runner configuration.

Local qualification has demonstrated real native Codex, legacy Codex, and legacy
Claude execution; separate durable personal directories; native desktop capture
and app launch; browser desktop rendering and human mouse input; and bounded
viewer expiry. Native Codex's Vite source and proof file survived a Boat stop and
resume. A private Vite preview opened from the Computer panel passed the real
two-turn hot-reload test: its heading changed while its page-session value and
unsaved input remained unchanged.

Native Codex warm continuity is verified locally on controller source
`4596df2b89`: runner PID 31430, provider PID 31503, and Vite listener PID 32291
persisted across the two successful turns. The owner generation advanced while
the process launch generation stayed unchanged. Earlier failures exposed
systemd shell-variable expansion, overly short identity reads, and Boat's
invalidation of unlinked open stdin files; these have targeted fixes and tests.

Screenshots: [experimental toggle](assets/2026-10-10-boat/experimental-toggle.jpg),
[before the second turn](assets/2026-10-10-boat/native-vite-before.jpg), and
[after hot reload](assets/2026-10-10-boat/native-vite-after.jpg).

The configured idle timeout retired that exact runner and its Vite listener
while another agent's active admission kept the shared machine available.
A subsequent ordinary turn exposed an overly restrictive prior-owner recovery
check; exact retirement evidence is being integrated before repeating that path.

Native computer screenshot and app launch work, but keyboard navigation still
needs a passing visible result. Qualification found IBus listening on a
persistent-home socket whose filesystem node refused connections. Rebinding
the official daemon to a private runtime socket restored its health; actual
computer input and durable resume handling are being verified.

Native Claude's first provider-pack upload exceeded the existing 15-minute
bootstrap budget. The qualified pack includes all supported providers. Real
compressed-byte uploads with remote file writes and hash verification support
eight concurrent chunks; uploads now share a controller-wide limit of eight.
The full native Claude run still needs to pass with that change.

Required remaining evidence includes native Claude completion and warm turns,
native desktop keyboard control, exact last-owner process retirement, and the
same matrix on the final source revision at the designated staging instance.
Provider-only smoke checks do not substitute for these product journeys.
