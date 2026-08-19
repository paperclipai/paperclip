/**
 * Transactional core of the Tailscale HTTPS broker.
 *
 * Ties together the pure policy/protocol/serve-state modules with the injected
 * CLI, listener inspector, ownership registry, and audit sink. Every mutation is
 * serialized behind a mutex and runs the required per-mutation transaction from
 * the threat-model verdict (PAP-17050 #3): lock → read+verify serve state →
 * verify listener ownership → apply one fixed per-port op → re-read → verify only
 * the intended entry changed and `:443` is identical → atomically persist the
 * registry. On any ambiguity the port is quarantined and the request fails
 * closed; unknown/manual entries and the primary route are never modified.
 *
 * All I/O is injected so the whole transaction is unit-testable with fakes.
 */

import { PolicyError, assertExposablePort, assertLoopbackTarget, type BrokerPortPolicy, DEFAULT_PORT_POLICY } from "./policy.js";
import { ProtocolError, type BrokerRequest, type BrokerResponse } from "./protocol.js";
import {
  ServeStateError,
  assertOnlyPortChanged,
  assertPrimaryPresent,
  parseServeState,
  primaryDigest,
} from "./serve-state.js";
import { ListenerOwnershipError, assertLoopbackOwned, type ListenerInspector } from "./listener-ownership.js";
import { LeaseRegistry, type LeaseRecord, type RegistryFile, entryDigest, newHandle } from "./registry.js";
import type { TailscaleCli } from "./cli.js";
import type { AuditSink } from "./audit.js";

export interface PeerIdentity {
  uid: number;
  gid: number;
  pid: number | null;
}

export interface BrokerConfig {
  portPolicy?: BrokerPortPolicy;
  /** UIDs permitted to talk to the broker at all (defense in depth over socket perms). */
  allowedUids: number[];
  /** GIDs permitted to talk to the broker. */
  allowedGids: number[];
  /** UID that must own the backend loopback listener, or null to skip the owner check. */
  expectedRuntimeUid: number | null;
}

export interface BrokerDeps {
  cli: TailscaleCli;
  inspector: ListenerInspector;
  audit: AuditSink;
  loadRegistry: () => RegistryFile;
  saveRegistry: (file: RegistryFile) => void;
  now: () => number;
  newHandle?: () => string;
  correlationId: () => string;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function ok(result: unknown): BrokerResponse {
  return { ok: true, result };
}
function deny(code: string, message: string): BrokerResponse {
  return { ok: false, code, message };
}

export class Broker {
  private readonly registry: LeaseRegistry;
  private readonly mutex = new Mutex();
  private readonly mkHandle: () => string;
  private failedClosedReason: string | null = null;

  constructor(
    private readonly config: BrokerConfig,
    private readonly deps: BrokerDeps,
  ) {
    this.registry = new LeaseRegistry(deps.loadRegistry());
    this.mkHandle = deps.newHandle ?? newHandle;
  }

  private get portPolicy(): BrokerPortPolicy {
    return this.config.portPolicy ?? DEFAULT_PORT_POLICY;
  }

  private authorizePeer(peer: PeerIdentity): void {
    if (!this.config.allowedUids.includes(peer.uid)) {
      throw new PolicyError("peer_uid_denied", `uid ${peer.uid} is not permitted`);
    }
    if (this.config.allowedGids.length > 0 && !this.config.allowedGids.includes(peer.gid)) {
      throw new PolicyError("peer_gid_denied", `gid ${peer.gid} is not permitted`);
    }
  }

  async handle(request: BrokerRequest, peer: PeerIdentity): Promise<BrokerResponse> {
    const correlationId = this.deps.correlationId();
    try {
      this.authorizePeer(peer);
      switch (request.op) {
        case "list": {
          this.assertOperational();
          return this.handleList(peer, correlationId);
        }
        case "expose":
          return await this.mutex.run(() => {
            this.assertOperational();
            return this.handleExpose(request, peer, correlationId);
          });
        case "remove":
          return await this.mutex.run(() => {
            this.assertOperational();
            return this.handleRemove(request, peer, correlationId);
          });
      }
    } catch (err) {
      const { code, message } = classifyError(err);
      this.deps.audit.write({
        ts: this.deps.now(),
        correlationId,
        op: request.op,
        decision: "deny",
        reason: `${code}: ${message}`,
        peerUid: peer.uid,
        peerGid: peer.gid,
        peerPid: peer.pid,
        runtimeId: request.op === "expose" ? request.runtimeId : null,
        port: request.op === "expose" ? safePort(request.port) : null,
        beforeDigest: null,
        afterDigest: null,
        cliOutcome: null,
        recovery: null,
      });
      return deny(code, message);
    }
  }

