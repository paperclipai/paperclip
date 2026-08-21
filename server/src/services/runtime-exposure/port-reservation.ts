/**
 * Central reservation + ownership mediation for `tailscale_https` app/HMR port
 * pairs (PAP-17419, from the PAP-17251 finding).
 *
 * ## Why this module exists
 *
 * Before it, "is this pair free?" was answered by three unrelated views that
 * never had to agree:
 *
 *  1. the allocator's liveness probe — is anything *listening* right now,
 *  2. `collectReservedExposurePorts` — persisted rows, but only those whose
 *     `exposure.state` was not yet `removed`,
 *  3. the broker's Serve mapping — consulted nowhere on the allocation path.
 *
 * A workspace can hold an exclusive lease on a pair while satisfying none of
 * those: stop the backend and the listener is gone; tear the exposure down and
 * the row goes `stopped` with `exposure.state = "removed"` **and an emptied
 * `listeners` array**, so the row stops contributing anything to the reserved
 * set even though its `port` column still names the pair the lease owns. That
 * is exactly how the pair leased to workspace `b7ce28b4` (`42001/52001`) was
 * handed to the unrelated workspace `PAP-16986-add-posthog-mcp`, while
 * Paperclip went on reporting the leased lane `stopped` and its exposure
 * `removed`.
 *
 * ## The mediation this module centralizes
 *
 * - **Reservation follows the lease, not the process.** An execution workspace
 *   whose lease is still open reserves its pair through stop, teardown, and
 *   `removed` — until the lease is explicitly released. {@link
 *   buildExposureReservationLedger} derives the pair from the row's `port`
 *   column precisely because teardown erases `exposure.listeners`.
 * - **Complete mediation on allocation.** {@link findExposurePairConflict}
 *   checks the persisted ledger *and* the live listener owner *and* the Serve
 *   mapping owner. Any of the three disagreeing fails the allocation closed,
 *   naming the conflicting workspace/issue.
 * - **No adoption across execution workspaces, ever.** {@link
 *   isExposureAdoptionPermitted} is the single predicate for "may this claimant
 *   take over that holder's port", and it answers no whenever the two execution
 *   workspace IDs are not the identical, non-null value.
 * - **Drift is surfaced, not silently reused.** {@link
 *   findExposureReservationDrift} reports a `stopped`/`removed` row whose
 *   reserved ports are live or mapped by someone else, so reconciliation can
 *   report a false-`stopped` lane instead of recycling it.
 *
 * Pure functions and one in-process claim registry: no sockets, no DB, no
 * broker. Every caller injects its own view, which is what makes all five
 * PAP-17419 regression cases testable without touching host Serve state.
 */
import { deriveViteHmrPort, isRuntimeExposureAppPort } from "@paperclipai/shared";

/**
 * Who holds (or wants) a port pair. Every field is optional evidence — a
 * conflict report is only as specific as the views that produced it — but
 * `executionWorkspaceId` is the identity that governs adoption.
 */
export interface ExposureOwnerIdentity {
  runtimeServiceId: string | null;
  executionWorkspaceId: string | null;
  projectWorkspaceId: string | null;
  issueId: string | null;
}

/** Where a reservation came from, ordered by strength of evidence below. */
export type ExposureReservationSource =
  /** This process is running the runtime that owns the pair. */
  | "in_memory_runtime"
  /** The broker reports a live Paperclip-owned Serve mapping on the port. */
  | "broker_mapping"
  /** A persisted row still claims an exposure that is not `removed`. */
  | "persisted_exposure"
  /** A stopped/removed row whose execution-workspace lease is still open. */
  | "leased_workspace"
  /** Quarantined after an ambiguous cleanup; never reusable by anyone. */
  | "quarantine";

/**
 * Precedence when several views claim one port. Strongest first: the report
 * should name the most concrete evidence available, so an operator reading
 * "held by the live Serve mapping for workspace X" is not told "reserved by a
 * lease" when both are true.
 */
const RESERVATION_SOURCE_RANK: Record<ExposureReservationSource, number> = {
  quarantine: 0,
  in_memory_runtime: 1,
  broker_mapping: 2,
  persisted_exposure: 3,
  leased_workspace: 4,
};

export interface ExposurePortReservation {
  port: number;
  source: ExposureReservationSource;
  owner: ExposureOwnerIdentity;
}

export interface ExposureReservationLedger {
  /** Every port currently spoken for, whoever holds it. */
  reservedPorts: ReadonlySet<number>;
  /** Strongest-evidence reservation per port. */
  reservationByPort: ReadonlyMap<number, ExposurePortReservation>;
}

