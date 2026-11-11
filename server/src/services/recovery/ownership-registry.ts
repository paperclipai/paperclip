import { promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull, isNull, like, notInArray, notLike, or, sql, type SQL } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  environmentLeases,
  executionWorkspaceRestorePoints,
  executionWorkspaceRuntimeLeases,
  executionWorkspaceSnapshots,
  executionWorkspaces,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeHarnessBackups,
  nativeProviderArtifacts,
  nativeRunFinalizations,
  sandboxCreationOperations,
  workspaceOperations,
  workspaceRuntimeServices,
  type Db,
} from "@paperclipai/db";
import { EXECUTION_RECONCILIATION_CAUSES } from "@paperclipai/shared";
import { currentControllerBootId, readControllerProcess } from "../controller-process-identity.js";
import { isRemoteWorkspaceSaveInvocationLive } from "../remote-workspaces.js";
import { idleAccountingSpoolPath, idleOrphanSpoolPath } from "../idle-local-work.js";
import {
  NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT,
  NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
} from "../native-runtime/native-runner-ownership.js";
import type { LocalOwnerStamp, OwnerProof, RemoteFenceState, RemoteOwnerStamp } from "../owner-proof.js";
import { OPERATOR_ATTESTED_PROCESS_SPACE } from "../owner-proof.js";
import { writeEnvironmentCleanup } from "../environment-cleanup-notifications.js";
import { OWNER_GONE_ATTESTATION_KEY, attestOwnerGoneByRecordVersion, requestOwnerGoneConfirmation } from "./owner-gone-attestation.js";
import {
  requestNativeAcceptedResultLeaseOperatorAction,
  settleNativeAcceptedResultLease, classifyNativeAcceptedResultLeaseOwners,
} from "../native-runtime/native-accepted-result-lease-settlement.js";
import { settleClaimedWakeRequest } from "./wake-request-claimed-settlement.js";
import { settleAbandonedRemoteSnapshotSave, settleAbandonedWorkspaceCommandOperation, settleAbandonedWorkspaceFinalizeAttempt } from "./workspace-finalize-attempt-settlement.js";
import { settlePreparationOnlyRemoteWorkspaceEpoch } from "./remote-workspace-unsaved-files-settlement.js";
import { settleAbandonedRemoteSnapshotLedger } from "./remote-snapshot-ledger-settlement.js";
import { LOCAL_WORKSPACE_COMMAND_PHASES, runtimeControlOperationOwnerStamp, settleRuntimeControlOperation } from "../workspace-operations.js";
import { copybackOwnerHoldOwner, settleCopybackOwnerHold } from "./copyback-owner-hold.js";
import { applyObservedFenceProviderProof, observedWorkspaceFenceOwner, settleObservedWorkspaceFence } from "./observed-workspace-fence.js";
import { copybackOwnerStamp } from "../native-runtime/native-workspace-owner-stop-proof.js";
import { legacyShutdownSettlementOwner, settleLegacyShutdownSettlementFence } from "../legacy-shutdown-workspace-settlement.js";
import { nativeControllerOwnerStamp, runProcessOwnerStamp } from "../native-runtime/native-owner-stamps.js";
import { settleIssueLock } from "./issue-lock-settlement.js";
import { settleAgentLifecycleLease } from "./agent-lifecycle-lease-settlement.js";
import { legacyControllerOwnerStamp, settleLegacyControllerLease } from "../legacy-controller-lease.js";
import { heldInterruptedPreparationWhere, settleHeldInterruptedPreparation } from "../interrupted-preparation-hold-settlement.js";
import { completedTurnCleanupHoldWhere, settleCompletedTurnCleanupHolds } from "../native-runtime/completed-turn-cleanup-hold-settlement.js";
import {
  nativeLeaseHolderStamp,
  readNativeLeaseHolder,
  settleNativeTokenLease,
  type NativeTokenLeaseKind,
} from "../native-runtime/native-token-lease-settlement.js";
import { ephemeralServerEnabled } from "../ephemeral-server-mode.js";
import { ENVIRONMENT_LEASE_CONTROLLER_KEY } from "../environment-lease-controller.js";
import {
  ENVIRONMENT_CLEANUP_RETRY_MS,
  pendingCleanupDeadlineSql,
  recoveredOrphanFirstAttemptSql,
} from "../environment-cleanup-state.js";
import { settleEnvironmentLoginProbeLease } from "../environment-login-probe-lease-settlement.js";
import { settleEnvironmentRunLease } from "../environment-run-lease-settlement.js";
import { settleEnvironmentTeardownClaim } from "../environment-teardown-claim-settlement.js";
import { settleSandboxCreationIntent } from "../sandbox-creation-intent-settlement.js";
import {
  nextRetainedOrphanDueAt,
  releasableRetainedOrphanCondition,
  settleRetainedOrphanSandbox,
} from "../environment-retained-orphan-settlement.js";
import { settleExecutionWorkspaceRuntimeLease } from "../workspace-runtime-lease-settlement.js";
import { parseWorkspaceRuntimeLeaseOwnerKey } from "../workspace-runtime-leases.js";

/**
 * Registry of ownable record kinds (plan section C).
 *
 * Each kind lists its in-progress records and says who owns each one. A kind
 * without a `settle` is report-only: the reconciler classifies its owners and
 * runs invariant checks but never changes it. Phase 2 moves kinds onto the
 * shared path one PR at a time: the kind registers a compare-and-swap
 * `settle`, called only when `proveOwnerGone` returns gone, and its bespoke
 * release path is deleted.
 *
 * The kinds are the section-C rows of doc/plans/2026-11-07-ownership-inventory.md.
 * Each kind names exactly one obligation; settling one never settles another.
 */

export type Obligation = "ownership" | "accepted_result" | "workspace_preservation" | "accounting";

/** Who may move a record forward. */
export type RecordOwner =
  /** A process, proved by `proveOwnerGone(stamp)`. */
  | { kind: "process"; stamp: LocalOwnerStamp }
  /** A fence or lease token, proved against the fence's current holder. */
  | { kind: "fence"; stamp: RemoteOwnerStamp; fence: RemoteFenceState }
  /** A run id only. The record's owner is that run's execution. */
  | { kind: "run"; runId: string }
  /** An issue id only. Gone when the issue is missing, hidden or terminal. */
  | { kind: "issue"; issueId: string }
  /** A person or agent assignment, such as an operator-owned recovery action. */
  | { kind: "operator"; ownerType: string | null }
  /** A durable work queue that acts on the record by its saved deadline. The
   * queue owns the record while that deadline is current; a deadline long past
   * is a gap (the queue is not acting), never a release. */
  | { kind: "queue"; queue: string; dueAt: Date; graceMs: number }
  /** Nothing on the record names an owner (invariant 1). */
  | { kind: "none" };

export type InProgressRecord = {
  recordId: string;
  companyId: string | null;
  runId: string | null;
  issueId: string | null;
  owner: RecordOwner;
  /** When the record last changed, when the storage records it. */
  updatedAt: Date | null;
};

export type ListResult = { records: InProgressRecord[]; truncated: boolean };

export type SettleOutcome = {
  settled: boolean; reason: string;
  /** False when the settle has nothing left to do for this record (the
   * record waits on another owner, such as the board). The reconciler still
   * lists and reports it, but keeps no settle watch on it. */
  watch?: boolean;
};

/** Moves one record whose owner was just proven gone to its next state. It must
 * compare-and-swap on the exact owner that was proven, so a record taken over
 * since the proof is never released. It is called only with a `gone` proof. */
export type SettleRecord = (db: Db, record: InProgressRecord, context: { now: Date; proof: OwnerProof }) => Promise<SettleOutcome>;

/** Surfaces the operator action for a record whose owner is unprovable. It
 * never releases the record. Idempotent. */
export type UnprovableAction = (db: Db, record: InProgressRecord, context: { now: Date; proof: OwnerProof }) => Promise<void>;

