import { promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull, isNull, like, notInArray, notLike, or, sql, type SQL } from "drizzle-orm";
import {
  agentWakeupRequests,
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
import { readControllerProcess } from "../controller-process-identity.js";
import { idleAccountingSpoolPath, idleOrphanSpoolPath } from "../idle-local-work.js";
import {
  NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT,
  NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
} from "../native-runtime/native-runner-ownership.js";
import type { LocalOwnerStamp, RemoteFenceState, RemoteOwnerStamp } from "../owner-proof.js";

/**
 * Registry of ownable record kinds (plan section C).
 *
 * Each kind lists its in-progress records and says who owns each one. Phase 1
 * is report-only: no kind registers a `settle`, so the reconciler classifies
 * owners and runs invariant checks but never changes a record. Phase 2 adds a
 * compare-and-swap `settle` per kind, one PR at a time, and deletes the kind's
 * bespoke release path.
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
  /** A person or agent assignment, such as an operator-owned recovery action. */
  | { kind: "operator"; ownerType: string | null }
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

export type OwnableKind = {
  id: string;
  title: string;
  obligation: Obligation;
  storage: "database" | "local_disk";
  /** Null when Phase 1 cannot enumerate the kind; the report names the gap. */
  /** Lists one page in a stable order; the report pages through the kind
   * within one pass. */
  listInProgress: ((db: Db, limit: number, offset: number) => Promise<ListResult>) | null;
  /** Report-only in Phase 1. Phase 2 registers a compare-and-swap settle. */
  settle: null;
  /** Plan invariants this kind is checked against (1–8). */
  invariantChecks: readonly number[];
  /** Why the kind cannot be listed, when `listInProgress` is null. */
  coverageGap?: string;
};

const TERMINAL_PHASES = ["committed", "terminal_failure", "applied"];

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

// ----------------------------------------------------------------------------
// native_run_finalizations

type NrfRow = typeof nativeRunFinalizations.$inferSelect;

/** NRF records the controller's boot, PID, start time and, since #19868, its
 * PID space (`controller_host_hash`). Rows written before that have no space
 * and stay unprovable for a foreign boot (inventory finding 2). */
function nrfStamp(row: NrfRow, scope: string): LocalOwnerStamp {
  return {
    kind: "local", scope, generation: row.controllerGeneration ?? null, host: null,
    processSpace: row.controllerHostHash ?? null,
    bootId: row.controllerBootId, pid: row.controllerPid,
    processStartedAt: row.controllerProcessStartedAt?.toISOString() ?? null, processGroupId: null,
  };
}

function nrfKind(id: string, title: string, obligation: Obligation, where: SQL | undefined,
  owner: (row: NrfRow) => RecordOwner = row => ({ kind: "process", stamp: nrfStamp(row, id) }),
  invariantChecks: readonly number[] = [1, 2]): OwnableKind {
  return {
    id, title, obligation, storage: "database", settle: null, invariantChecks,
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select().from(nativeRunFinalizations).where(where).orderBy(asc(nativeRunFinalizations.runId)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.runId, companyId: row.companyId, runId: row.runId, issueId: row.issueId,
        owner: owner(row), updatedAt: row.updatedAt,
      })) };
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

// ----------------------------------------------------------------------------
// heartbeat_runs

type RunRow = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "issueId" | "status" | "controllerBootId"
  | "controllerLeaseExpiresAt" | "processPid" | "processGroupId" | "processStartedAt" | "processHostHash" | "updatedAt"
  | "runnerProfileJson">;