/**
 * The subset of a `workspace_runtime_services` row this module reasons about.
 * Deliberately structural rather than the Drizzle row type: startup
 * reconciliation, allocation, and tests all project into it from different
 * queries.
 */
export interface PersistedExposureRowSnapshot {
  id: string;
  status: string;
  executionWorkspaceId: string | null;
  projectWorkspaceId: string | null;
  issueId: string | null;
  /** App port column; survives teardown and is the lease's durable claim. */
  port: number | null;
  exposure: {
    state: string;
    listeners: ReadonlyArray<{ targetPort: number }>;
  } | null;
}

/** A runtime this process is currently running with an exposure attached. */
export interface InMemoryExposureSnapshot {
  runtimeServiceId: string;
  executionWorkspaceId: string | null;
  projectWorkspaceId: string | null;
  issueId: string | null;
  ports: ReadonlyArray<number>;
}

/** One Paperclip-owned listener as reported by the broker's `list()`. */
export interface BrokerMappingSnapshot {
  runtimeId: string;
  port: number;
}

export interface BuildExposureReservationLedgerInput {
  persistedRows?: Iterable<PersistedExposureRowSnapshot>;
  inMemoryRuntimes?: Iterable<InMemoryExposureSnapshot>;
  brokerMappings?: Iterable<BrokerMappingSnapshot>;
  quarantinedPorts?: Iterable<number>;
  /**
   * Execution workspaces whose exclusive lease is still open. A row belonging
   * to one of these reserves its pair regardless of process or exposure state;
   * that is the whole fix for "stopped-but-leased pair reuse".
   */
  activeExecutionWorkspaceIds?: Iterable<string>;
  /** In-process pair claims held by starts that have not bound a listener yet. */
  inFlightClaimedPorts?: Iterable<number>;
}

function emptyIdentity(): ExposureOwnerIdentity {
  return {
    runtimeServiceId: null,
    executionWorkspaceId: null,
    projectWorkspaceId: null,
    issueId: null,
  };
}

/**
 * Every port a row's pair covers.
 *
 * The union of the exposure's declared listeners and the pair derived from the
 * `port` column matters: `deprovisionExposure` replaces the status with a fresh
 * `removed` one whose `listeners` is `[]`, so a torn-down row would otherwise
 * contribute nothing at all. The `port` column is what still names the pair the
 * lease paid for.
 */
export function collectRowExposurePorts(row: PersistedExposureRowSnapshot): Set<number> {
  const ports = new Set<number>();
  for (const listener of row.exposure?.listeners ?? []) {
    if (Number.isInteger(listener.targetPort)) ports.add(listener.targetPort);
  }
  if (row.port !== null && isRuntimeExposureAppPort(row.port)) {
    ports.add(row.port);
    ports.add(deriveViteHmrPort(row.port));
  }
  return ports;
}

/** True when the row's own exposure state still claims the mapping. */
function rowClaimsLiveExposure(row: PersistedExposureRowSnapshot): boolean {
  return Boolean(row.exposure) && row.exposure!.state !== "removed";
}

/**
 * True when the row itself says nothing of its own should be listening: it is
 * recorded stopped/failed, its exposure was explicitly torn down, or it never
 * reached `running` and left only a reserved pair behind.
 *
 * A RUNNING row with no exposure state at all is the one shape that must not
 * count as dormant. Pre-exposure services carry a plain `port` column with
 * `exposure: null`, and when that port happens to sit inside the dedicated
 * range, a dormant classification turns the row's own live listener into a
 * "drift" finding — which the startup sweep then quarantines instead of
 * adopting, orphaning a healthy surviving service.
 */
export function isDormantExposureRow(row: PersistedExposureRowSnapshot): boolean {
  if (row.status === "stopped" || row.status === "failed") return true;
  if (row.exposure) return row.exposure.state === "removed";
  return row.status !== "running";
}

function rowIdentity(row: PersistedExposureRowSnapshot): ExposureOwnerIdentity {
  return {
    runtimeServiceId: row.id,
    executionWorkspaceId: row.executionWorkspaceId,
    projectWorkspaceId: row.projectWorkspaceId,
    issueId: row.issueId,
  };
}

/**
 * Merge every reservation view into one ledger. Later, weaker evidence never
 * overwrites a stronger claim already recorded for the same port.
 */