export type OwnableKind = {
  id: string;
  title: string;
  obligation: Obligation;
  storage: "database" | "local_disk";
  /** Null when Phase 1 cannot enumerate the kind; the report names the gap. */
  /** Lists one page in a stable order; the report pages through the kind
   * within one pass. */
  listInProgress: ((db: Db, limit: number, offset: number) => Promise<ListResult>) | null;
  /** Lists only the in-progress records of these runs, uncapped. Settling
   * kinds provide it so a run-scoped settle never misses a requested run. */
  listForRuns?: (db: Db, runIds: readonly string[]) => Promise<InProgressRecord[]>;
  /** Null while the kind is report-only. */
  settle: SettleRecord | null;
  /** Optional operator action for an unprovable owner of a settling kind. */
  onUnprovable?: UnprovableAction;
  /** Records the board's confirmation that this record's unrecorded owner stopped, so its
   * owner proves gone (`operator_attested`). Returns false when the record no longer qualifies. */
  attestOwnerGone?: (tx: Db, target: { companyId: string; recordId: string; requestedVersion: string | null },
    proof: Record<string, unknown>) => Promise<"attested" | "released" | "changed">;
  /** `record_version`: the board's confirmation stays on its recovery action, bound to the
   * record version it was asked about, and the reconciler reads it back as `operator_attested`. */
  ownerGoneAttestation?: "record_version";
  /** When a record of this kind next becomes settleable without a signal
   * (a retention window ending). The reconciler wakes then. */
  nextDueAt?: (db: Db, now: Date) => Promise<Date | null>;
  /** Plan invariants this kind is checked against (1–8). */
  invariantChecks: readonly number[];
  /** Why the kind cannot be listed, when `listInProgress` is null. */
  coverageGap?: string;
};

/** Final `native_run_finalizations` phases (shared with settle paths). */
export const TERMINAL_PHASES = ["committed", "terminal_failure", "applied"];

function page<T>(rows: T[], limit: number): { rows: T[]; truncated: boolean } {
  return rows.length > limit ? { rows: rows.slice(0, limit), truncated: true } : { rows, truncated: false };
}

function json(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

const runOwner = (runId: string | null | undefined): RecordOwner => runId ? { kind: "run", runId } : { kind: "none" };

/**
 * Lets the board confirm that a settling kind's unrecorded owner stopped. A process-owned record
 * saved before its owner was fully recorded (`missing_identity`, `process_space_unrecorded`) is
 * unprovable and is never released on its own; the board's confirmation, bound to the record
 * version recovery asked about, proves its owner gone, and the kind's own settle releases it.
 */
function ownerGoneAttestable(kind: OwnableKind, lockVersion: RecordVersionLock): OwnableKind {
  const ask = requestOwnerGoneConfirmation(kind.id);
  const settle = kind.settle!;
  return { ...kind, ownerGoneAttestation: "record_version",
    attestOwnerGone: (tx, target) => attestOwnerGoneByRecordVersion(tx, target, lockVersion),
    // These settles compare-and-swap on the recorded process, so only a process-owned record can be
    // released; a record with no version cannot be bound to a confirmation. Recovery asks for neither.
    onUnprovable: async (db, record, context) => {
      if (record.owner.kind === "process" && record.updatedAt) await ask(db, record, context);
    },
    // A confirmation proves the owner gone only for the version the board confirmed: lock the
    // record and check that version in the same transaction as the kind's own settle.
    settle: (db, record, context) => context.proof.reason !== "operator_attested" ? settle(db, record, context)
      : db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const version = record.companyId ? await lockVersion(tx, { companyId: record.companyId, recordId: record.recordId }) : null;
        if (!version || !record.updatedAt || version.getTime() !== record.updatedAt.getTime()) {
          return { settled: false, reason: "record_changed_since_confirmation" };
        }
        return settle(tx, record, context);
      }) };
}

/** Locks a record row for update and returns its last write time (null when the row is gone). */
type RecordVersionLock = (tx: Db, target: { companyId: string; recordId: string }) => Promise<Date | null>;

function versionLock(table: typeof heartbeatRuns | typeof environmentLeases | typeof sandboxCreationOperations
  | typeof workspaceOperations): RecordVersionLock {
  return async (tx, target) => {
    const [row] = await tx.select({ updatedAt: table.updatedAt }).from(table)
      .where(and(eq(table.id, target.recordId), eq(table.companyId, target.companyId))).for("update");
    return row?.updatedAt ?? null;
  };
}

const nrfVersionLock: RecordVersionLock = async (tx, target) => {
  const [row] = await tx.select({ updatedAt: nativeRunFinalizations.updatedAt }).from(nativeRunFinalizations)
    .where(and(eq(nativeRunFinalizations.runId, target.recordId), eq(nativeRunFinalizations.companyId, target.companyId)))
    .for("update");
  return row?.updatedAt ?? null;
};

// ----------------------------------------------------------------------------
// native_run_finalizations

type NrfRow = typeof nativeRunFinalizations.$inferSelect;

/** The NRF controller stamp, shared with native recovery (native-owner-stamps.ts). */
const nrfStamp = (row: NrfRow, scope: string): LocalOwnerStamp => nativeControllerOwnerStamp(row, scope);

function nrfKind(id: string, title: string, obligation: Obligation, where: SQL | undefined,
  owner: (row: NrfRow) => RecordOwner = row => ({ kind: "process", stamp: nrfStamp(row, id) }),
  invariantChecks: readonly number[] = [1, 2]): OwnableKind {
  const record = (row: NrfRow): InProgressRecord => ({
    recordId: row.runId, companyId: row.companyId, runId: row.runId, issueId: row.issueId,
    owner: owner(row), updatedAt: row.updatedAt,
  });
  return {
    id, title, obligation, storage: "database", settle: null, invariantChecks,
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select().from(nativeRunFinalizations).where(where).orderBy(asc(nativeRunFinalizations.runId)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(record) };
    },
    listForRuns: async (db, runIds) => {
      const records: InProgressRecord[] = [];
      for (let index = 0; index < runIds.length; index += 500) {
        const rows = await db.select().from(nativeRunFinalizations)
          .where(and(where, inArray(nativeRunFinalizations.runId, [...runIds.slice(index, index + 500)])));
        records.push(...rows.map(record));
      }
      return records;
    },
  };
}

const notFinalizerOrCleanup = and(notLike(nativeRunFinalizations.leaseOwner, "native-finalizer:%"),
  notLike(nativeRunFinalizations.leaseOwner, "native-cleanup:%"));

/** A token-only NRF lease (finalizer or cleanup) is a fence held by the token. */
function nrfFenceOwner(row: NrfRow, scope: string): RecordOwner {
  return {
    kind: "fence",
    stamp: { kind: "remote", scope, generation: row.controllerGeneration ?? null, fenceToken: row.leaseOwner },
    fence: { currentFenceToken: row.leaseOwner, currentGeneration: row.controllerGeneration ?? null,
      leaseExpiresAt: row.leaseExpiresAt },
  };
}

/** A finalizer or cleanup lease is owned by the process in `lease_holder`.
 * Rows saved before that column keep the token fence (expiry plus takeover). */
function nrfTokenLeaseOwner(row: NrfRow, scope: NativeTokenLeaseKind): RecordOwner {
  const holder = readNativeLeaseHolder(row.leaseHolder, row.leaseOwner);
  return holder ? { kind: "process", stamp: nativeLeaseHolderStamp(holder, scope) } : nrfFenceOwner(row, scope);
}

// ----------------------------------------------------------------------------
// heartbeat_runs

type RunRow = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "issueId" | "status" | "controllerBootId"
  | "controllerLeaseExpiresAt" | "processPid" | "processGroupId" | "processStartedAt" | "processHostHash" | "updatedAt"
  | "runnerProfileJson" | "controllerProcess">;

const runColumns = {
  id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, issueId: heartbeatRuns.issueId, status: heartbeatRuns.status,
  controllerBootId: heartbeatRuns.controllerBootId, controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
  processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
  processStartedAt: heartbeatRuns.processStartedAt, processHostHash: heartbeatRuns.processHostHash,
  updatedAt: heartbeatRuns.updatedAt,
  runnerProfileJson: heartbeatRuns.runnerProfileJson,
  controllerProcess: heartbeatRuns.controllerProcess,
};

