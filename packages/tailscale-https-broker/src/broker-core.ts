/**
 * Broker transaction core. One serialized, fail-closed transaction per
 * mutation implements every PAP-17050 verdict requirement and invariant:
 *
 *   - Complete peer mediation + lease-handle ownership (req #1).
 *   - Dedicated-range + immediately-before /proc listener-ownership check
 *     defeats SSRF-equivalent publication of unrelated loopback services (#2).
 *   - Read → strict-parse → verify absence-or-exact-lease-match → verify
 *     protected :443 → one fixed per-port op → reread → require only the
 *     intended entry changed and :443 identical → atomic registry commit; any
 *     ambiguity quarantines and fails closed (#3).
 *   - Argv-only, shell:false CLI via an injected runner (#4).
 *   - Bounded, serialized mutation queue (#5).
 *   - One audit event per allow/deny/outcome (#6).
 */
import {
  AuthorizationError,
  authorizePeer,
  authorizeRemoval,
  generateLeaseHandle,
  type PeerPolicy,
} from "./authorization.js";
import { buildExposeArgv, buildRemoveArgv, buildStatusArgv } from "./argv.js";
import type { AuditSink } from "./audit.js";
import {
  ParsedServe,
  ServeParseError,
  assertPrimaryIntact,
  changedPorts,
  changedProtectedPorts,
  isSameNumberLoopbackEntry,
  parseServeStatus,
  primaryDigest,
} from "./serve-config.js";
import {
  addLease,
  isPortQuarantined,
  loadRegistry,
  nextGeneration,
  pruneExpiredReservations,
  quarantinePort,
  removeLeaseByHandle,
  saveRegistry,
} from "./registry.js";
import type {
  BrokerRegistry,
  BrokerRequest,
  BrokerResponse,
  PeerCredentials,
} from "./types.js";

const RESERVATION_TTL_MS = 5 * 60 * 1_000;

/** Result of running a tailscale CLI command (argv, shell:false). */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Immediately-before-mutation ownership facts about a loopback listener,
 * derived from /proc (req #2). `loopbackOnly` must be true (reject wildcard,
 * IPv6-wildcard, dual-stack off-loopback); `ownerUidMatches` binds the listener
 * to the expected managed-runtime identity; `present` guards the swap race.
 */
export interface ListenerOwnership {
  present: boolean;
  loopbackOnly: boolean;
  ownerUidMatches: boolean;
  /**
   * Socket inodes of the listening sockets on the port, sorted. This is the
   * listener's *identity*, and it is required rather than optional: a caller
   * that cannot name the socket must fail closed, not fall through to
   * "permitted". `present: true` with an empty array is contradictory and is
   * refused as `listener_unattributable`.
   *
   * The three booleans above only describe "something acceptable is on this
   * port". They are re-read but cannot detect substitution, because a different
   * process under the same managed-runtime UID satisfies all three. Comparing
   * inode sets across the reserve/expose window is what proves the socket the
   * broker verified is the socket it publishes.
   */
  inodes: string[];
}

export interface BrokerDeps {
  runTailscale(argv: string[]): CliResult;
  /** Inspect a loopback listener immediately before mutation (req #2). */
  verifyListenerOwnership(port: number): ListenerOwnership;
  nowIso(): string;
}

export interface BrokerCoreConfig {
  tailscaleBinPath: string;
  registryPath: string;
  auditSink: AuditSink;
  peerPolicy: PeerPolicy;
  /** hostname + boot id; a change forces quarantine + operator reconciliation. */
  nodeIdentity: string;
  /** Deny-by-default port allowlist. Defaults to the dedicated runtime range. */
  isAllowedPort(port: number): boolean;
  /**
   * Operator-declared ports that must never be created, removed, or reclaimed
   * (PAP-17285). Outranks the broker's own ownership record: a protected port is
   * denied even when a valid lease names it, which is exactly the case that
   * destroyed `42000/52000`. Defaults to none.
   */
  protectedPorts?: readonly number[];
  deps: BrokerDeps;
}

function denied(code: string, message: string): never {
  const err = new Error(message) as Error & { brokerCode: string };
  err.brokerCode = code;
  throw err;
}