export function buildExposureReservationLedger(
  input: BuildExposureReservationLedgerInput,
): ExposureReservationLedger {
  const reservationByPort = new Map<number, ExposurePortReservation>();

  const record = (port: number, source: ExposureReservationSource, owner: ExposureOwnerIdentity) => {
    if (!Number.isInteger(port)) return;
    const existing = reservationByPort.get(port);
    if (existing && RESERVATION_SOURCE_RANK[existing.source] <= RESERVATION_SOURCE_RANK[source]) return;
    reservationByPort.set(port, { port, source, owner });
  };

  const activeLeases = new Set(input.activeExecutionWorkspaceIds ?? []);

  for (const port of input.quarantinedPorts ?? []) record(port, "quarantine", emptyIdentity());
  // An in-flight claim has no identity yet by construction — the claiming start
  // has not persisted a row. It still must block a concurrent allocator.
  for (const port of input.inFlightClaimedPorts ?? []) record(port, "in_memory_runtime", emptyIdentity());

  for (const runtime of input.inMemoryRuntimes ?? []) {
    const owner: ExposureOwnerIdentity = {
      runtimeServiceId: runtime.runtimeServiceId,
      executionWorkspaceId: runtime.executionWorkspaceId,
      projectWorkspaceId: runtime.projectWorkspaceId,
      issueId: runtime.issueId,
    };
    for (const port of runtime.ports) record(port, "in_memory_runtime", owner);
  }

  // Broker mappings identify a runtime, not a workspace; resolve the workspace
  // from the persisted rows when we can so a conflict can name it.
  const rows = [...(input.persistedRows ?? [])];
  const identityByRuntimeId = new Map(rows.map((row) => [row.id, rowIdentity(row)]));
  for (const mapping of input.brokerMappings ?? []) {
    record(
      mapping.port,
      "broker_mapping",
      identityByRuntimeId.get(mapping.runtimeId)
        ?? { ...emptyIdentity(), runtimeServiceId: mapping.runtimeId },
    );
  }

  for (const row of rows) {
    const leaseOpen = Boolean(row.executionWorkspaceId) && activeLeases.has(row.executionWorkspaceId!);
    const claimsExposure = rowClaimsLiveExposure(row);
    if (!leaseOpen && !claimsExposure) continue;
    const source: ExposureReservationSource = claimsExposure ? "persisted_exposure" : "leased_workspace";
    for (const port of collectRowExposurePorts(row)) record(port, source, rowIdentity(row));
  }

  return { reservationByPort, reservedPorts: new Set(reservationByPort.keys()) };
}

/**
 * May `claimant` take over a port currently attributed to `holder`?
 *
 * The rule is deliberately narrow, because the failure this prevents is a
 * managed start silently adopting another issue's live service and then
 * generating security evidence attributed to the wrong workspace:
 *
 *  - the same runtime service reclaiming its own port is fine (restart);
 *  - otherwise both sides must name the *same, non-null* execution workspace.
 *
 * An unknown identity on either side is never adopted. "We could not tell whose
 * it is" is a reason to fail closed, not a reason to assume it is ours.
 */
export function isExposureAdoptionPermitted(
  holder: ExposureOwnerIdentity | null,
  claimant: ExposureOwnerIdentity,
): boolean {
  if (!holder) return true;
  if (
    holder.runtimeServiceId !== null
    && claimant.runtimeServiceId !== null
    && holder.runtimeServiceId === claimant.runtimeServiceId
  ) {
    return true;
  }
  if (holder.executionWorkspaceId === null || claimant.executionWorkspaceId === null) return false;
  return holder.executionWorkspaceId === claimant.executionWorkspaceId;
}

export type ExposurePortConflictCode =
  | "quarantined_port"
  | "reserved_by_other_workspace"
  | "listener_owned_by_other_workspace"
  | "serve_mapping_owned_by_other_workspace";

export interface ExposurePortConflict {
  code: ExposurePortConflictCode;
  port: number;
  claimant: ExposureOwnerIdentity;
  holder: ExposureOwnerIdentity | null;
  source: ExposureReservationSource | null;
}

export interface FindExposurePairConflictInput {
  pair: { appPort: number; hmrPort: number };
  claimant: ExposureOwnerIdentity;
  ledger: ExposureReservationLedger;
  /**
   * Identity behind the process actually listening on each port, when one could
   * be resolved. `null` for a port with a live listener whose owner is unknown —
   * which is itself a conflict, since an unattributable listener must never be
   * adopted.
   */
  listenerOwners?: ReadonlyMap<number, ExposureOwnerIdentity | null>;
  /** Identity behind each live Serve mapping, keyed by port. */
  serveMappingOwners?: ReadonlyMap<number, ExposureOwnerIdentity | null>;
}

/**
 * Complete mediation for one candidate pair: the first conflict across the
 * persisted ledger, the live listeners, and the Serve mappings — or null when
 * all three agree the claimant may have it.
 */