const runColumns = {
  id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, issueId: heartbeatRuns.issueId, status: heartbeatRuns.status,
  controllerBootId: heartbeatRuns.controllerBootId, controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
  processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
  processStartedAt: heartbeatRuns.processStartedAt, processHostHash: heartbeatRuns.processHostHash,
  updatedAt: heartbeatRuns.updatedAt,
  runnerProfileJson: heartbeatRuns.runnerProfileJson,
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

/** heartbeat_runs records the adapter child's PID, start time and, since
 * #19871, its PID space (`process_host_hash`). Older rows have no space and
 * stay unprovable. */
function runProcessStamp(row: RunRow, scope: string): LocalOwnerStamp {
  return {
    kind: "local", scope, generation: null, host: null, processSpace: row.processHostHash ?? null, bootId: null,
    pid: row.processPid, processStartedAt: row.processStartedAt?.toISOString() ?? null,
    processGroupId: row.processGroupId,
  };
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

/** `ControllerProcess` metadata ({bootId, pid, hostHash, processStartedAt}). */
function controllerStamp(value: unknown, scope: string): RecordOwner {
  const controller = readControllerProcess(value);
  if (!controller) return { kind: "none" };
  return { kind: "process", stamp: {
    kind: "local", scope, generation: null, host: null, processSpace: controller.hostHash,
    bootId: controller.bootId, pid: controller.pid, processStartedAt: controller.processStartedAt, processGroupId: null,
  } };
}

// ----------------------------------------------------------------------------
// workspace_operations

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
  runIdOf: (row: RecoveryActionRow) => string | null = () => null): OwnableKind {
  return {
    id, title, obligation, storage: "database", settle: null, invariantChecks,
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: issueRecoveryActions.id, companyId: issueRecoveryActions.companyId,
        sourceIssueId: issueRecoveryActions.sourceIssueId, ownerType: issueRecoveryActions.ownerType,
        evidence: issueRecoveryActions.evidence, updatedAt: issueRecoveryActions.updatedAt })
        .from(issueRecoveryActions).where(and(isNull(issueRecoveryActions.resolvedAt), where)).orderBy(asc(issueRecoveryActions.id)).limit(limit + 1).offset(offset);
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
// The registry

export const OWNABLE_KINDS: readonly OwnableKind[] = [
  // Native runtime and Runner
  nrfKind("native_executor_claim", "Executor execution claim (fresh run)", "ownership",
    and(eq(nativeRunFinalizations.phase, "observed"), isNull(nativeRunFinalizations.resultId),
      isNotNull(nativeRunFinalizations.leaseOwner), notFinalizerOrCleanup, isNull(nativeRunFinalizations.recoveryState))),
  nrfKind("native_restart_recovery_claim", "Restart-recovery claim", "ownership",
    inArray(nativeRunFinalizations.recoveryState, ["awaiting_runner_reattach", "resuming_session", "bootstrap_incomplete"])),
  nrfKind("native_awaiting_evidence", "\"Awaiting evidence\" wait", "ownership",
    eq(nativeRunFinalizations.recoveryState, "awaiting_evidence"), undefined, [1, 2, 7]),
  nrfKind("native_accepted_result_lease", "Accepted-result executor lease", "accepted_result",
    and(isNotNull(nativeRunFinalizations.resultId), notInArray(nativeRunFinalizations.phase, TERMINAL_PHASES),
      isNotNull(nativeRunFinalizations.leaseOwner), notFinalizerOrCleanup)),
  nrfKind("native_finalizer_lease", "Finalizer lease", "accepted_result",
    and(like(nativeRunFinalizations.leaseOwner, "native-finalizer:%"), notInArray(nativeRunFinalizations.phase, TERMINAL_PHASES)),
    row => nrfFenceOwner(row, "native_finalizer_lease")),
  nrfKind("native_cleanup_lease", "Cleanup lease", "workspace_preservation",
    like(nativeRunFinalizations.leaseOwner, "native-cleanup:%"),
    row => nrfFenceOwner(row, "native_cleanup_lease")),
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
  {
    id: "sandbox_creation_intent", title: "Sandbox creation intent", obligation: "ownership", storage: "database",
    settle: null, invariantChecks: [1, 2, 3, 7],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select({ id: sandboxCreationOperations.id, companyId: sandboxCreationOperations.companyId,
        runId: sandboxCreationOperations.runId, issueId: sandboxCreationOperations.issueId,
        metadata: sandboxCreationOperations.metadata, updatedAt: sandboxCreationOperations.updatedAt })
        .from(sandboxCreationOperations).where(eq(sandboxCreationOperations.state, "pending")).orderBy(asc(sandboxCreationOperations.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: row.runId, issueId: row.issueId,
        owner: controllerStamp(json(row.metadata).creationController, "sandbox_creation_intent"), updatedAt: row.updatedAt,
      })) };
    },
  },
  leaseKind("environment_run_lease_active", "Run lease (active)", "ownership",
    and(eq(environmentLeases.status, "active"), isNotNull(environmentLeases.heartbeatRunId)),
    row => runOwner(row.heartbeatRunId)),
  leaseKind("environment_teardown_claim", "Teardown claim (in-flight cleanup)", "ownership",
    and(eq(environmentLeases.status, "pending_cleanup"), sql`(${environmentLeases.metadata}->>'pendingCleanupInFlight')::boolean is true`),
    row => controllerStamp(json(row.metadata).pendingCleanupController, "environment_teardown_claim")),
  leaseKind("environment_pending_cleanup", "Pending-cleanup obligation (not in flight)", "ownership",
    and(eq(environmentLeases.status, "pending_cleanup"),
      sql`coalesce((${environmentLeases.metadata}->>'pendingCleanupInFlight')::boolean, false) is false`),
    () => ({ kind: "none" }), [1, 2, 7]),
  leaseKind("environment_stop_and_retain_intent", "Stop-and-retain intent", "workspace_preservation",
    and(eq(environmentLeases.status, "pending_cleanup"), sql`${environmentLeases.metadata} ? 'sandboxStopAndRetain'`),
    row => runOwner(row.heartbeatRunId)),
  leaseKind("environment_native_export_resume", "Native export resume (stop-only)", "workspace_preservation",
    and(eq(environmentLeases.status, "pending_cleanup"), sql`${environmentLeases.metadata} ? 'nativeWorkspaceExportResume'`),
    row => runOwner(row.heartbeatRunId)),
  leaseKind("environment_retained_hold", "Retained / reusable hold", "workspace_preservation",
    eq(environmentLeases.status, "retained"), () => ({ kind: "none" }), [1, 7]),
  spoolKind("sandbox_orphan_cleanup_spool", "Orphan cleanup buffer/spool", "ownership", idleOrphanSpoolPath),
  leaseKind("environment_login_probe_lease", "Login/probe lease", "ownership",
    and(eq(environmentLeases.status, "active"), isNull(environmentLeases.heartbeatRunId)), () => ({ kind: "none" })),

  // Workspaces
  operationKind("workspace_runtime_control_operation", "Managed runtime-control operation", "ownership",
    and(eq(workspaceOperations.status, "running"), sql`${workspaceOperations.metadata} ? 'runtimeControlOwner'`),
    row => {
      const owner = json(json(row.metadata).runtimeControlOwner);
      const pid = int(owner.pid);
      // The owner stores a per-process UUID, a PID and, since #19868, its PID
      // space; no start time, so a live PID stays unprovable.
      return pid ? { kind: "process", stamp: { kind: "local", scope: "workspace_runtime_control_operation",
        generation: null, host: null, processSpace: str(owner.hostHash), bootId: str(owner.ownerId), pid,
        processStartedAt: null, processGroupId: null } } : { kind: "none" };
    }),
  operationKind("native_workspace_finalize_attempt", "Native workspace finalize attempt (copyback export)", "workspace_preservation",
    and(eq(workspaceOperations.phase, "workspace_finalize"), inArray(workspaceOperations.status, ["running", "pending"])),
    row => runOwner(row.heartbeatRunId)),
  operationKind("remote_provision_command", "Remote provision command intent", "workspace_preservation",
    and(eq(workspaceOperations.phase, "remote_workspace_provision"), or(eq(workspaceOperations.status, "running"),
      sql`(${workspaceOperations.metadata}->>'uncertain')::boolean is true`)),
    row => runOwner(row.heartbeatRunId)),
  operationKind("remote_snapshot_save", "Remote snapshot save", "workspace_preservation",
    and(eq(workspaceOperations.phase, "remote_workspace_snapshot"), inArray(workspaceOperations.status, ["running", "pending"])),
    row => runOwner(row.heartbeatRunId)),
  operationKind("remote_workspace_migration", "Remote workspace migration op", "workspace_preservation",
    and(eq(workspaceOperations.phase, "remote_workspace_migration"), eq(workspaceOperations.status, "running")),
    () => ({ kind: "none" })),
  {
    id: "execution_workspace_runtime_lease", title: "Execution workspace runtime lease", obligation: "ownership",
    storage: "database", settle: null, invariantChecks: [1, 2],
    listInProgress: async (db, limit, offset) => {
      const rows = await db.select().from(executionWorkspaceRuntimeLeases).orderBy(asc(executionWorkspaceRuntimeLeases.id)).limit(limit + 1).offset(offset);
      const result = page(rows, limit);
      return { truncated: result.truncated, records: result.rows.map(row => ({
        recordId: row.id, companyId: row.companyId, runId: row.ownerRunId, issueId: row.ownerIssueId,
        owner: row.ownerRunId ? runOwner(row.ownerRunId) : { kind: "operator", ownerType: row.ownerKey.split(":")[0] ?? null },
        updatedAt: row.updatedAt,
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
    storage: "database", settle: null, invariantChecks: [1, 2],
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
    storage: "database", settle: null, invariantChecks: [2],
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
  leaseKind("legacy_shutdown_settlement_fence", "Legacy graceful-shutdown workspace settlement fence", "workspace_preservation",
    sql`${environmentLeases.metadata}->'legacyShutdownWorkspaceSettlement'->>'state' = 'pending'`,
    row => {
      const bootId = str(json(json(row.metadata).legacyShutdownWorkspaceSettlement).controllerBootId);
      return bootId ? { kind: "process", stamp: { kind: "local", scope: "legacy_shutdown_settlement_fence",
        generation: null, host: null, processSpace: null, bootId, pid: null, processStartedAt: null } } : { kind: "none" };
    }, [2]),
  leaseKind("legacy_restore_recovery_hold", "Legacy restore-recovery preservation hold", "workspace_preservation",
    and(eq(environmentLeases.leasePolicy, "retain_on_failure"), sql`${environmentLeases.metadata} ? 'workspaceRestoreRecovery'`,
      notInArray(environmentLeases.status, ["released", "expired", "failed"])),
    row => runOwner(row.heartbeatRunId), [2, 7]),
  recoveryActionKind("system_recovery_attempt", "System recovery attempt for retained work", "workspace_preservation",
    sql`${issueRecoveryActions.evidence}->'systemRecovery'->>'state' in ('scheduled', 'running', 'awaiting_evidence')`,
    () => ({ kind: "none" })),
  recoveryActionKind("copyback_owner_hold", "Copyback-owner hold (RC-50)", "ownership",
    sql`${issueRecoveryActions.evidence}->'workspaceOwnerRecovery'->>'state' = 'operator_required'`,
    row => {
      const owner = json(json(json(row.evidence).workspaceOwnerRecovery).owner);
      const pid = int(owner.pid);
      // The receipt records a hostname but no PID space: unprovable by design.
      return pid ? { kind: "process", stamp: { kind: "local", scope: "copyback_owner_hold", generation: null,
        host: str(owner.hostname), processSpace: null, bootId: str(owner.controllerBootId), pid,
        processStartedAt: str(owner.processStartedAt), processGroupId: null } } : { kind: "none" };
    }),
  recoveryActionKind("observed_workspace_preservation_fence", "Observed-run workspace preservation fence", "workspace_preservation",
    sql`${issueRecoveryActions.evidence}->'observedWorkspacePreservation'->>'state' = 'stop_pending'`,
    row => {
      const fence = json(json(row.evidence).observedWorkspacePreservation);
      const token = str(fence.leaseOwner);
      // The current holder is read in the report pass (`resolveFenceHolders`).
      return token ? { kind: "fence", stamp: { kind: "remote", scope: "observed_workspace_preservation_fence",
        generation: int(fence.controllerGeneration), fenceToken: token },
        fence: { currentFenceToken: null, currentGeneration: null, leaseExpiresAt: null } } : { kind: "none" };
    }, [1, 2, 7], row => str(json(json(row.evidence).observedWorkspacePreservation).runId)),

  // Accounting and budgets
  runKind("run_accounting_debt", "Run accounting debt", "accounting",
    and(eq(heartbeatRuns.costAccountingPending, true),
      inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out", "interrupted"])),
    () => ({ kind: "none" }), [2, 3]),
  spoolKind("usage_receipt_spool", "Usage-receipt spool file (durable file)", "accounting", idleAccountingSpoolPath),

  // Wake queue and recovery
  {
    id: "wake_request_claimed", title: "Wake request (claimed)", obligation: "ownership", storage: "database",
    settle: null, invariantChecks: [2, 4],
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
  runKind("legacy_controller_lease", "Legacy controller lease", "ownership",
    and(eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"), isNotNull(heartbeatRuns.controllerBootId)),
    row => ({ kind: "process", stamp: { kind: "local", scope: "legacy_controller_lease", generation: null, host: null,
      processSpace: null, bootId: row.controllerBootId, pid: null, processStartedAt: null } })),
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
    settle: null, invariantChecks: [2, 3, 7],
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
    settle: null, invariantChecks: [2, 7],
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
}