function runKind(id: string, title: string, obligation: Obligation, where: SQL | undefined,
  owner: (row: RunRow) => RecordOwner, invariantChecks: readonly number[] = [1, 2]): OwnableKind {
  return {
    id, title, obligation, storage: "database", settle: null, invariantChecks,
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select(runColumns).from(heartbeatRuns).where(where).orderBy(asc(heartbeatRuns.id)).limit(limit + 1).offset(offset);
      const result = page(rows as RunRow[], limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: row.id, issueId: row.issueId,
        owner: owner(row), updatedAt: row.updatedAt,
      })) };
    },
  };
}

/** The adapter child's stamp (native-owner-stamps.ts). Rows saved before
 * `process_host_hash` stay unprovable here. */
const runProcessStamp = (row: RunRow, scope: string): LocalOwnerStamp => runProcessOwnerStamp(row, scope);

const legacyControllerLeaseWhere = and(eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
  isNotNull(heartbeatRuns.controllerBootId), sql`${heartbeatRuns.controllerLeaseExpiresAt} > now()`);

function legacyControllerLeaseOwner(row: RunRow): RecordOwner {
  const stamp = legacyControllerOwnerStamp(row);
  if (stamp) return { kind: "process", stamp };
  return { kind: "fence", stamp: { kind: "remote", scope: "legacy_controller_lease", generation: null,
    fenceToken: row.controllerBootId },
  fence: { currentFenceToken: row.controllerBootId, currentGeneration: null, leaseExpiresAt: row.controllerLeaseExpiresAt } };
}

// ----------------------------------------------------------------------------
// environment_leases

type LeaseRow = Pick<typeof environmentLeases.$inferSelect, "id" | "companyId" | "heartbeatRunId" | "issueId"
  | "metadata" | "updatedAt">;

function leaseKind(id: string, title: string, obligation: Obligation, where: SQL | undefined,
  owner: (row: LeaseRow) => RecordOwner, invariantChecks: readonly number[] = [1, 2]): OwnableKind {
  return {
    id, title, obligation, storage: "database", settle: null, invariantChecks,
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: environmentLeases.id, companyId: environmentLeases.companyId,
        heartbeatRunId: environmentLeases.heartbeatRunId, issueId: environmentLeases.issueId,
        metadata: environmentLeases.metadata, updatedAt: environmentLeases.updatedAt })
        .from(environmentLeases).where(where).orderBy(asc(environmentLeases.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: row.heartbeatRunId, issueId: row.issueId,
        owner: owner(row), updatedAt: row.updatedAt,
      })) };
    },
  };
}

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

type RunLeaseRow = LeaseRow & { runStatus: string | null };

/**
 * Owner of an active run lease. While the run is active, the run owns it.
 * Once the run is terminal, the release is owed by the process that holds the
 * lease (`metadata.leaseController`, stamped when the lease became active).
 * A lease saved before that stamp existed keeps, for one release, the run
 * fact alone on a single-host server (the settle still refuses a run this
 * boot owns); an ephemeral server cannot tell which host holds it, so it
 * names no owner and stays visible as an I1 gap.
 */
function runLeaseOwner(row: RunLeaseRow): RecordOwner {
  if (row.runStatus !== null && !TERMINAL_RUN_STATUSES.includes(row.runStatus)) return runOwner(row.heartbeatRunId);
  const holder = controllerStamp(json(row.metadata)[ENVIRONMENT_LEASE_CONTROLLER_KEY], "environment_run_lease_active");
  if (holder.kind !== "none") return holder;
  // The board confirmed that the server holding this unstamped lease stopped.
  if (json(row.metadata)[OWNER_GONE_ATTESTATION_KEY]) return { kind: "process", stamp: { kind: "local",
    scope: "environment_run_lease_active", generation: null, host: null, processSpace: OPERATOR_ATTESTED_PROCESS_SPACE,
    bootId: null, pid: null, processStartedAt: null, processGroupId: null } };
  return ephemeralServerEnabled() ? { kind: "none" } : runOwner(row.heartbeatRunId);
}

/** Shared path since Phase 2: replaces the "run terminal plus five minutes"
 * orphaned active lease sweep. */
function runLeaseKind(): OwnableKind {
  const where = and(eq(environmentLeases.status, "active"), isNotNull(environmentLeases.heartbeatRunId));
  const select = (db: Db) => db.select({ id: environmentLeases.id, companyId: environmentLeases.companyId,
    heartbeatRunId: environmentLeases.heartbeatRunId, issueId: environmentLeases.issueId,
    metadata: environmentLeases.metadata, updatedAt: environmentLeases.updatedAt, runStatus: heartbeatRuns.status })
    .from(environmentLeases).leftJoin(heartbeatRuns, eq(heartbeatRuns.id, environmentLeases.heartbeatRunId));
  const record = (row: RunLeaseRow): InProgressRecord => ({ recordId: row.id, companyId: row.companyId,
    runId: row.heartbeatRunId, issueId: row.issueId, owner: runLeaseOwner(row), updatedAt: row.updatedAt });
  return {
    id: "environment_run_lease_active", title: "Run lease (active)", obligation: "ownership", storage: "database",
    invariantChecks: [1, 2], settle: settleEnvironmentRunLease,
    onUnprovable: requestOwnerGoneConfirmation("environment_run_lease_active"),
    // Only an unstamped lease of a finished run: a stamped holder is judged by its stamp.
    attestOwnerGone: async (tx, target, proof) => {
      const attested = (await writeEnvironmentCleanup(tx, write => write.update(environmentLeases)
      .set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ [OWNER_GONE_ATTESTATION_KEY]: proof })}::jsonb` })
      .where(and(eq(environmentLeases.id, target.recordId), eq(environmentLeases.companyId, target.companyId),
        eq(environmentLeases.status, "active"), isNotNull(environmentLeases.heartbeatRunId),
        sql`not (coalesce(${environmentLeases.metadata}, '{}'::jsonb) ? ${ENVIRONMENT_LEASE_CONTROLLER_KEY})`,
        sql`exists (select 1 from heartbeat_runs run where run.id = ${environmentLeases.heartbeatRunId}
          and run.status in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'))`))
      .returning({ id: environmentLeases.id }), { companyId: target.companyId, leaseId: target.recordId })).length > 0;
      if (attested) return "attested";
      // Released by another path since the board was asked: nothing is left to attest.
      const [lease] = await tx.select({ status: environmentLeases.status }).from(environmentLeases)
        .where(and(eq(environmentLeases.id, target.recordId), eq(environmentLeases.companyId, target.companyId)));
      return !lease || lease.status !== "active" ? "released" : "changed";
    },
    listInProgress: async (db, limit, offset) => {
      const rows = await select(db).where(where).orderBy(asc(environmentLeases.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(record) };
    },
    listForRuns: async (db, runIds) => {
      const records: InProgressRecord[] = [];
      for (let index = 0; index < runIds.length; index += 500) {
        const rows = await select(db).where(and(where,
          inArray(environmentLeases.heartbeatRunId, [...runIds.slice(index, index + 500)])));
        records.push(...rows.map(record));
      }
      return records;
    },
  };
}

/**
 * Owner of an in-flight teardown claim. A claimant that stamps
 * `pendingCleanupController` for this exact attempt is a process, proved by
 * identity. Other claimants (workspace recovery, native export retry, and
 * claims saved by an earlier release) hold the claim as a fence: the attempt
 * id is the token and `pendingCleanupLeaseExpiresAtMs` is the deadline that
 * the claimant renews. An expired fence is never proof by itself; another
 * host takes over only through the fence. A controller stamp left by an
 * earlier attempt names a different claimant and is ignored.
 */