export function findExposurePairConflict(
  input: FindExposurePairConflictInput,
): ExposurePortConflict | null {
  const ports = [input.pair.appPort, input.pair.hmrPort];

  for (const port of ports) {
    const reservation = input.ledger.reservationByPort.get(port);
    if (!reservation) continue;
    if (reservation.source === "quarantine") {
      return { code: "quarantined_port", port, claimant: input.claimant, holder: null, source: "quarantine" };
    }
    if (!isExposureAdoptionPermitted(reservation.owner, input.claimant)) {
      return {
        code: "reserved_by_other_workspace",
        port,
        claimant: input.claimant,
        holder: reservation.owner,
        source: reservation.source,
      };
    }
  }

  // Presence in these maps means the host has something on the port. A `null`
  // value is therefore NOT "no holder" — it is "a holder we could not name",
  // which is the one case that must never be adopted. `isExposureAdoptionPermitted`
  // is only consulted once we have an identity to compare.
  for (const port of ports) {
    if (!input.listenerOwners?.has(port)) continue;
    const owner = input.listenerOwners.get(port) ?? null;
    if (owner === null || !isExposureAdoptionPermitted(owner, input.claimant)) {
      return {
        code: "listener_owned_by_other_workspace",
        port,
        claimant: input.claimant,
        holder: owner,
        source: null,
      };
    }
  }

  for (const port of ports) {
    if (!input.serveMappingOwners?.has(port)) continue;
    const owner = input.serveMappingOwners.get(port) ?? null;
    if (owner === null || !isExposureAdoptionPermitted(owner, input.claimant)) {
      return {
        code: "serve_mapping_owned_by_other_workspace",
        port,
        claimant: input.claimant,
        holder: owner,
        source: null,
      };
    }
  }

  return null;
}

function describeIdentity(identity: ExposureOwnerIdentity | null): string {
  if (!identity) return "an unidentified owner";
  const parts: string[] = [];
  if (identity.executionWorkspaceId) parts.push(`execution workspace ${identity.executionWorkspaceId}`);
  if (identity.issueId) parts.push(`issue ${identity.issueId}`);
  if (identity.runtimeServiceId) parts.push(`runtime service ${identity.runtimeServiceId}`);
  if (identity.projectWorkspaceId && parts.length === 0) {
    parts.push(`project workspace ${identity.projectWorkspaceId}`);
  }
  return parts.length > 0 ? parts.join(", ") : "an unidentified owner";
}

const CONFLICT_REASONS: Record<ExposurePortConflictCode, string> = {
  quarantined_port: "is quarantined after an ambiguous exposure cleanup and can never be reused",
  reserved_by_other_workspace: "is reserved by",
  listener_owned_by_other_workspace: "has a live loopback listener owned by",
  serve_mapping_owned_by_other_workspace: "is published by a Tailscale Serve mapping owned by",
};

/**
 * Operator-facing conflict text. Always names the port and the conflicting
 * workspace/issue identity: a bare "port unavailable" is what made the original
 * incident take a manual `tailscale serve status` read to attribute.
 */
export function describeExposurePortConflict(conflict: ExposurePortConflict): string {
  const subject = `port ${conflict.port}`;
  if (conflict.code === "quarantined_port") {
    return `${subject} ${CONFLICT_REASONS.quarantined_port}`;
  }
  const suffix = conflict.source === "leased_workspace"
    ? " (the lane is stopped, but its lease is still open)"
    : "";
  return `${subject} ${CONFLICT_REASONS[conflict.code]} ${describeIdentity(conflict.holder)}${suffix}`;
}

/** Thrown on the allocation/start path so the failure is terminal and attributed. */
export class ExposurePortOwnershipConflictError extends Error {
  readonly code = "exposure_port_ownership_conflict" as const;

  constructor(readonly conflict: ExposurePortConflict) {
    super(`HTTPS exposure allocation denied: ${describeExposurePortConflict(conflict)}`);
    this.name = "ExposurePortOwnershipConflictError";
  }
}

export interface ExposureReservationDrift {
  /** The row Paperclip believes is stopped/removed. */
  runtimeServiceId: string;
  owner: ExposureOwnerIdentity;
  port: number;
  reason: "live_listener" | "serve_mapping";
  /** Who actually holds it, when that could be attributed. */
  conflictingOwner: ExposureOwnerIdentity | null;
}

export interface FindExposureReservationDriftInput {
  persistedRows: Iterable<PersistedExposureRowSnapshot>;
  /** Ports with a live loopback listener right now. */
  livePorts?: ReadonlySet<number>;
  listenerOwners?: ReadonlyMap<number, ExposureOwnerIdentity | null>;
  brokerMappings?: Iterable<BrokerMappingSnapshot>;
}