  private handleList(peer: PeerIdentity, correlationId: string): BrokerResponse {
    const leases = this.registry.forPeer(peer.uid).map((l) => ({
      runtimeId: l.runtimeId,
      port: l.port,
      target: l.target,
      createdAt: l.createdAt,
      quarantined: Boolean(l.quarantined),
      // NB: handle is intentionally omitted (verdict #1 / #5).
    }));
    this.deps.audit.write({
      ts: this.deps.now(),
      correlationId,
      op: "list",
      decision: "allow",
      reason: `listed ${leases.length} lease(s)`,
      peerUid: peer.uid,
      peerGid: peer.gid,
      peerPid: peer.pid,
      runtimeId: null,
      port: null,
      beforeDigest: null,
      afterDigest: null,
      cliOutcome: null,
      recovery: null,
    });
    return ok({ leases });
  }

  private assertOperational(): void {
    if (this.failedClosedReason) {
      throw new ServeStateError("broker_failed_closed", this.failedClosedReason);
    }
  }

  private async handleExpose(
    request: Extract<BrokerRequest, { op: "expose" }>,
    peer: PeerIdentity,
    correlationId: string,
  ): Promise<BrokerResponse> {
    // 1. Canonical policy validation (throws PolicyError on any violation).
    const port = assertExposablePort(request.port, request.port, this.portPolicy);
    assertLoopbackTarget(request.target, port);

    // 2. Read + verify current serve state.
    const before = parseServeState(await this.deps.cli.serveStatusJson());
    assertPrimaryPresent(before);
    const beforeDigest = primaryDigest(before);

    // 3. Idempotency / conflict on the target port.
    const existing = before.entries.get(port);
    const existingLease = this.registry.byPort(port);
    if (existing) {
      if (
        existingLease &&
        existingLease.runtimeId === request.runtimeId &&
        existingLease.peerUid === peer.uid &&
        existing.target === request.target &&
        existing.https
      ) {
        // Idempotent re-expose: return the existing lease handle.
        return ok({ handle: existingLease.handle, port, target: request.target, idempotent: true });
      }
      throw new PolicyError("port_in_use", `port ${port} already has a serve mapping not owned by this runtime`);
    }

    // 4. Verify the backend listener is loopback-only and owned by the runtime.
    const bindings = await this.deps.inspector.listBindingsForPort(port);
    assertLoopbackOwned(bindings, this.config.expectedRuntimeUid);

    // 5. Apply exactly one add operation.
    await this.deps.cli.serveAddHttps(port, request.target);

    // 6. Re-read and verify only the intended entry changed and :443 is identical.
    const after = parseServeState(await this.deps.cli.serveStatusJson());
    try {
      assertPrimaryPresent(after);
      assertOnlyPortChanged(before, after, port);
    } catch (verifyErr) {
      // The mutation produced an unexpected diff. Attempt an exact compensating
      // removal; if that cannot be proven clean, quarantine and fail closed.
      await this.compensateAndQuarantine(port, after);
      throw verifyErr;
    }
    const created = after.entries.get(port);
    if (!created || created.target !== request.target || !created.https) {
      await this.compensateAndQuarantine(port, after);
      throw new ServeStateError("mapping_not_created", `expected HTTPS mapping on ${port} was not created cleanly`);
    }

    // 7. Persist the lease atomically.
    const currentRegistry = this.registry.snapshot();
    const lease: LeaseRecord = {
      handle: this.mkHandle(),
      runtimeId: request.runtimeId,
      port,
      target: request.target,
      peerUid: peer.uid,
      peerGid: peer.gid,
      generation: currentRegistry.generation + 1,
      entryDigest: entryDigest(port, request.target),
      createdAt: this.deps.now(),
    };
    const nextRegistry: RegistryFile = {
      version: 1,
      generation: lease.generation,
      leases: [...currentRegistry.leases, lease],
    };
    try {
      // Write the durable ownership record before publishing it in memory. If
      // the write fails, remove and verify the mapping before another request
      // can enter the serialized mutation section.
      this.deps.saveRegistry(nextRegistry);
    } catch (registryErr) {
      try {
        await this.rollbackUnpersistedExpose(port, before);
      } catch (rollbackErr) {
        this.failedClosedReason =
          `broker stopped mutations after registry persistence and mapping rollback failed on port ${port}: ` +
          `${errorMessage(registryErr)}; rollback: ${errorMessage(rollbackErr)}`;
        throw new ServeStateError("registry_rollback_failed", this.failedClosedReason);
      }
      throw new ServeStateError(
        "registry_persist_failed",
        `registry persistence failed; the new mapping on port ${port} was rolled back: ${errorMessage(registryErr)}`,
      );
    }
    this.registry.replace(nextRegistry);

    this.deps.audit.write({
      ts: this.deps.now(),
      correlationId,
      op: "expose",
      decision: "allow",
      reason: "mapping created",
      peerUid: peer.uid,
      peerGid: peer.gid,
      peerPid: peer.pid,
      runtimeId: request.runtimeId,
      port,
      beforeDigest,
      afterDigest: primaryDigest(after),
      cliOutcome: "add_ok",
      recovery: null,
    });
    return ok({ handle: lease.handle, port, target: request.target, idempotent: false });
  }