function teardownClaimOwner(row: LeaseRow): RecordOwner {
  const metadata = json(row.metadata);
  const attemptId = str(metadata.pendingCleanupAttemptId);
  const controller = json(metadata.pendingCleanupController);
  if (attemptId && controller.attemptId === attemptId) {
    const stamped = controllerStamp(controller, "environment_teardown_claim");
    if (stamped.kind !== "none") return stamped;
  }
  if (!attemptId) return { kind: "none" };
  const expiresAtMs = typeof metadata.pendingCleanupLeaseExpiresAtMs === "number" ? metadata.pendingCleanupLeaseExpiresAtMs : null;
  return {
    kind: "fence",
    stamp: { kind: "remote", scope: "environment_teardown_claim", generation: null, fenceToken: attemptId },
    fence: { currentFenceToken: attemptId, currentGeneration: null,
      leaseExpiresAt: expiresAtMs !== null && Number.isFinite(expiresAtMs) ? new Date(expiresAtMs) : null },
  };
}

/** A cleanup worker pass that misses a due item by more than this is a gap. */
const PENDING_CLEANUP_OVERDUE_GRACE_MS = 2 * ENVIRONMENT_CLEANUP_RETRY_MS;

/**
 * Pending-cleanup obligation (not in flight). An unclaimed queue item names no
 * process by design: the environment cleanup queue owns it, and its next
 * action is the queue's next attempt, due at the saved retry deadline (the
 * same deadline the cleanup worker sleeps until). While that deadline is
 * current the queue owns the item; once it is long past, the item is reported
 * as a gap (I7), never released. Invariant 1 then measures only real gaps.
 */
function pendingCleanupKind(): OwnableKind {
  const where = and(eq(environmentLeases.status, "pending_cleanup"),
    sql`coalesce(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') <> 'true'`);
  // The first attempt of a settled orphan is due at once: the worker's "run
  // now" deadline is 0, so its due time is when the settle queued it (saved
  // by the settle; a row from before that is due since its last write).
  // Built per listing: the deadline reader bounds saved deadlines relative to
  // the current time, so it must not be frozen at module load.
  const dueMs = () => sql<string>`case when ${recoveredOrphanFirstAttemptSql()}
      then coalesce(case when jsonb_typeof(${environmentLeases.metadata}->'pendingCleanupRecoveredAtMs') = 'number'
        then (${environmentLeases.metadata}->>'pendingCleanupRecoveredAtMs')::numeric end,
        extract(epoch from ${environmentLeases.updatedAt}) * 1000)
    else greatest(extract(epoch from ${environmentLeases.updatedAt}) * 1000 + ${ENVIRONMENT_CLEANUP_RETRY_MS},
      ${pendingCleanupDeadlineSql()}) end`;
  return {
    id: "environment_pending_cleanup", title: "Pending-cleanup obligation (not in flight)", obligation: "ownership",
    storage: "database", settle: null, invariantChecks: [1, 2, 7],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: environmentLeases.id, companyId: environmentLeases.companyId,
        heartbeatRunId: environmentLeases.heartbeatRunId, issueId: environmentLeases.issueId,
        updatedAt: environmentLeases.updatedAt, dueMs: dueMs() })
        .from(environmentLeases).where(where).orderBy(asc(environmentLeases.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: row.heartbeatRunId, issueId: row.issueId,
        owner: { kind: "queue", queue: "environment_cleanup", dueAt: new Date(Number(row.dueMs)),
          graceMs: PENDING_CLEANUP_OVERDUE_GRACE_MS },
        updatedAt: row.updatedAt,
      })) };
    },
  };
}

/** `ControllerProcess` metadata ({bootId, pid, hostHash, processStartedAt}). */
function controllerStamp(value: unknown, scope: string): RecordOwner {
  const controller = readControllerProcess(value);
  if (!controller) return { kind: "none" };
  return { kind: "process", stamp: {
    kind: "local", scope, generation: null, host: null, processSpace: controller.hostHash,
    bootId: controller.bootId, pid: controller.pid, processStartedAt: controller.processStartedAt, processGroupId: null,
    ...(controller.deployment ? { worker: controller.deployment.worker, exclusiveVolume: controller.deployment.exclusiveVolume,
      volumeId: controller.deployment.volumeId } : {}),
  } };
}

// ----------------------------------------------------------------------------
// workspace_operations

function remoteSnapshotSaveOwner(row: OperationRow): RecordOwner {
  const work = json(json(row.metadata).saveWork);
  const active = Array.isArray(work.activeIds) ? work.activeIds.filter((id): id is string => typeof id === "string") : [];
  if (!active.length) return runOwner(row.heartbeatRunId);
  const owners = json(work.owners);
  const stamps = active.map(id => readControllerProcess(owners[id]));
  if (stamps.every(stamp => stamp === null) && !active.some(id => owners[id] !== undefined)) return runOwner(row.heartbeatRunId);
  const [first] = stamps;
  if (!first || stamps.some(stamp => !stamp || stamp.bootId !== first.bootId || stamp.pid !== first.pid)) return { kind: "none" };
  if (first.bootId === currentControllerBootId() && first.pid === process.pid && !active.some(isRemoteWorkspaceSaveInvocationLive)) {
    return runOwner(row.heartbeatRunId);
  }
  return controllerStamp(owners[active[0]!], "remote_snapshot_save");
}

type OperationRow = Pick<typeof workspaceOperations.$inferSelect, "id" | "companyId" | "heartbeatRunId" | "issueId"
  | "metadata" | "updatedAt">;

function operationKind(id: string, title: string, obligation: Obligation, where: SQL | undefined,
  owner: (row: OperationRow) => RecordOwner): OwnableKind {
  return {
    id, title, obligation, storage: "database", settle: null, invariantChecks: [1, 2],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: workspaceOperations.id, companyId: workspaceOperations.companyId,
        heartbeatRunId: workspaceOperations.heartbeatRunId, issueId: workspaceOperations.issueId,
        metadata: workspaceOperations.metadata, updatedAt: workspaceOperations.updatedAt })
        .from(workspaceOperations).where(where).orderBy(asc(workspaceOperations.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: row.heartbeatRunId, issueId: row.issueId,
        owner: owner(row), updatedAt: row.updatedAt,
      })) };
    },
  };
}

// ----------------------------------------------------------------------------
// issue_recovery_actions

type RecoveryActionRow = Pick<typeof issueRecoveryActions.$inferSelect, "id" | "companyId" | "sourceIssueId"
  | "ownerType" | "evidence" | "updatedAt">;

function recoveryActionKind(id: string, title: string, obligation: Obligation, where: SQL | undefined,
  owner: (row: RecoveryActionRow) => RecordOwner, invariantChecks: readonly number[] = [1, 2, 7],
  runIdOf: (row: RecoveryActionRow) => string | null = () => null,
  options: { includeResolved?: boolean } = {}): OwnableKind {
  return {
    id, title, obligation, storage: "database", settle: null, invariantChecks,
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: issueRecoveryActions.id, companyId: issueRecoveryActions.companyId,
        sourceIssueId: issueRecoveryActions.sourceIssueId, ownerType: issueRecoveryActions.ownerType,
        evidence: issueRecoveryActions.evidence, updatedAt: issueRecoveryActions.updatedAt })
        .from(issueRecoveryActions).where(and(options.includeResolved ? undefined : isNull(issueRecoveryActions.resolvedAt), where))
        .orderBy(asc(issueRecoveryActions.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: runIdOf(row), issueId: row.sourceIssueId,
        owner: owner(row), updatedAt: row.updatedAt,
      })) };
    },
  };
}

// ----------------------------------------------------------------------------
// Local-disk spools

/** Spool files carry their company and run (`companyId` plus `runId` or
 * `heartbeatRunId`); a file that cannot be read keeps a null attribution. */
async function readSpoolAttribution(file: string): Promise<{ companyId: string | null; runId: string | null }> {
  try {
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const record = json(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
      return { companyId: str(record.companyId), runId: str(record.runId) ?? str(record.heartbeatRunId) };
    } finally {
      await handle.close();
    }
  } catch {
    return { companyId: null, runId: null };
  }
}