/**
 * Rows whose state says "nothing here" while the host says otherwise.
 *
 * Reconciliation calls this so a lane reported `stopped` with its exposure
 * `removed` — but whose reserved ports are live, or mapped to some other
 * runtime — becomes a visible, attributable finding instead of a pair that
 * quietly returns to the free list. A port still held by the row's *own*
 * runtime is not drift; that is just a lane the sweep has yet to adopt.
 */
export function findExposureReservationDrift(
  input: FindExposureReservationDriftInput,
): ExposureReservationDrift[] {
  const rows = [...input.persistedRows];
  const identityByRuntimeId = new Map(rows.map((row) => [row.id, rowIdentity(row)]));
  const mappingOwnerByPort = new Map<number, ExposureOwnerIdentity>();
  for (const mapping of input.brokerMappings ?? []) {
    mappingOwnerByPort.set(
      mapping.port,
      identityByRuntimeId.get(mapping.runtimeId)
        ?? { ...emptyIdentity(), runtimeServiceId: mapping.runtimeId },
    );
  }

  const drift: ExposureReservationDrift[] = [];
  for (const row of rows) {
    if (!isDormantExposureRow(row)) continue;
    const owner = rowIdentity(row);
    for (const port of collectRowExposurePorts(row)) {
      const mappingOwner = mappingOwnerByPort.get(port) ?? null;
      if (mappingOwner && mappingOwner.runtimeServiceId !== row.id) {
        drift.push({ runtimeServiceId: row.id, owner, port, reason: "serve_mapping", conflictingOwner: mappingOwner });
        continue;
      }
      if (!input.livePorts?.has(port)) continue;
      const listenerOwner = input.listenerOwners?.get(port) ?? null;
      if (listenerOwner && listenerOwner.runtimeServiceId === row.id) continue;
      drift.push({ runtimeServiceId: row.id, owner, port, reason: "live_listener", conflictingOwner: listenerOwner });
    }
  }
  return drift;
}

/** Human-readable drift line for reconciliation logs and operator evidence. */
export function describeExposureReservationDrift(entry: ExposureReservationDrift): string {
  const held = entry.reason === "serve_mapping"
    ? "is still published by a Tailscale Serve mapping"
    : "still has a live loopback listener";
  return (
    `runtime service ${entry.runtimeServiceId} (${describeIdentity(entry.owner)}) is recorded stopped/removed, `
    + `but its reserved port ${entry.port} ${held} owned by ${describeIdentity(entry.conflictingOwner)}`
  );
}

/**
 * In-process, pair-atomic claims for starts that have not bound a listener yet.
 *
 * Two concurrent allocators see identical persisted state and identical probe
 * results, so without a claim they both walk away with the lowest free pair.
 * Claiming is all-or-nothing across the two ports: a half-claimed pair would
 * let one start own the app port and another the HMR port, which is the
 * orphaned-companion failure the pairing exists to prevent.
 */
export class ExposurePortPairClaims {
  private readonly heldUntilByPort = new Map<number, number>();

  constructor(private readonly ttlMs: number = 120_000) {}

  private isHeld(port: number, nowMs: number): boolean {
    const heldUntil = this.heldUntilByPort.get(port);
    if (heldUntil === undefined) return false;
    if (heldUntil > nowMs) return true;
    this.heldUntilByPort.delete(port);
    return false;
  }

  /** Claim both ports, or neither. Returns false when either is already held. */
  claim(pair: { appPort: number; hmrPort: number }, nowMs: number = Date.now()): boolean {
    if (this.isHeld(pair.appPort, nowMs) || this.isHeld(pair.hmrPort, nowMs)) return false;
    this.heldUntilByPort.set(pair.appPort, nowMs + this.ttlMs);
    this.heldUntilByPort.set(pair.hmrPort, nowMs + this.ttlMs);
    return true;
  }

  /** Release on lease release/teardown, or when a start reaches a terminal state. */
  release(pair: { appPort: number; hmrPort: number }): void {
    this.heldUntilByPort.delete(pair.appPort);
    this.heldUntilByPort.delete(pair.hmrPort);
  }

  /** Ports still claimed, for folding into an allocator's reserved set. */
  activePorts(nowMs: number = Date.now()): Set<number> {
    const active = new Set<number>();
    for (const port of [...this.heldUntilByPort.keys()]) {
      if (this.isHeld(port, nowMs)) active.add(port);
    }
    return active;
  }

  clear(): void {
    this.heldUntilByPort.clear();
  }
}
