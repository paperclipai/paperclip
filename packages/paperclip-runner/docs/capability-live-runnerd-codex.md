# Capability live runnerd and Codex loop

> **Reference lab, not the production sandbox topology.** This API remains the
> runner-lab/session implementation used by UI and recovery tests. Production
> sandbox execution and live protocol evals use the Rust-owned bridge described
> in [`../../../doc/plans/2026-08-20-single-daemon-runner-tool-bridge.md`](../../../doc/plans/2026-08-20-single-daemon-runner-tool-bridge.md): external control plane → PRP → one Rust `paperclip-runnerd` → provider. The TypeScript dispatcher below does not run in the sandbox.

Capability binds the provider-neutral semantic catalog to a real package-local
`paperclip-runnerd` process and a real Codex app-server session. Paperclip data
remains deterministic mock state behind `ControlPlanePort`; no request reaches
the Paperclip API.

## Process and authority boundary

The process chain is:

```text
CapabilityLiveSession -> paperclip-runnerd -> codex app-server
                  -> CapabilitySemanticDispatcher -> ControlPlanePort mock
```

`paperclip-runnerd` owns the Codex child and proxies newline-delimited JSON-RPC
over stdio. The transport starts a dedicated Unix process group. Normal close,
stop/reset cleanup, and fatal protocol errors terminate that group with a
bounded TERM/KILL sequence so a Codex child is not abandoned.

Only the allowlisted Codex host environment is copied. `PAPERCLIP_*` variables,
provider credentials other than Codex's server-side home, and credentialed
proxy URLs are not passed to runnerd or Codex. Model-issued commands still use
the separate skillless, network-disabled workspace permission profile.

## Stable session API

Production workers import the live entrypoint and bind a durable store to the
attempt's immutable authority tuple:

```ts
import {
  CapabilityLiveSessionService,
  DurableCapabilityLiveSessionStore,
} from "@paperclipai/paperclip-runner/live";

const binding = { sessionId, runId, companyId, actorId, taskId };
const store = new DurableCapabilityLiveSessionStore({ directory, binding });
const service = new CapabilityLiveSessionService({ store });
const session = await service.create({ ...binding, attemptId, workingDirectory });
const turn = await session.sendMessage("Read the mock task and report progress.");
await session.interrupt(); // only when a turn is active
await service.stop(session.id);
```

After a worker terminates, a new worker must construct a new service and use the
production resume entrypoint. It must not call `create` again:

```ts
const resumed = await new CapabilityLiveSessionService({ store }).resume({
  sessionId,
  attemptId: resumeAttemptId,
  resumeOf: killedAttemptId,
});
await resumed.reconcileActiveTurn();
```

`resume` first commits the killed attempt as `terminated` and the successor as
`running`. Only then does it start runnerd, read the checkpointed provider
thread, and resume that exact thread. A missing or corrupt checkpoint, authority
binding mismatch, attempt-lineage mismatch, or provider thread/session drift
fails closed. The killed attempt and its usage remain immutable.

The handoff surface for later tracks is:

- `create(input)` starts runnerd, Codex, one mock run, and one dynamic-tool thread.
- `sendMessage(text)` supports repeated turns on the same provider thread.
- `pendingInteractions()` and `resolveInteraction(input)` preserve typed human
  interactions and return their results to that same thread.
- `reconnect(sessionId)` closes the old process group, starts a fresh runnerd and
  Codex app-server, then reads and resumes the persisted provider thread.
- `restore(sessionId)` recreates mock state, transcript, authority, authorization
  records, pending interactions, and the provider thread from a stored snapshot.
- `resume({ sessionId, attemptId, resumeOf })` is the cross-worker production
  path and records distinct linked attempts before provider recovery.
- `recordUsage(receipt)` durably commits an attempt-bound, exactly-once provider
  response receipt before the caller acknowledges that response. Reusing a
  receipt with different contents fails closed.
- `reconcileActiveTurn()` interrupts and records the terminal fact for a turn
  that was active in the checkpoint when its worker terminated.
- `interrupt(reason)` cancels only the active turn and retains session authority.
- `service.stop(sessionId)` clears authority and reaps the process group;
  `reset` also deletes the old snapshot and restores the original clean mock
  seed under new run/session authority.

`DurableCapabilityLiveSessionStore` writes a checksummed, revisioned checkpoint
with atomic rename plus file and directory fsync. It persists provider identity,
mock state and semantic idempotency receipts, attempt lineage, active and
terminal turn facts, and the usage ledger. The included in-memory store remains
limited to tests and single-process consumers.

Every snapshot includes bounded transcript/evidence, serialized mock state,
semantic authorization records, runner/Codex PIDs and exit state, and explicit
network evidence. Tool calls are admitted only when their thread and turn match
the active Codex turn. Their typed `CapabilitySemanticToolResult` is serialized into
the app-server response, allowing Codex to use the resulting state revision in
its next response.

## Verification

Run the deterministic contract suite:

```sh
pnpm --filter @paperclipai/paperclip-runner test:scenarios
```

Run a real runnerd and Codex app-server smoke:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:live-runner -- --json
```

The smoke requires an authenticated local Codex installation. It checks a real
semantic tool mutation, typed-result response, same-thread second turn, process
ownership/cleanup, cleared authority, and zero Paperclip network/child-env
exposure.