function spoolKind(id: string, title: string, obligation: Obligation, directory: () => string): OwnableKind {
  return {
    id, title, obligation, storage: "local_disk", settle: null, invariantChecks: [1, 2],
    listInProgress: async (_db, limit, offset) => {
      let names: string[];
      const root = directory();
      try {
        names = (await fs.readdir(root)).filter(name => name.endsWith(".json")).sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], truncated: false };
        throw error;
      }
      const result = page(names.slice(offset), limit);
      const records: InProgressRecord[] = [];
      for (const name of result.rows) {
        const attribution = await readSpoolAttribution(path.join(root, name));
        records.push({ recordId: path.basename(name, ".json"), companyId: attribution.companyId,
          runId: attribution.runId, issueId: null, owner: { kind: "none" }, updatedAt: null });
      }
      return { truncated: result.truncated, records };
    },
  };
}

// ----------------------------------------------------------------------------
// execution_workspace_runtime_leases

/** The lease's owner key names its owner: an issue or run is proven by
 * identity; an agent-scoped (or unparseable) owner is a fence on the lease
 * expiry that only a claim's locked takeover moves. */
function runtimeLeaseOwner(row: typeof executionWorkspaceRuntimeLeases.$inferSelect): RecordOwner {
  const owner = parseWorkspaceRuntimeLeaseOwnerKey(row.ownerKey);
  if (owner?.kind === "issue") return { kind: "issue", issueId: owner.id };
  if (owner?.kind === "run") return { kind: "run", runId: owner.id };
  return { kind: "fence", stamp: { kind: "remote", scope: "execution_workspace_runtime_lease", generation: null,
    fenceToken: row.ownerKey }, fence: { currentFenceToken: row.ownerKey, currentGeneration: null,
    leaseExpiresAt: row.expiresAt } };
}

// ----------------------------------------------------------------------------
// The registry

// ----------------------------------------------------------------------------
// agents.lifecycle_operation

/** A live lifecycle lease (for example harness verification) and its holder. */
const agentLifecycleLeaseHeld = and(
  sql`${agents.lifecycleOperation} ? 'leaseOwner'`, sql`${agents.lifecycleOperation} ? 'leaseHolder'`,
  sql`(${agents.lifecycleOperation}->>'leaseUntil')::timestamptz > now()`);

const agentLifecycleLeaseKind: OwnableKind = {
  // Shared path: a restart that kills the holder must not leave the agent's
  // lifecycle step, and its queued runs, waiting out the lease.
  id: "agent_lifecycle_lease", title: "Agent lifecycle step lease (harness verification and setup)", obligation: "ownership",
  storage: "database", invariantChecks: [1, 2], settle: settleAgentLifecycleLease,
  listInProgress: async (db, limit, offset) => {
    const rows = await db.select({ id: agents.id, companyId: agents.companyId, operation: agents.lifecycleOperation,
      updatedAt: agents.updatedAt }).from(agents).where(agentLifecycleLeaseHeld)
      .orderBy(asc(agents.id)).limit(limit + 1).offset(offset);
    const result = page(rows, limit);
    return { truncated: result.truncated, records: result.rows.map(row => ({
      recordId: row.id, companyId: row.companyId, runId: null, issueId: null,
      owner: controllerStamp(row.operation?.leaseHolder, "agent_lifecycle_lease"), updatedAt: row.updatedAt,
    })) };
  },
};

const acceptedNativeResultLease = nrfKind("native_accepted_result_lease", "Accepted-result executor lease", "accepted_result",
  and(isNotNull(nativeRunFinalizations.resultId), notInArray(nativeRunFinalizations.phase, TERMINAL_PHASES),
    isNotNull(nativeRunFinalizations.leaseOwner), notFinalizerOrCleanup,
    sql`${nativeRunFinalizations.leaseExpiresAt} > now()`));