export class BrokerCore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: BrokerCoreConfig) {}

  private get protectedPorts(): readonly number[] {
    return this.config.protectedPorts ?? [];
  }

  /**
   * Deny any request naming an operator-protected port, before anything reads or
   * mutates Serve (PAP-17285). Deliberately checked ahead of the lease/ownership
   * logic: the protection must hold *because* the operator declared it, not
   * because the broker happens to lack a lease for the port.
   */
  private assertNoProtectedPort(ports: readonly number[]): void {
    for (const port of ports) {
      if (this.protectedPorts.includes(port)) {
        denied("protected_port", `port ${port} is operator-protected and may not be mutated`);
      }
    }
  }

  /**
   * Assert every protected entry is byte-identical across a mutation. Any change
   * — including disappearance — fails closed. Callers must run this on the same
   * `before`/`after` snapshots used for the primary-route check.
   */
  private assertProtectedIntact(before: ParsedServe, after: ParsedServe): void {
    const changed = changedProtectedPorts(before, after, this.protectedPorts);
    if (changed.length > 0) {
      denied(
        "protected_entry_violation",
        `operator-protected entries changed during mutation: ${changed.join(",")}`,
      );
    }
  }

  /** Public entry point. Serializes all requests through one mutation queue. */
  async handle(request: BrokerRequest, peer: PeerCredentials): Promise<BrokerResponse> {
    const run = this.queue.then(() => this.dispatch(request, peer));
    // Keep the chain alive even if this request rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async dispatch(request: BrokerRequest, peer: PeerCredentials): Promise<BrokerResponse> {
    try {
      authorizePeer(peer, this.config.peerPolicy);
    } catch (error) {
      return this.fail(request.requestId, peer, request.op, "unauthorized_peer", error);
    }
    try {
      switch (request.op) {
        case "list":
          return this.doList(request, peer);
        case "reserve":
          return this.doReserve(request, peer);
        case "expose":
          return this.doExpose(request, peer);
        case "remove":
          return this.doRemove(request, peer);
      }
    } catch (error) {
      const code = (error as { brokerCode?: string }).brokerCode ?? codeForError(error);
      return this.fail(request.requestId, peer, request.op, code, error);
    }
  }

  private readServe(): ParsedServe {
    const result = this.config.deps.runTailscale(buildStatusArgv(this.config.tailscaleBinPath));
    if (result.timedOut) denied("cli_timeout", "serve status timed out");
    if (result.code !== 0) denied("cli_error", "serve status exited non-zero");
    let json: unknown;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      denied("serve_parse_error", "serve status returned invalid JSON");
    }
    try {
      return parseServeStatus(json);
    } catch (error) {
      if (error instanceof ServeParseError) denied("serve_parse_error", error.message);
      throw error;
    }
  }

  private loadRegistry(pruneReservations = true): BrokerRegistry {
    const registry = loadRegistry(this.config.registryPath, this.config.nodeIdentity);
    // Boot/node identity change forces quarantine + operator reconciliation.
    if (registry.nodeIdentity !== this.config.nodeIdentity) {
      denied("quarantined", "node identity changed; operator reconciliation required");
    }
    if (pruneReservations && pruneExpiredReservations(registry, this.config.deps.nowIso()).length > 0) {
      saveRegistry(this.config.registryPath, registry);
    }
    return registry;
  }

  private doReserve(
    request: Extract<BrokerRequest, { op: "reserve" }>,
    peer: PeerCredentials,
  ): BrokerResponse {
    const registry = this.loadRegistry();
    // Protected ports are never allocatable, so a lane can never acquire a lease
    // on one and no later lifecycle op can reach it (PAP-17285).
    this.assertNoProtectedPort(request.listeners.map((listener) => listener.port));
    for (const listener of request.listeners) {
      if (!this.config.isAllowedPort(listener.port)) {
        denied("port_not_allowlisted", `port ${listener.port} is outside the dedicated range`);
      }
      if (isPortQuarantined(registry, listener.port)) {
        denied("quarantined", `port ${listener.port} is quarantined`);
      }
    }

    const requestedPorts = request.listeners.map((listener) => listener.port);
    const requestedPurposes = request.listeners.map((listener) => listener.purpose);
    const existingForRuntime = registry.leases.find((lease) =>
      lease.runtimeId === request.runtimeId
      && lease.peerUid === peer.uid
      && lease.peerGid === peer.gid
      && sameNumbers(lease.ports, requestedPorts)
      && sameStrings(lease.purposes, requestedPurposes));
    if (existingForRuntime) {
      return {
        ok: true,
        op: "reserve",
        requestId: request.requestId,
        handle: existingForRuntime.handle,
        reservedPorts: [...existingForRuntime.ports],
      };
    }

    for (const lease of registry.leases) {
      if (lease.ports.some((port) => requestedPorts.includes(port))) {
        denied("reservation_conflict", "a requested port is reserved by another runtime");
      }
    }

    const serve = this.readServe();
    assertPrimaryIntact(serve);
    for (const port of requestedPorts) {
      if (serve.entries.has(port)) {
        denied("manual_mapping_present", `port ${port} already has a Serve mapping`);
      }
    }

    const createdAtIso = this.config.deps.nowIso();
    const handle = generateLeaseHandle();
    addLease(registry, {
      handle,
      runtimeId: request.runtimeId,
      peerUid: peer.uid,
      peerGid: peer.gid,
      ports: requestedPorts,
      purposes: requestedPurposes,
      state: "reserved",
      generation: nextGeneration(registry),
      createdAtIso,
      expiresAtIso: new Date(Date.parse(createdAtIso) + RESERVATION_TTL_MS).toISOString(),
    });
    saveRegistry(this.config.registryPath, registry);
    this.config.auditSink.write({
      timestampIso: this.config.deps.nowIso(),
      peer,
      op: "reserve",
      runtimeId: request.runtimeId,
      ports: requestedPorts,
      requestId: request.requestId,
      decision: "allow",
      reasonCode: "ok",
      reason: "reserved",
      beforeDigest: primaryDigest(serve),
      afterDigest: primaryDigest(serve),
      cliExitCategory: "ok",
      recovery: "none",
    });
    return { ok: true, op: "reserve", requestId: request.requestId, handle, reservedPorts: requestedPorts };
  }

  /**
   * Prove the port carries an acceptable, attributable managed listener, or
   * deny. Each predicate keeps its own reason code so a deployed failure can be
   * attributed to a missing listener, an off-loopback bind, a foreign owner, or
   * a socket the broker could not name.
   */
  private verifyListener(port: number): ListenerOwnership {
    const ownership = this.config.deps.verifyListenerOwnership(port);
    if (!ownership.present) {
      denied("listener_absent", `no loopback listener on port ${port}`);
    }
    if (!ownership.loopbackOnly) {
      denied("listener_not_loopback", `listener on ${port} is not loopback-only`);
    }
    if (!ownership.ownerUidMatches) {
      denied("listener_ownership_mismatch", `listener on ${port} not owned by managed runtime`);
    }
    // Present but unnameable is not permission. Without a socket identity the
    // broker cannot prove that the socket it publishes is the socket it
    // verified, so it refuses rather than publishing on trust.
    if (ownership.inodes.length === 0) {
      denied("listener_unattributable", `listener on ${port} has no identifiable socket`);
    }
    return ownership;
  }

  /**
   * Re-prove that `port` still carries the exact socket verified earlier. A
   * changed identity means the listener was substituted inside the window, so
   * publishing would expose a service the broker never authorized.
   */
  private assertListenerUnchanged(port: number, expected: string | undefined): void {
    if (expected === undefined) {
      denied("listener_substituted", `port ${port} was not verified before mutation`);
    }
    const current = listenerIdentity(this.verifyListener(port));
    if (current !== expected) {
      denied(
        "listener_substituted",
        `listener on ${port} changed after verification; refusing to expose a substituted service`,
      );
    }
  }

  /**
   * Current socket identity without denying on a failed predicate. Used by the
   * post-publication sweep, which must classify *every* port before it throws:
   * an absent or unnameable listener is as much a substitution as a swapped one,
   * and each case still needs the mapping withdrawn.
   *
   * SCOPE. Every check here is point-in-time, and it bounds the transaction only.
   * A same-UID process can still replace a listener *after* a successful expose
   * returns, while the Serve mapping persists. No check inside this transaction
   * can close that, because the mapping outlives the transaction; the broker has
   * no way to pin a Serve entry to a socket. That case is a lifecycle concern and
   * is handled above the broker: the server re-verifies listener ownership on
   * every readiness and health check, and reconciliation fails closed when a
   * reserved pair is held by a different execution workspace. What this
   * transaction guarantees is narrower and worth stating plainly — a *successful*
   * expose published the socket it verified, and a failed one leaves nothing of
   * ours published.
   */
  private currentListenerIdentity(port: number): string {
    try {
      return listenerIdentity(this.config.deps.verifyListenerOwnership(port));
    } catch {
      return "";
    }
  }

  private doExpose(
    request: Extract<BrokerRequest, { op: "expose" }>,
    peer: PeerCredentials,
  ): BrokerResponse {
    const registry = this.loadRegistry(false);
    let lease;
    try {
      lease = authorizeRemoval(registry.leases, request, peer);
    } catch (error) {
      if (error instanceof AuthorizationError) denied(error.code, error.message);
      throw error;
    }
    if (lease.state === "reserved" && lease.expiresAtIso && Date.parse(lease.expiresAtIso) <= Date.parse(this.config.deps.nowIso())) {
      removeLeaseByHandle(registry, lease.handle);
      saveRegistry(this.config.registryPath, registry);
      denied("reservation_expired", "reservation expired before exposure");
    }

    // A protected port must be refused even when a previously-issued lease names
    // it, so an operator declaration made *after* a lease existed still holds.
    this.assertNoProtectedPort(lease.ports);

    // Captured before the transaction can promote the lease: true means a prior
    // expose already published these ports, so the broker owns whatever mapping
    // is on them. This is the provenance the withdrawal path uses.
    const leaseWasExposed = lease.state === "exposed";

    // Pre-flight every requested port: allowlist, quarantine, and the
    // immediately-before /proc ownership check (req #2).
    //
    // The verified socket identity per port is retained, because the checks
    // below are not the last thing to happen before Serve is mutated: reading
    // Serve status runs a `tailscale` subprocess, which is unbounded wall-clock
    // time during which the verified listener can close and another process can
    // take the port. Every mutation therefore re-proves this identity.
    const verifiedIdentities = new Map<number, string>();
    for (const port of lease.ports) {
      if (!this.config.isAllowedPort(port)) {
        denied("port_not_allowlisted", `port ${port} is outside the dedicated range`);
      }
      if (isPortQuarantined(registry, port)) {
        denied("quarantined", `port ${port} is quarantined`);
      }
      // Each predicate gets its own code. Enforcement is unchanged — every
      // branch below still denies, before anything reads or mutates Serve — but
      // the caller can now tell which predicate failed. Previously all three
      // returned `listener_ownership_mismatch` and only the root-owned audit
      // file carried the reason, so a deployed failure could not be attributed
      // to a missing listener, an off-loopback bind, or a foreign owner.
      const ownership = this.verifyListener(port);
      verifiedIdentities.set(port, listenerIdentity(ownership));
    }

    const before = this.readServe();
    assertPrimaryIntact(before);
    const beforePrimary = primaryDigest(before);

    // Each target port must be absent or already exactly our same-number entry
    // (idempotent re-expose). A manual/unknown entry is never touched.
    for (const port of lease.ports) {
      const entry = before.entries.get(port);
      if (entry && !isSameNumberLoopbackEntry(entry, port)) {
        denied("manual_mapping_present", `port ${port} already has a non-Paperclip mapping`);
      }
    }

    const appliedPorts: number[] = [];
    try {
      for (const port of lease.ports) {
        const already = before.entries.get(port);
        if (already && isSameNumberLoopbackEntry(already, port)) {
          continue; // idempotent
        }
        // Immediately before this port's mutation, and again after the whole
        // batch below. Checking only once before `readServe()` left the verified
        // socket free to be replaced during that subprocess.
        this.assertListenerUnchanged(port, verifiedIdentities.get(port));
        const result = this.config.deps.runTailscale(
          buildExposeArgv(this.config.tailscaleBinPath, port, this.protectedPorts),
        );
        if (result.timedOut) denied("cli_timeout", `expose ${port} timed out`);
        if (result.code !== 0) denied("cli_error", `expose ${port} exited non-zero`);
        appliedPorts.push(port);
      }

      const after = this.readServe();
      // Digest equality (vs the known-good `before`) is the strongest primary
      // check: any retarget, removal, or structural change fails closed here as
      // a primary_route_violation before any weaker classification runs.
      if (primaryDigest(after) !== beforePrimary) {
        denied("primary_route_violation", "protected :443 route changed during expose");
      }
      assertPrimaryIntact(after);
      this.assertProtectedIntact(before, after);
      // Only the intended ports may have changed, and each must now be an exact
      // same-number loopback listener.
      const diff = new Set(changedPorts(before, after));
      const intended = new Set(lease.ports);
      for (const port of diff) {
        if (!intended.has(port)) denied("unexpected_serve_diff", `unexpected change on port ${port}`);
      }
      for (const port of lease.ports) {
        if (!isSameNumberLoopbackEntry(after.entries.get(port), port)) {
          denied("unexpected_serve_diff", `port ${port} not exactly exposed`);
        }
      }

      // Final proof, after the last mutation and the status read that follows
      // it: every published port must still carry the socket that was verified.
      //
      // Classify all ports before throwing. A port skipped above as idempotent
      // was never added to `appliedPorts`, so denying alone would leave its
      // pre-existing mapping active and now pointing at the replacement service.
      // Any port whose identity no longer matches is therefore made eligible for
      // withdrawal, whether this request published it or found it already
      // correct. Which of those ports are ours to withdraw is decided below from
      // the registry, not from the shape of the Serve entry.
      const substituted = lease.ports.filter(
        (port) => this.currentListenerIdentity(port) !== verifiedIdentities.get(port),
      );
      if (substituted.length > 0) {
        // Provenance for a withdrawal comes from the broker's own registry, not
        // from the shape of a Serve entry. An already-`exposed` lease means the
        // broker published these ports itself, so they are ours to withdraw — and
        // that holds even if Serve cannot be read at this moment, which is why
        // this does not depend on a live status read that might fail and silently
        // preserve the substituted mapping. A still-`reserved` lease published
        // nothing, so there is nothing of ours to withdraw.
        //
        // Shape alone would be the wrong test in both directions: it cannot prove
        // an identically-shaped entry is ours, and it cannot be evaluated at all
        // when the status read fails. An operator who needs a mapping to survive
        // managed lifecycle declares the port protected, which is refused far
        // above this point.
        if (leaseWasExposed) {
          for (const port of substituted) {
            if (!appliedPorts.includes(port)) appliedPorts.push(port);
          }
        }
        denied(
          "listener_substituted",
          `listener on ${substituted.join(",")} changed after verification; withdrawing the mapping`,
        );
      }

      lease.state = "exposed";
      lease.expiresAtIso = null;
      saveRegistry(this.config.registryPath, registry);

      this.config.auditSink.write({
        timestampIso: this.config.deps.nowIso(),
        peer,
        op: "expose",
        runtimeId: request.runtimeId,
        ports: lease.ports,
        requestId: request.requestId,
        decision: "allow",
        reasonCode: "ok",
        reason: "exposed",
        beforeDigest: beforePrimary,
        afterDigest: primaryDigest(after),
        cliExitCategory: "ok",
        recovery: "none",
      });

      return {
        ok: true,
        op: "expose",
        requestId: request.requestId,
        handle: lease.handle,
        publicPorts: [...lease.ports],
      };
    } catch (error) {
      // Partial success is not healthy: compensate by removing only the exact
      // entries we applied; if compensation cannot be proven, quarantine.
      this.compensateExpose(appliedPorts, registry, before, peer, request);
      throw error;
    }
  }

  /**
   * Roll back a partially-applied expose.
   *
   * This path used to mutate Serve with no verification and no audit event at
   * all: it fired one `--https=<port> off` per applied port, trusted the exit
   * code, and returned. That made it the one broker mutation where an unrelated
   * Serve change was structurally undetectable, and where a mutation left no
   * durable record (PAP-17285 requirement #3, and req #6 which mandates one
   * audit event per mutation outcome).
   *
   * It now re-reads Serve and proves three things against the pre-mutation
   * snapshot: the primary route is intact, every protected entry is unchanged,
   * and nothing outside the compensated set changed. Any port it cannot prove
   * clean is quarantined, so recoverability is preserved rather than traded away.
   * Compensation never throws — the original failure is the caller's error and
   * must not be masked — but it can no longer fail silently either.
   */
  private compensateExpose(
    appliedPorts: number[],
    registry: BrokerRegistry,
    before: ParsedServe,
    peer: PeerCredentials,
    request: Extract<BrokerRequest, { op: "expose" }>,
  ): void {
    const unproven: number[] = [];
    for (const port of appliedPorts) {
      let cleaned = false;
      try {
        const result = this.config.deps.runTailscale(
          buildRemoveArgv(this.config.tailscaleBinPath, port, this.protectedPorts),
        );
        cleaned = !result.timedOut && result.code === 0;
      } catch {
        cleaned = false;
      }
      if (!cleaned) {
        quarantinePort(registry, port);
        unproven.push(port);
      }
    }

    // Verify the rollback actually restored the pre-mutation state. A failure
    // here is a containment failure, not a cleanup detail, so every port we
    // touched is quarantined even if its own `off` reported success.
    let verifyFailure: string | null = null;
    try {
      const after = this.readServe();
      if (primaryDigest(after) !== primaryDigest(before)) {
        verifyFailure = "primary_route_violation";
      } else {
        const protectedChanged = changedProtectedPorts(before, after, this.protectedPorts);
        if (protectedChanged.length > 0) {
          verifyFailure = `protected_entry_violation:${protectedChanged.join(",")}`;
        } else {
          const compensated = new Set(appliedPorts);
          const stray = changedPorts(before, after).filter((port) => !compensated.has(port));
          if (stray.length > 0) verifyFailure = `unexpected_serve_diff:${stray.join(",")}`;
        }
      }
    } catch (error) {
      // Could not even read Serve back — treat as unproven, never as clean.
      verifyFailure = `unverifiable:${(error as { brokerCode?: string }).brokerCode ?? "read_failed"}`;
    }
    if (verifyFailure) {
      for (const port of appliedPorts) {
        quarantinePort(registry, port);
        if (!unproven.includes(port)) unproven.push(port);
      }
    }

    try {
      saveRegistry(this.config.registryPath, registry);
    } catch {
      /* best effort; registry may already reflect quarantine on next load */
    }

    try {
      this.config.auditSink.write({
        timestampIso: this.config.deps.nowIso(),
        peer,
        op: "expose",
        runtimeId: request.runtimeId,
        ports: appliedPorts,
        requestId: request.requestId,
        decision: verifyFailure || unproven.length > 0 ? "deny" : "allow",
        reasonCode: verifyFailure ? "unexpected_serve_diff" : "ok",
        reason: verifyFailure
          ? `expose compensation unverified: ${verifyFailure}`
          : unproven.length > 0
            ? `expose compensation could not clean ports: ${unproven.join(",")}`
            : "expose compensated",
        cliExitCategory: verifyFailure || unproven.length > 0 ? "error" : "ok",
        recovery: unproven.length > 0 ? "quarantine" : "cleanup",
      });
    } catch {
      /* never let an audit failure mask the original expose error */
    }
  }

  private doRemove(
    request: Extract<BrokerRequest, { op: "remove" }>,
    peer: PeerCredentials,
  ): BrokerResponse {
    const registry = this.loadRegistry();
    let lease;
    try {
      lease = authorizeRemoval(registry.leases, request, peer);
    } catch (error) {
      if (error instanceof AuthorizationError) denied(error.code, error.message);
      throw error;
    }

    // Refuse before any Serve read or mutation. This is the exact clause whose
    // absence let an authorized, shape-valid removal destroy `42000/52000`: the
    // lease was genuinely the broker's own, so nothing else in this path could
    // object (PAP-17285).
    this.assertNoProtectedPort(lease.ports);

    if (lease.state === "reserved") {
      removeLeaseByHandle(registry, lease.handle);
      saveRegistry(this.config.registryPath, registry);
      this.config.auditSink.write({
        timestampIso: this.config.deps.nowIso(),
        peer,
        op: "remove",
        runtimeId: request.runtimeId,
        ports: lease.ports,
        requestId: request.requestId,
        decision: "allow",
        reasonCode: "ok",
        reason: "reservation_released",
        cliExitCategory: "ok",
        recovery: "cleanup",
      });
      return { ok: true, op: "remove", requestId: request.requestId, removedPorts: [] };
    }

    const before = this.readServe();
    assertPrimaryIntact(before);
    const beforePrimary = primaryDigest(before);

    const removedPorts: number[] = [];
    for (const port of lease.ports) {
      const entry = before.entries.get(port);
      if (!entry) continue; // already gone; idempotent
      if (!isSameNumberLoopbackEntry(entry, port)) {
        // Unknown/manual/mismatched entry — never modify; cannot prove cleanup.
        quarantinePort(registry, port);
        saveRegistry(this.config.registryPath, registry);
        denied("listener_ownership_mismatch", `port ${port} does not match the owned lease entry`);
      }
      const result = this.config.deps.runTailscale(
        buildRemoveArgv(this.config.tailscaleBinPath, port, this.protectedPorts),
      );
      if (result.timedOut) denied("cli_timeout", `remove ${port} timed out`);
      if (result.code !== 0) denied("cli_error", `remove ${port} exited non-zero`);
      removedPorts.push(port);
    }

    const after = this.readServe();
    if (primaryDigest(after) !== beforePrimary) {
      denied("primary_route_violation", "protected :443 route changed during remove");
    }
    assertPrimaryIntact(after);
    this.assertProtectedIntact(before, after);
    const diff = new Set(changedPorts(before, after));
    for (const port of diff) {
      if (!lease.ports.includes(port)) denied("unexpected_serve_diff", `unexpected change on port ${port}`);
    }
    for (const port of removedPorts) {
      if (after.entries.get(port)) denied("unexpected_serve_diff", `port ${port} still present after remove`);
    }

    removeLeaseByHandle(registry, lease.handle);
    saveRegistry(this.config.registryPath, registry);

    this.config.auditSink.write({
      timestampIso: this.config.deps.nowIso(),
      peer,
      op: "remove",
      runtimeId: request.runtimeId,
      ports: lease.ports,
      requestId: request.requestId,
      decision: "allow",
      reasonCode: "ok",
      reason: "removed",
      beforeDigest: beforePrimary,
      afterDigest: primaryDigest(after),
      cliExitCategory: "ok",
      recovery: "cleanup",
    });

    return { ok: true, op: "remove", requestId: request.requestId, removedPorts };
  }

  private doList(
    request: Extract<BrokerRequest, { op: "list" }>,
    peer: PeerCredentials,
  ): BrokerResponse {
    const registry = this.loadRegistry();
    const listeners = registry.leases
      .filter((lease) => lease.state === "exposed" && lease.peerUid === peer.uid && lease.peerGid === peer.gid)
      .flatMap((lease) =>
        lease.ports.map((port, index) => ({
          runtimeId: lease.runtimeId,
          port,
          purpose: lease.purposes[index] ?? "app",
        })),
      );
    this.config.auditSink.write({
      timestampIso: this.config.deps.nowIso(),
      peer,
      op: "list",
      runtimeId: null,
      ports: listeners.map((l) => l.port),
      requestId: request.requestId,
      decision: "allow",
      reasonCode: "ok",
      reason: "listed",
    });
    return { ok: true, op: "list", requestId: request.requestId, listeners };
  }

  private fail(
    requestId: string | null,
    peer: PeerCredentials | null,
    op: string,
    code: string,
    error: unknown,
  ): BrokerResponse {
    const message = error instanceof Error ? error.message : String(error);
    try {
      this.config.auditSink.write({
        timestampIso: this.config.deps.nowIso(),
        peer,
        op,
        runtimeId: null,
        ports: [],
        requestId,
        decision: "deny",
        reasonCode: code as never,
        reason: message,
      });
    } catch {
      /* never let an audit failure mask the denial response */
    }
    return { ok: false, requestId, code: code as never, message: safeMessage(code) };
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Stable, comparable identity for the listening socket(s) on a port. Inodes are
 * already sorted by the verifier; joining them makes two snapshots comparable
 * with a single equality check.
 */
function listenerIdentity(ownership: ListenerOwnership): string {
  return ownership.inodes.join(",");
}

function codeForError(error: unknown): string {
  if (error instanceof ServeParseError) return "serve_parse_error";
  if (error instanceof AuthorizationError) return error.code;
  return "internal_error";
}

/** Client-facing message is a stable label; never echoes host/command detail. */
function safeMessage(code: string): string {
  return code;
}