  private async handleRemove(
    request: Extract<BrokerRequest, { op: "remove" }>,
    peer: PeerIdentity,
    correlationId: string,
  ): Promise<BrokerResponse> {
    const lease = this.registry.byHandle(request.handle);
    if (!lease) {
      // Unknown/stale/replayed/random handle: no state change (verdict #1).
      throw new PolicyError("unknown_handle", "no lease matches the provided handle");
    }
    if (lease.peerUid !== peer.uid) {
      // Runtime A cannot remove runtime B's listener (verdict #1).
      throw new PolicyError("owner_mismatch", "handle is not owned by the calling peer");
    }

    const before = parseServeState(await this.deps.cli.serveStatusJson());
    assertPrimaryPresent(before);
    const beforeDigest = primaryDigest(before);

    const entry = before.entries.get(lease.port);
    if (!entry) {
      // Already gone: drop the lease idempotently.
      this.registry.removeByHandle(request.handle);
      this.deps.saveRegistry(this.registry.snapshot());
      this.auditRemove(correlationId, peer, lease, beforeDigest, beforeDigest, "already_absent");
      return ok({ removed: true, idempotent: true });
    }
    if (entryDigest(lease.port, entry.target ?? "") !== lease.entryDigest) {
      // ABA / manual mutation: the live entry is not the one we created.
      this.registry.markQuarantined(lease.port);
      this.deps.saveRegistry(this.registry.snapshot());
      throw new ServeStateError("entry_mismatch", `serve entry on ${lease.port} no longer matches the lease; quarantined`);
    }

    await this.deps.cli.serveRemoveHttps(lease.port);
    const after = parseServeState(await this.deps.cli.serveStatusJson());
    assertPrimaryPresent(after);
    assertOnlyPortChanged(before, after, lease.port);
    if (after.entries.get(lease.port)) {
      this.registry.markQuarantined(lease.port);
      this.deps.saveRegistry(this.registry.snapshot());
      throw new ServeStateError("remove_failed", `serve mapping on ${lease.port} persisted after removal; quarantined`);
    }

    this.registry.removeByHandle(request.handle);
    this.deps.saveRegistry(this.registry.snapshot());
    this.auditRemove(correlationId, peer, lease, beforeDigest, primaryDigest(after), "removed");
    return ok({ removed: true, idempotent: false });
  }

  private auditRemove(
    correlationId: string,
    peer: PeerIdentity,
    lease: LeaseRecord,
    beforeDigest: string,
    afterDigest: string,
    outcome: string,
  ): void {
    this.deps.audit.write({
      ts: this.deps.now(),
      correlationId,
      op: "remove",
      decision: "allow",
      reason: outcome,
      peerUid: peer.uid,
      peerGid: peer.gid,
      peerPid: peer.pid,
      runtimeId: lease.runtimeId,
      port: lease.port,
      beforeDigest,
      afterDigest,
      cliOutcome: outcome,
      recovery: null,
    });
  }

  private async compensateAndQuarantine(port: number, afterState: ReturnType<typeof parseServeState>): Promise<void> {
    // Only attempt a compensating removal when the port's entry was actually
    // created by us in this transaction; never touch pre-existing/manual entries.
    try {
      if (afterState.entries.get(port)) {
        await this.deps.cli.serveRemoveHttps(port);
      }
    } catch {
      // fall through to quarantine
    }
    this.registry.markQuarantined(port);
    this.deps.saveRegistry(this.registry.snapshot());
  }

  private async rollbackUnpersistedExpose(
    port: number,
    beforeState: ReturnType<typeof parseServeState>,
  ): Promise<void> {
    await this.deps.cli.serveRemoveHttps(port);
    const rolledBack = parseServeState(await this.deps.cli.serveStatusJson());
    assertPrimaryPresent(rolledBack);
    assertOnlyPortChanged(beforeState, rolledBack, port);
    if (rolledBack.entries.has(port)) {
      throw new ServeStateError("mapping_still_present", `mapping on port ${port} remained after rollback`);
    }
  }

  /** Test/inspection helper. */
  snapshotRegistry(): RegistryFile {
    return this.registry.snapshot();
  }
}

function safePort(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classifyError(err: unknown): { code: string; message: string } {
  if (
    err instanceof PolicyError ||
    err instanceof ProtocolError ||
    err instanceof ServeStateError ||
    err instanceof ListenerOwnershipError
  ) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) return { code: "internal_error", message: err.message };
  return { code: "internal_error", message: String(err) };
}