export const OWNABLE_KINDS: readonly OwnableKind[] = [
  // Native runtime and Runner
  nrfKind("native_executor_claim", "Executor execution claim (fresh run)", "ownership",
    and(eq(nativeRunFinalizations.phase, "observed"), isNull(nativeRunFinalizations.resultId),
      isNotNull(nativeRunFinalizations.leaseOwner), notFinalizerOrCleanup, isNull(nativeRunFinalizations.recoveryState))),
  nrfKind("native_restart_recovery_claim", "Restart-recovery claim", "ownership",
    inArray(nativeRunFinalizations.recoveryState, ["awaiting_runner_reattach", "resuming_session", "bootstrap_incomplete"])),
  nrfKind("native_awaiting_evidence", "\"Awaiting evidence\" wait", "ownership",
    eq(nativeRunFinalizations.recoveryState, "awaiting_evidence"), undefined, [1, 2, 7]),
  {
    // Shared path since Phase 2: a hard kill after `run.result` is accepted
    // leaves the result leased to the dead controller; settle expires that
    // exact lease so finalization runs now (RC-41).
    // Outstanding leases only: an expired lease no longer holds the result,
    // so it is not in progress for this kind (finalization reclaims it).
    ...acceptedNativeResultLease,
    listInProgress: async (db, limit, offset) => {
      const listed = await acceptedNativeResultLease.listInProgress!(db, limit, offset);
      return { ...listed, records: await classifyNativeAcceptedResultLeaseOwners(db, listed.records) };
    },
    listForRuns: async (db, runIds) => classifyNativeAcceptedResultLeaseOwners(db,
      await acceptedNativeResultLease.listForRuns!(db, runIds)),
    settle: settleNativeAcceptedResultLease,
    onUnprovable: requestNativeAcceptedResultLeaseOperatorAction,
  },
  // Shared path since Phase 2: the token-only finalizer and cleanup leases
  // record their holder process (`lease_holder`, bound to the token); settle
  // expires the exact lease of a holder proven gone, so finalization or
  // cleanup runs now instead of after the TTL. Outstanding leases only: an
  // expired one is free for the next claim. A holder on another host or PID
  // space is unprovable and keeps its lease until expiry, when the next claim
  // takes it over and the old holder's token compare-and-swap fails: that
  // fence is the handoff, never a host difference.
  ownerGoneAttestable({
    ...nrfKind("native_finalizer_lease", "Finalizer lease", "accepted_result",
      and(like(nativeRunFinalizations.leaseOwner, "native-finalizer:%"), notInArray(nativeRunFinalizations.phase, TERMINAL_PHASES),
        sql`${nativeRunFinalizations.leaseExpiresAt} > now()`),
      row => nrfTokenLeaseOwner(row, "native_finalizer_lease")),
    settle: (db, record, context) => settleNativeTokenLease("native_finalizer_lease", db, record, context),

  }, nrfVersionLock),
  ownerGoneAttestable({
    ...nrfKind("native_cleanup_lease", "Cleanup lease", "workspace_preservation",
      and(like(nativeRunFinalizations.leaseOwner, "native-cleanup:%"), sql`${nativeRunFinalizations.leaseExpiresAt} > now()`),
      row => nrfTokenLeaseOwner(row, "native_cleanup_lease")),
    settle: (db, record, context) => settleNativeTokenLease("native_cleanup_lease", db, record, context),

  }, nrfVersionLock),
  runKind("native_ownership_unverified_hold", "Ownership-unverified hold", "ownership",
    and(eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"), or(
      and(eq(heartbeatRuns.errorCode, NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE), eq(heartbeatRuns.nativePhase, "terminal_failure")),
      eq(heartbeatRuns.errorCode, NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT))),
    () => ({ kind: "none" }), [1, 2, 7]),
  {
    id: "native_startup_context", title: "Native startup context", obligation: "ownership", storage: "database",
    settle: null, invariantChecks: [1, 2],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ ...runColumns, leaseOwner: nativeRunFinalizations.leaseOwner,
        leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt, generation: nativeRunFinalizations.controllerGeneration })
        .from(heartbeatRuns).leftJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id),
          eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId)))
        .where(and(eq(heartbeatRuns.status, "running"), sql`${heartbeatRuns.runnerProfileJson} ? 'nativeStartupContext'`))
        .orderBy(asc(heartbeatRuns.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => {
        const context = json(json(row.runnerProfileJson).nativeStartupContext);
        const token = str(context.leaseOwner);
        return {
          recordId: row.id, companyId: row.companyId, runId: row.id, issueId: row.issueId, updatedAt: row.updatedAt,
          owner: token ? {
            kind: "fence",
            stamp: { kind: "remote", scope: "native_startup_context", generation: int(context.generation), fenceToken: token },
            fence: { currentFenceToken: row.leaseOwner ?? null, currentGeneration: row.generation ?? null,
              leaseExpiresAt: row.leaseExpiresAt ?? null },
          } : { kind: "none" },
        };
      }) };
    },
  },
  runKind("native_pending_workspace_export", "Pending workspace export (sync reference)", "workspace_preservation",
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'state' = 'prepared'`,
    row => runOwner(row.id), [1, 2, 7]),
  {
    id: "runtime_skill_cache_lock", title: "Runtime skill cache publication lock", obligation: "ownership",
    storage: "local_disk", settle: null, invariantChecks: [2, 7, 8], listInProgress: null,
    coverageGap: "Lock files live in per-skill cache roots under each managed skill directory; Phase 1 does not walk them.",
  },
  {
    id: "native_harness_backup", title: "Native harness backup publication", obligation: "workspace_preservation",
    storage: "database", settle: null, invariantChecks: [1, 2],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.status, "pending")).orderBy(asc(nativeHarnessBackups.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: row.runId, issueId: row.issueId,
        owner: runOwner(row.runId), updatedAt: row.updatedAt,
      })) };
    },
  },
  {
    id: "native_provider_artifact_upload", title: "Provider artifact upload", obligation: "workspace_preservation",
    storage: "database", settle: null, invariantChecks: [1, 2],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: nativeProviderArtifacts.id, companyId: nativeProviderArtifacts.companyId,
        updatedAt: nativeProviderArtifacts.updatedAt }).from(nativeProviderArtifacts)
        .where(inArray(nativeProviderArtifacts.status, ["pending", "retiring"])).orderBy(asc(nativeProviderArtifacts.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: null, issueId: null,
        owner: { kind: "none" }, updatedAt: row.updatedAt,
      })) };
    },
  },

  // Environments and sandboxes
  ownerGoneAttestable({
    // Shared path since Phase 2: a creator proven gone makes its intent due
    // now; creation recovery then reconciles it with the provider. An intent
    // whose creator is already marked lost belongs to that recovery deadline.
    id: "sandbox_creation_intent", title: "Sandbox creation intent", obligation: "ownership", storage: "database",
    settle: settleSandboxCreationIntent, invariantChecks: [1, 2, 3, 7],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: sandboxCreationOperations.id, companyId: sandboxCreationOperations.companyId,
        runId: sandboxCreationOperations.runId, issueId: sandboxCreationOperations.issueId,
        metadata: sandboxCreationOperations.metadata, updatedAt: sandboxCreationOperations.updatedAt })
        .from(sandboxCreationOperations).where(and(eq(sandboxCreationOperations.state, "pending"),
          sql`coalesce(${sandboxCreationOperations.metadata}->>'creationControllerLost', '') <> 'true'`))
        .orderBy(asc(sandboxCreationOperations.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: row.runId, issueId: row.issueId,
        owner: controllerStamp(json(row.metadata).creationController, "sandbox_creation_intent"), updatedAt: row.updatedAt,
      })) };
    },
  }, versionLock(sandboxCreationOperations)),
  runLeaseKind(),
  ownerGoneAttestable({
    // Shared path since Phase 2: a claimant proven gone ends its fence now.
    ...leaseKind("environment_teardown_claim", "Teardown claim (in-flight cleanup)", "ownership",
      // Text compare: a malformed flag never makes the whole listing fail.
      and(eq(environmentLeases.status, "pending_cleanup"),
        sql`coalesce(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') = 'true'`),
      teardownClaimOwner),
    settle: settleEnvironmentTeardownClaim,

  }, versionLock(environmentLeases)),
  pendingCleanupKind(),
  leaseKind("environment_stop_and_retain_intent", "Stop-and-retain intent", "workspace_preservation",
    and(eq(environmentLeases.status, "pending_cleanup"), sql`${environmentLeases.metadata} ? 'sandboxStopAndRetain'`),
    row => runOwner(row.heartbeatRunId)),
  leaseKind("environment_native_export_resume", "Native export resume (stop-only)", "workspace_preservation",
    and(eq(environmentLeases.status, "pending_cleanup"), sql`${environmentLeases.metadata} ? 'nativeWorkspaceExportResume'`),
    row => runOwner(row.heartbeatRunId)),
  leaseKind("environment_retained_hold", "Retained / reusable hold", "workspace_preservation",
    eq(environmentLeases.status, "retained"), () => ({ kind: "none" }), [1, 7]),
  {
    // Shared path since Phase 2: a sandbox the orphaned-run-lease settle
    // stopped and kept is destroyed once nothing references it. Only
    // releasable orphans are listed, so a held one is never polled; its
    // retention window end is a due time.
    ...leaseKind("environment_retained_orphan_sandbox", "Retained orphan sandbox", "workspace_preservation",
      releasableRetainedOrphanCondition(), row => runOwner(row.heartbeatRunId), [1]),
    settle: settleRetainedOrphanSandbox,
    nextDueAt: nextRetainedOrphanDueAt,
  },
  spoolKind("sandbox_orphan_cleanup_spool", "Orphan cleanup buffer/spool", "ownership", idleOrphanSpoolPath),
  {
    ...leaseKind("environment_login_probe_lease", "Login/probe lease", "ownership",
      and(eq(environmentLeases.status, "active"), isNull(environmentLeases.heartbeatRunId)),
      row => controllerStamp(json(row.metadata)[ENVIRONMENT_LEASE_CONTROLLER_KEY], "environment_login_probe_lease")),
    settle: settleEnvironmentLoginProbeLease,
  },

  // Workspaces
  ownerGoneAttestable({
    // Shared path since Phase 2: the owner stamp names the server process and,
    // since this kind moved, its boot id and start time, so a dead or reused
    // PID is proof. Another host or a stamp without a PID space stays
    // unprovable; the pre-control sweep's heartbeat lease is its fenced takeover.
    ...operationKind("workspace_runtime_control_operation", "Managed runtime-control operation", "ownership",
      and(eq(workspaceOperations.status, "running"), sql`${workspaceOperations.metadata} ? 'runtimeControlOwner'`),
      row => {
        const stamp = runtimeControlOperationOwnerStamp(row.metadata);
        return stamp ? { kind: "process", stamp } : { kind: "none" };
      }),
    settle: settleRuntimeControlOperation,

  }, versionLock(workspaceOperations)),
  ownerGoneAttestable({
    // Shared path since Phase 2: a finalize attempt whose process died (a
    // restart between start and copyback, or between copyback and done) is
    // settled so it cannot stay `running` forever (crash points
    // workspace.finalize.after_start_before_copyback / after_copyback_before_done).
    ...operationKind("native_workspace_finalize_attempt", "Native workspace finalize attempt (copyback export)", "workspace_preservation",
      and(eq(workspaceOperations.phase, "workspace_finalize"), inArray(workspaceOperations.status, ["running", "pending"])),
      // Rows written before `finalizeOwner` existed are owned by their run.
      row => json(row.metadata).finalizeOwner ? controllerStamp(json(row.metadata).finalizeOwner, "native_workspace_finalize_attempt")
        : runOwner(row.heartbeatRunId)),
    settle: settleAbandonedWorkspaceFinalizeAttempt,

  }, versionLock(workspaceOperations)),
  ownerGoneAttestable({
    ...operationKind("workspace_command_operation", "Local workspace command (provision, prepare, teardown)", "ownership",
      and(inArray(workspaceOperations.phase, [...LOCAL_WORKSPACE_COMMAND_PHASES]), eq(workspaceOperations.status, "running"),
        sql`not (${workspaceOperations.metadata} ? 'runtimeControlOwner')`),
      row => json(row.metadata).commandOwner ? controllerStamp(json(row.metadata).commandOwner, "workspace_command_operation")
        : runOwner(row.heartbeatRunId)),
    settle: settleAbandonedWorkspaceCommandOperation,
  }, versionLock(workspaceOperations)),
  operationKind("remote_provision_command", "Remote provision command intent", "workspace_preservation",
    and(eq(workspaceOperations.phase, "remote_workspace_provision"), or(eq(workspaceOperations.status, "running"),
      sql`(${workspaceOperations.metadata}->>'uncertain')::boolean is true`)),
    row => runOwner(row.heartbeatRunId)),
  { ...operationKind("remote_snapshot_save", "Remote snapshot save", "workspace_preservation",
    and(eq(workspaceOperations.phase, "remote_workspace_snapshot"), inArray(workspaceOperations.status, ["running", "pending"])),
    remoteSnapshotSaveOwner), settle: settleAbandonedRemoteSnapshotSave },
  operationKind("remote_workspace_migration", "Remote workspace migration op", "workspace_preservation",
    and(eq(workspaceOperations.phase, "remote_workspace_migration"), eq(workspaceOperations.status, "running")),
    () => ({ kind: "none" })),
  {
    // Shared path since Phase 2: a lease whose issue or run owner is proven
    // gone (by identity, never age) is released here and at the next claim.
    // An agent-scoped owner is a fence on `expires_at`: alive while held,
    // unprovable after; only the next claim's locked takeover moves it.
    id: "execution_workspace_runtime_lease", title: "Execution workspace runtime lease", obligation: "ownership",
    storage: "database", settle: settleExecutionWorkspaceRuntimeLease, invariantChecks: [1, 2],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select().from(executionWorkspaceRuntimeLeases).orderBy(asc(executionWorkspaceRuntimeLeases.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: row.ownerRunId, issueId: row.ownerIssueId,
        owner: runtimeLeaseOwner(row), updatedAt: row.updatedAt,
      })) };
    },
  },
  {
    id: "workspace_runtime_service", title: "Workspace runtime service (local process)", obligation: "ownership",
    storage: "database", settle: null, invariantChecks: [1, 2],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: workspaceRuntimeServices.id, companyId: workspaceRuntimeServices.companyId,
        issueId: workspaceRuntimeServices.issueId, updatedAt: workspaceRuntimeServices.updatedAt })
        .from(workspaceRuntimeServices)
        .where(inArray(workspaceRuntimeServices.status, ["provisioning", "starting", "running"])).orderBy(asc(workspaceRuntimeServices.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      // The PID lives in a local service registry file, not on the row.
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: null, issueId: row.issueId,
        owner: { kind: "none" }, updatedAt: row.updatedAt,
      })) };
    },
  },
  {
    id: "remote_workspace_unsaved_files", title: "Remote workspace unsaved-files flag", obligation: "workspace_preservation",
    storage: "database", settle: settlePreparationOnlyRemoteWorkspaceEpoch, invariantChecks: [1, 2],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: executionWorkspaces.id, companyId: executionWorkspaces.companyId,
        metadata: executionWorkspaces.metadata, updatedAt: executionWorkspaces.updatedAt }).from(executionWorkspaces)
        .where(sql`(${executionWorkspaces.metadata}->'remoteWorkspace'->>'dirty')::boolean is true`).orderBy(asc(executionWorkspaces.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => {
        const writerRunId = str(json(json(row.metadata).remoteWorkspace).writerRunId);
        return { recordId: row.id, companyId: row.companyId, runId: writerRunId, issueId: null,
          owner: runOwner(writerRunId), updatedAt: row.updatedAt };
      }) };
    },
  },
  {
    id: "remote_snapshot_ledger", title: "Remote snapshot ledger", obligation: "workspace_preservation",
    storage: "database", settle: settleAbandonedRemoteSnapshotLedger, invariantChecks: [2],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: executionWorkspaceSnapshots.id, companyId: executionWorkspaceSnapshots.companyId,
        sourceRunId: executionWorkspaceSnapshots.sourceRunId, updatedAt: executionWorkspaceSnapshots.updatedAt })
        .from(executionWorkspaceSnapshots).where(inArray(executionWorkspaceSnapshots.status, ["pending", "uploaded"])).orderBy(asc(executionWorkspaceSnapshots.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: row.sourceRunId, issueId: null,
        owner: runOwner(row.sourceRunId), updatedAt: row.updatedAt,
      })) };
    },
  },
  {
    id: "git_restore_point", title: "Git restore point", obligation: "workspace_preservation",
    storage: "database", settle: null, invariantChecks: [1, 2],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: executionWorkspaceRestorePoints.id, companyId: executionWorkspaceRestorePoints.companyId,
        issueId: executionWorkspaceRestorePoints.sourceIssueId, updatedAt: executionWorkspaceRestorePoints.updatedAt })
        .from(executionWorkspaceRestorePoints)
        .where(inArray(executionWorkspaceRestorePoints.status, ["pending", "expiring"])).orderBy(asc(executionWorkspaceRestorePoints.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: null, issueId: row.issueId,
        owner: { kind: "none" }, updatedAt: row.updatedAt,
      })) };
    },
  },
  {
    id: "git_cache_expiration_intent", title: "Git cache expiration intent", obligation: "workspace_preservation",
    storage: "database", settle: null, invariantChecks: [1],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: executionWorkspaces.id, companyId: executionWorkspaces.companyId,
        updatedAt: executionWorkspaces.updatedAt }).from(executionWorkspaces)
        .where(sql`${executionWorkspaces.metadata}->'gitCacheExpiration' is not null
          and coalesce((${executionWorkspaces.metadata}->'gitCacheExpiration'->>'completed')::boolean, false) is false`)
        .orderBy(asc(executionWorkspaces.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: null, issueId: null,
        owner: { kind: "none" }, updatedAt: row.updatedAt,
      })) };
    },
  },
  {
    ...leaseKind("legacy_shutdown_settlement_fence", "Legacy graceful-shutdown workspace settlement fence", "workspace_preservation",
      sql`${environmentLeases.metadata}->'legacyShutdownWorkspaceSettlement'->>'state' = 'pending'`,
      row => legacyShutdownSettlementOwner(row.metadata), [2]),
    settle: settleLegacyShutdownSettlementFence,
  },
  leaseKind("legacy_restore_recovery_hold", "Legacy restore-recovery preservation hold", "workspace_preservation",
    and(eq(environmentLeases.leasePolicy, "retain_on_failure"), sql`${environmentLeases.metadata} ? 'workspaceRestoreRecovery'`,
      notInArray(environmentLeases.status, ["released", "expired", "failed"])),
    row => runOwner(row.heartbeatRunId), [2, 7]),
  recoveryActionKind("system_recovery_attempt", "System recovery attempt for retained work", "workspace_preservation",
    sql`${issueRecoveryActions.evidence}->'systemRecovery'->>'state' in ('scheduled', 'running', 'awaiting_evidence')`,
    () => ({ kind: "none" })),
  {
    ...recoveryActionKind("copyback_owner_hold", "Copyback-owner hold (RC-50)", "ownership",
      sql`${issueRecoveryActions.evidence}->'workspaceOwnerRecovery'->>'state' = 'operator_required'`,
      row => copybackOwnerHoldOwner(row.evidence)),
    settle: settleCopybackOwnerHold,
  },
  {
    ...recoveryActionKind("observed_workspace_preservation_fence", "Observed-run workspace preservation fence", "workspace_preservation",
      sql`${issueRecoveryActions.evidence}->'observedWorkspacePreservation'->>'state' = 'stop_pending'`,
      row => observedWorkspaceFenceOwner(row.evidence), [1, 2, 7],
      row => str(json(json(row.evidence).observedWorkspacePreservation).runId), { includeResolved: true }),
    settle: settleObservedWorkspaceFence,
  },

  // Accounting and budgets
  runKind("run_accounting_debt", "Run accounting debt", "accounting",
    and(eq(heartbeatRuns.costAccountingPending, true),
      inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out", "interrupted"])),
    () => ({ kind: "none" }), [2, 3]),
  spoolKind("usage_receipt_spool", "Usage-receipt spool file (durable file)", "accounting", idleAccountingSpoolPath),

  // Wake queue and recovery
  {
    id: "wake_request_claimed", title: "Wake request (claimed)", obligation: "ownership", storage: "database",
    // Shared path since Phase 2: a claim whose run finished is settled with
    // that run's outcome, so a path that ends a run without it cannot strand it.
    settle: settleClaimedWakeRequest, invariantChecks: [2, 4],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId,
        runId: agentWakeupRequests.runId, updatedAt: agentWakeupRequests.updatedAt }).from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "claimed")).orderBy(asc(agentWakeupRequests.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: row.runId, issueId: null,
        owner: runOwner(row.runId), updatedAt: row.updatedAt,
      })) };
    },
  },
  ownerGoneAttestable({
    // Shared path since Phase 2: the claim records its controller process
    // (`controller_process`, bound to the boot id); settle expires the lease of
    // a controller proven gone, and live-run recovery settles the run now
    // instead of after lease expiry plus the age guard. Outstanding leases
    // only. Rows saved before that column, and revoked leases, stay boot-id
    // fences: alive while leased, then handled by the existing revocation.
    ...runKind("legacy_controller_lease", "Legacy controller lease", "ownership", legacyControllerLeaseWhere,
      legacyControllerLeaseOwner),
    listForRuns: async (db, runIds) => {
      const records: InProgressRecord[] = [];
      for (let index = 0; index < runIds.length; index += 500) {
        const rows = await db.select(runColumns).from(heartbeatRuns)
          .where(and(legacyControllerLeaseWhere, inArray(heartbeatRuns.id, [...runIds.slice(index, index + 500)])));
        records.push(...(rows as RunRow[]).map(row => ({ recordId: row.id, companyId: row.companyId, runId: row.id,
          issueId: row.issueId, owner: legacyControllerLeaseOwner(row), updatedAt: row.updatedAt })));
      }
      return records;
    },
    settle: settleLegacyControllerLease,
  }, versionLock(heartbeatRuns)),
  {
    // A preparation a shutdown interrupted, held before its no-provider-work
    // proof could exist. Its owner is the recorded controller process: the
    // shared prover must prove it gone (a missing stamp, or one from another
    // host or PID space, is unprovable and stays held). The settle re-checks
    // the durable proof and replays the preparation exactly once.
    // Keep this entry after the environment teardown kinds: a lease they settle
    // in a pass is released before this kind lists in that same pass.
    ...runKind("legacy_interrupted_preparation_hold", "Interrupted preparation held for replay", "ownership",
      heldInterruptedPreparationWhere(), row => {
        const stamp = legacyControllerOwnerStamp(row);
        return stamp ? { kind: "process", stamp } : { kind: "none" };
      }),
    settle: settleHeldInterruptedPreparation,
  },
  {
    // No-replay holds of a run that completed its turn and was then refused by
    // the in-process cleanup gate. Its owner is the controller that closed the
    // session (the coordinator's stamp); once that process is proven gone, so
    // is its gate, and the holds settle without replaying anything.
    ...nrfKind("native_completed_turn_cleanup_hold", "Completed-turn cleanup hold", "ownership",
      completedTurnCleanupHoldWhere()),
    settle: settleCompletedTurnCleanupHolds,
  },
  runKind("detached_process_marker", "Detached-process marker", "ownership",
    and(eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.errorCode, "process_detached")),
    row => row.processPid ? { kind: "process", stamp: runProcessStamp(row, "detached_process_marker") } : { kind: "none" },
    [2, 7]),
  runKind("hot_restart_adoption_marker", "Hot-restart adoption marker", "ownership",
    and(eq(heartbeatRuns.status, "running"), sql`${heartbeatRuns.resultJson} ? 'hotRestartAdoption'`),
    row => row.processPid ? { kind: "process", stamp: runProcessStamp(row, "hot_restart_adoption_marker") } : { kind: "none" },
    [2]),
  {
    id: "issue_execution_lock", title: "Issue execution lock", obligation: "ownership", storage: "database",
    settle: settleIssueLock, invariantChecks: [2, 3, 7],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: issues.id, companyId: issues.companyId, runId: issues.executionRunId,
        updatedAt: issues.updatedAt }).from(issues).where(isNotNull(issues.executionRunId)).orderBy(asc(issues.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: row.runId, issueId: row.id,
        owner: runOwner(row.runId), updatedAt: row.updatedAt,
      })) };
    },
  },
  {
    id: "issue_checkout_lock", title: "Issue checkout lock", obligation: "ownership", storage: "database",
    settle: settleIssueLock, invariantChecks: [2, 7],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: issues.id, companyId: issues.companyId, runId: issues.checkoutRunId,
        updatedAt: issues.updatedAt }).from(issues).where(isNotNull(issues.checkoutRunId)).orderBy(asc(issues.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: row.runId, issueId: row.id,
        owner: runOwner(row.runId), updatedAt: row.updatedAt,
      })) };
    },
  },
  recoveryActionKind("execution_reconciliation_hold", "Execution reconciliation hold", "ownership",
    and(inArray(issueRecoveryActions.status, ["active", "escalated"]),
      inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES])),
    row => ({ kind: "operator", ownerType: row.ownerType }), [3, 7]),
  // Work-intent outbox (section E). Each pending intent is owned by the event
  // that releases it: a hold-release trigger, run dispatch, or its retry due
  // time. The I4 check reports a deferred intent left after its hold cleared,
  // and the reconciliation worker promotes it as a backstop.
  {
    id: "wake_request_deferred", title: "Wake request (deferred)", obligation: "ownership", storage: "database",
    settle: null, invariantChecks: [4],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId,
        issueId: sql<string | null>`${agentWakeupRequests.payload}->>'issueId'`,
        trigger: sql<string | null>`${agentWakeupRequests.payload}->'executionWait'->>'trigger'`,
        updatedAt: agentWakeupRequests.updatedAt }).from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "deferred_issue_execution")).orderBy(asc(agentWakeupRequests.id))
        .limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: null, issueId: row.issueId,
        owner: { kind: "operator" as const, ownerType: `hold_release:${row.trigger ?? "issue_execution"}` }, updatedAt: row.updatedAt,
      })) };
    },
  },
  runKind("queued_run", "Queued run", "ownership", eq(heartbeatRuns.status, "queued"),
    () => ({ kind: "operator", ownerType: "run_dispatch" }), [4]),
  runKind("scheduled_retry_run", "Scheduled retry run", "ownership", eq(heartbeatRuns.status, "scheduled_retry"),
    () => ({ kind: "operator", ownerType: "retry_schedule" }), [4]),
  agentLifecycleLeaseKind,
];

/** Resolve the current holder of fences that live on another row (the
 * native coordinator), so a fence stamp is judged against current truth. */
export async function resolveFenceHolders(db: Db, records: InProgressRecord[]): Promise<void> {
  const pending = records.filter(record => record.owner.kind === "fence" && record.runId &&
    record.owner.fence.currentFenceToken === null && record.owner.fence.currentGeneration === null);
  if (pending.length === 0) return;
  const runIds = [...new Set(pending.map(record => record.runId!))];
  const holders = await db.select({ runId: nativeRunFinalizations.runId, leaseOwner: nativeRunFinalizations.leaseOwner,
    generation: nativeRunFinalizations.controllerGeneration, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt })
    .from(nativeRunFinalizations).where(inArray(nativeRunFinalizations.runId, runIds));
  const byRun = new Map(holders.map(holder => [holder.runId, holder]));
  for (const record of pending) {
    if (record.owner.kind !== "fence") continue;
    const holder = byRun.get(record.runId!);
    record.owner.fence = { currentFenceToken: holder?.leaseOwner ?? null,
      currentGeneration: holder?.generation ?? null, leaseExpiresAt: holder?.leaseExpiresAt ?? null };
  }
  await applyObservedFenceProviderProof(db, pending);
}
