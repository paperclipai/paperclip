import { preserveWorkspaceRestoreRecoveryMetadataSql } from "../legacy-workspace-restore-recovery.js";
import { pendingNativeWorkspaceFinalizationCondition } from "../native-runtime/native-workspace-finalization-state.js";
import { CHAT_COMPLETION_WAKE_REASON } from "../chat-completion-delivery.js";
import {
  hasStopOnlyCleanup,
  settleStopOnlyCleanup,
} from "../sandbox-stop-and-retain.js";
import { recordNativeLocalProcessStop } from "../native-local-process-stop.js";
import {
  legacyControllerBootId,
  hasLiveLegacyController,
  revokeExpiredLegacyController,
} from "../legacy-controller-lease.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { runUsedConversationAdapter } from "../conversation-continuation.js";
import { legacyExecutionNeedsReconciliationWithEvidence, terminalizeLegacyExecution } from "../legacy-execution-recovery.js";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  environmentLeases,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import {
  claimNativeRestartRecoveries,
  closeIdleWarmNativeSessionsForRestart,
  currentNativeControllerIdentity,
  dispatchNativeSessionResumptions,
  detachNativeSessionsForRestart,
  isNativeSessionId,
  readNativeWorkspaceSyncReference,
  type NativeRestartRecoveryClaim,
  reconcileNativeFinalizations,
  reconcileRetainedNativeSessionCleanup,
  reconcileRetainedNativeSessionCleanups,
} from "../native-runtime/index.js";
import { drainRetainedRunnerdMaintenanceOperations } from "../../vendor/paperclip-runner/index.js";
import { runningProcesses } from "../../adapters/index.js";
import { parseObject } from "../../adapters/utils.js";
import {
  isNativeRunnerOwnershipHeld,
  NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
} from "../native-runtime/native-runner-ownership.js";
import { performance } from "node:perf_hooks";
import { buildProcessLossDiagnostic } from "../process-loss-diagnostics.js";
import { logActivity } from "../activity-log.js";
import { releaseRuntimeServicesForRun } from "../workspace-runtime.js";
import { isProcessGroupAlive } from "../local-service-supervisor.js";
import {
  findMissingHotRestartSnapshotRunIds,
  readHotRestartIntent,
  removeHotRestartIntent,
  shouldHonorHotRestartIntentForProcess,
  writeHotRestartReport,
  writeHotRestartShutdownSnapshot,
  type HotRestartIntentRun,
  type HotRestartReportRun,
} from "../hot-restart.js";
import { serverVersion } from "../../version.js";
import { adapterExecutionControls, waitForAdapterStop } from "../adapter-execution-control.js";
import { allowLegacyShutdownWorkspaceCleanup, beginLegacyShutdownWorkspaceSettlement, finishLegacyShutdownWorkspaceSettlement } from "../legacy-shutdown-workspace-settlement.js";

import type { environmentService } from "../environments.js";
import type { environmentRuntimeService, ProviderResourceDisposition } from "../environment-runtime.js";
import type { agentInstructionWorkingCopyService } from "../agent-instruction-working-copies.js";
import type { createHeartbeatRunState } from "./run-state.js";
import type { HeartbeatRetryDependencies, createHeartbeatRetries } from "./retries.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type HeartbeatRetries = ReturnType<typeof createHeartbeatRetries>;

/** Recovery owns reconciliation; the service retains execution and lifecycle effects. */
export interface HeartbeatRecoveryDependencies extends Pick<HeartbeatRetryDependencies,
  "getAgent" | "appendRunEvent" | "setRunStatusIfRunning" |
  "setWakeupStatus" | "releaseIssueExecutionAndPromote" | "finalizeAgentStatus"> {
  enterShutdown: () => void;
  getRun: (runId: string, options?: Parameters<ReturnType<typeof createHeartbeatRunState>["getRun"]>[1]) => Promise<
    Awaited<ReturnType<ReturnType<typeof createHeartbeatRunState>["getRun"]>> | null
  >;
  environmentRuntime: ReturnType<typeof environmentRuntimeService>;
  environmentsSvc: Pick<ReturnType<typeof environmentService>, "getById" | "getLeaseById" | "releaseLease">;
  instructionCopies: Pick<ReturnType<typeof agentInstructionWorkingCopyService>, "recoverStopped" | "recoverCaptured">;
  runtimeEnv: Record<string, string | undefined>;
  // Preserve the module-wide sets shared by scheduler and route service instances.
  activeRunExecutions: Set<string>;
  activeRunExecutionPromises: Set<Promise<void>>;
  scheduleBoundedRetryForRun: HeartbeatRetries["scheduleBoundedRetryForRun"];
  scheduleInteractionContinuationInfrastructureRetryIfEligible: HeartbeatRetries["scheduleInteractionContinuationInfrastructureRetryIfEligible"];
  timerClaimWasFirstHeartbeat: HeartbeatRetries["timerClaimWasFirstHeartbeat"];
  executeRun: (runId: string, options?: {
    nativeLeaseOwner?: string;
    nativeRestartRecovery?: NativeRestartRecoveryClaim;
  }) => Promise<void>;
  scheduleNativeSessionResumeDispatch: (runId: string, nextAttemptAt: Date) => void;
  cancelHeartbeatNativeRun: (input: {
    db: Db; runId: string; reason: string; runtimeMode: string | null;
  }) => Promise<unknown>;
  terminateHeartbeatRunProcess: (input: {
    pid: number | null | undefined;
    processGroupId: number | null | undefined;
    graceMs?: number;
  }) => Promise<void>;
  setRunStatus: (runId: string, status: string, patch?: Partial<typeof heartbeatRuns.$inferInsert>) => Promise<HeartbeatRun | null>;
  setRunStatusFromLive: (runId: string, status: string, fromStatuses: string[], patch?: Partial<typeof heartbeatRuns.$inferInsert>) => Promise<{
    updated: boolean;
    run: HeartbeatRun | null;
  }>;
  mergeRunStopMetadataForAgent: (
    agent: Pick<typeof agents.$inferSelect, "adapterType" | "adapterConfig">,
    outcome: "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out",
    options?: {
      resultJson?: Record<string, unknown> | null;
      conversationContinuationEligible?: boolean;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ) => Record<string, unknown> | null;
  classifyAndPersistRunLiveness: (run: HeartbeatRun, resultJson?: Record<string, unknown> | null) => Promise<HeartbeatRun | null>;
  releaseEnvironmentLeasesForRun: (input: {
    runId: string;
    companyId: string;
    agentId: string;
    status: string | null | undefined;
    failureReason?: string | null;
    providerResourceDisposition?: ProviderResourceDisposition;
  }) => Promise<void>;
  acknowledgeRemoteStop: (runId: string, companyId: string) => Promise<void>;
  resumeRemoteStopComments: (run: HeartbeatRun) => Promise<void>;
  dispatchPendingNativeStatusWakeups: () => Promise<unknown>;
  cancelRunInternal: (runId: string, reason?: string, options?: { resultJson?: Record<string, unknown> }) => Promise<unknown>;
  startNextQueuedRunForAgent: (agentId: string) => Promise<unknown>;
}

export const DETACHED_PROCESS_ERROR_CODE = "process_detached";

const NATIVE_OWNERSHIP_UNVERIFIED_MESSAGE =
  "Native execution ownership could not be verified; automatic recovery is blocked";

// The reaper sweeps at most this many pending_cleanup leases per tick.
const PENDING_CLEANUP_SWEEP_PAGE_SIZE = 20;

const pendingCleanupAttemptsInFlight = new Set<string>();

// Escalate and slow cleanup after this many attempts; never abandon a live lease.
const PENDING_CLEANUP_SWEEP_ATTEMPT_CAP = 5;

// The reaper stores its retry state under these keys in the lease metadata.
const PENDING_CLEANUP_ATTEMPTS_METADATA_KEY = "pendingCleanupRetryAttempts";

const PENDING_CLEANUP_CAP_WARNED_METADATA_KEY = "pendingCleanupRetryCapWarned";

// The reaper sweeps at most this many orphaned active leases per tick.
const ORPHANED_ACTIVE_LEASE_SWEEP_PAGE_SIZE = 20;

// A provider or plugin destroy rejection can carry a bearer credential, a
// signed URL, or provider response detail in its name, code, message, cause, or
// stack. The exception fields cross the server boundary, so they are not a
// trusted enum. The pending_cleanup sweep logs never read the exception. Each
// catch site logs a constant, locally generated `errorKind` instead.
const PENDING_CLEANUP_RETRY_ERROR_KIND = "destroy_failed";

const PENDING_CLEANUP_SWEEP_ERROR_KIND = "sweep_failed";

const ORPHANED_ACTIVE_LEASE_SWEEP_ERROR_KIND = "orphaned_active_lease_sweep_failed";

// Read the stored retry attempt count as a safe value, directly in SQL. A
// provider can write a malformed value under the attempts key. The type guard
// makes any non-number value read as zero. The reader computes as numeric and
// never casts to int, so a finite number outside the 32-bit range (for example
// 1e300) never throws. The reader clamps a negative value to zero and a positive
// value to the attempt cap. One malformed lease therefore never aborts the page
// sweep. This matches the TypeScript reader `readPendingCleanupRetryAttempts`,
// which clamps to the same range. The claim predicate compares the two readers,
// so both must yield the same value for every input.
function pendingCleanupAttemptsSql() {
  return sql`
    case
      when jsonb_typeof(${environmentLeases.metadata} -> ${PENDING_CLEANUP_ATTEMPTS_METADATA_KEY}) = 'number'
        then least(
          greatest(
            floor((${environmentLeases.metadata} ->> ${PENDING_CLEANUP_ATTEMPTS_METADATA_KEY})::numeric),
            0
          ),
          ${PENDING_CLEANUP_SWEEP_ATTEMPT_CAP}
        )
      else 0
    end`;
}

function pendingCleanupRetryDueSql(explicitRetry = false) {
  // Ownership renewal and retry cooldown are separate clocks. A late renewal
  // cannot change when a completed attempt may retry. Older claims used the
  // retry field for both clocks, so retain that fallback until they settle.
  const deadline = sql`case
    when ${environmentLeases.metadata}->>'pendingCleanupInFlight' = 'true'
      and ${environmentLeases.metadata} ? 'pendingCleanupLeaseExpiresAtMs'
      then ${environmentLeases.metadata}->'pendingCleanupLeaseExpiresAtMs'
    else ${environmentLeases.metadata}->'pendingCleanupRetryAfterMs' end`;
  return sql`case
    when ${explicitRetry} and coalesce(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') != 'true' then true
    when jsonb_typeof(${deadline}) = 'number'
      then (${deadline})::numeric <= ${Date.now()}
        or (${deadline})::numeric > ${Date.now() + 30 * 60_000 + 1_000}
    else true end`;
}

// Choose the `jsonb_set` target root. A provider can write a scalar or array
// metadata root. `jsonb_set` fails on a non-object root, so the reader uses the
// stored metadata only when its root is an object. A NULL, scalar, or array root
// reads as an empty object. `jsonb_typeof(NULL)` is NULL, so the else branch also
// covers a NULL root.
function pendingCleanupMetadataObjectSql() {
  return sql`case when jsonb_typeof(${environmentLeases.metadata}) = 'object' then ${environmentLeases.metadata} else '{}'::jsonb end`;
}

// Read the stored cap-warned flag as a safe boolean, directly in SQL. A
// malformed value reads as false, so the boolean cast never throws.
function pendingCleanupCapWarnedSql() {
  return sql`coalesce(
    case
      when jsonb_typeof(${environmentLeases.metadata} -> ${PENDING_CLEANUP_CAP_WARNED_METADATA_KEY}) = 'boolean'
        then (${environmentLeases.metadata} ->> ${PENDING_CLEANUP_CAP_WARNED_METADATA_KEY})::boolean
      else false
    end,
    false
  )`;
}

export const CANCELLABLE_HEARTBEAT_RUN_STATUSES = [
  "queued",
  "running",
  "scheduled_retry",
] as const;

const NATIVE_QUESTION_CANCELLATION_CONTEXT_KEY = "nativeQuestionCancellation";

export const HEARTBEAT_RUN_TERMINAL_STATUSES = [
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;

const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "kimi_local",
  "opencode_local",
  "pi_local",
]);

function isTrackedLocalChildProcessAdapter(adapterType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}

// A positive liveness check means some process currently owns the PID.
// On Linux, PIDs can be recycled, so this is a best-effort signal rather
// than proof that the original child is still alive.
export function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

function buildProcessLossMessage(
  run: {
    processPid: number | null;
    processGroupId: number | null;
  },
  options?: { descendantOnly?: boolean },
) {
  if (options?.descendantOnly && run.processGroupId) {
    return `Process lost -- parent pid ${run.processPid ?? "unknown"} exited, but descendant process group ${run.processGroupId} was still alive and was terminated`;
  }
  if (run.processPid) {
    return `Process lost -- child pid ${run.processPid} is no longer running`;
  }
  if (run.processGroupId) {
    return `Process lost -- process group ${run.processGroupId} is no longer running`;
  }
  return "Process lost -- server may have restarted";
}

function readHotRestartAdoptionMetadata(
  resultJson: Record<string, unknown> | null | undefined,
) {
  const result = parseObject(resultJson);
  const hotRestart = parseObject(result.hotRestart);
  if (hotRestart.adopted !== true || typeof hotRestart.adoptedAt !== "string")
    return null;
  return hotRestart;
}

function mergeHotRestartAdoptionResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  input: {
    adoptedAt: Date;
    previousServerPid: number;
    newServerPid: number;
    previousServerVersion: string | null;
    newServerVersion: string;
    processPid: number | null;
    processGroupId: number | null;
  },
) {
  const result = parseObject(resultJson);
  const existing = parseObject(result.hotRestart);
  return {
    ...result,
    hotRestart: {
      ...existing,
      adopted: true,
      adoptedAt: input.adoptedAt.toISOString(),
      previousServerPid: input.previousServerPid,
      newServerPid: input.newServerPid,
      previousServerVersion: input.previousServerVersion,
      newServerVersion: input.newServerVersion,
      processPid: input.processPid,
      processGroupId: input.processGroupId,
    },
  };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Restart recovery shares the service lifecycle callbacks and execution ownership. */
export function createHeartbeatRecovery(db: Db, dependencies: HeartbeatRecoveryDependencies) {
  const {
    enterShutdown,
    scheduleBoundedRetryForRun,
    appendRunEvent,
    environmentRuntime,
    scheduleNativeSessionResumeDispatch,
    getRun,
    executeRun,
    activeRunExecutionPromises,
    cancelHeartbeatNativeRun,
    terminateHeartbeatRunProcess,
    setRunStatusIfRunning,
    mergeRunStopMetadataForAgent,
    setWakeupStatus,
    classifyAndPersistRunLiveness,
    releaseEnvironmentLeasesForRun,
    releaseIssueExecutionAndPromote,
    finalizeAgentStatus,
    timerClaimWasFirstHeartbeat,
    environmentsSvc,
    acknowledgeRemoteStop,
    resumeRemoteStopComments,
    setRunStatusFromLive,
    instructionCopies,
    dispatchPendingNativeStatusWakeups,
    runtimeEnv,
    cancelRunInternal,
    activeRunExecutions,
    setRunStatus,
    getAgent,
    scheduleInteractionContinuationInfrastructureRetryIfEligible,
    startNextQueuedRunForAgent,
  } = dependencies;

  async function enqueueProcessLossRetry(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    now: Date,
  ) {
    // Completion deliveries own their durable bounded retry and reply identity.
    // A second process-loss retry would compete for the same outbox input.
    if (run.contextSnapshot?.wakeReason === CHAT_COMPLETION_WAKE_REASON &&
        Array.isArray(run.contextSnapshot?.chatCompletionDeliveryIds)) return null;
    // Native sessions have their own fenced same-run controller. Legacy
    // bootstrap recovery shares the durable delay and incident counter with
    // transient retries; process loss must not open a second retry budget.
    if (run.runtimeMode === "native" || await legacyExecutionNeedsReconciliationWithEvidence(db, run))
      return null;
    const scheduled = await scheduleBoundedRetryForRun(run, agent, { now });
    return scheduled.outcome === "scheduled" ? scheduled.run : null;
  }

  function toHotRestartIntentRun(input: {
    run: typeof heartbeatRuns.$inferSelect;
    adapterType: string;
  }): HotRestartIntentRun {
    const context = parseObject(input.run.contextSnapshot);
    return {
      runId: input.run.id,
      companyId: input.run.companyId,
      agentId: input.run.agentId,
      adapterType: input.adapterType,
      status: input.run.status,
      processPid: input.run.processPid ?? null,
      processGroupId: input.run.processGroupId ?? null,
      issueId: readNonEmptyString(context.issueId),
      runtimeMode: input.run.runtimeMode,
      nativeSessionId: input.run.nativeSessionId,
      runnerInstanceId: input.run.runnerInstanceId,
      processStartedAt: input.run.processStartedAt?.toISOString() ?? null,
    };
  }

  function isServerStdioBoundHotRestartRun(input: {
    run: typeof heartbeatRuns.$inferSelect;
    adapterType: string;
    adapterConfig: unknown;
  }) {
    const context = parseObject(input.run.contextSnapshot);
    if (
      context.processTopology === "server_stdio" ||
      context.executionEngine === "acp"
    ) {
      return true;
    }
    if (
      context.processTopology === "detached" ||
      context.executionEngine === "cli"
    ) {
      return false;
    }
    if (
      !["claude_local", "codex_local", "gemini_local"].includes(
        input.adapterType,
      )
    ) {
      return false;
    }
    return (
      readNonEmptyString(parseObject(input.adapterConfig).engine) !== "cli"
    );
  }

  async function prepareHotRestartShutdown(
    signal: "SIGINT" | "SIGTERM",
    now = new Date(),
  ) {
    enterShutdown();
    const idleSessions = await closeIdleWarmNativeSessionsForRestart();
    if (idleSessions.failed > 0) {
      logger.warn({ idleSessions }, "idle native sessions could not checkpoint before controller shutdown");
    }
    let intent: Awaited<ReturnType<typeof readHotRestartIntent>>;
    try {
      intent = await readHotRestartIntent();
    } catch (err) {
      logger.warn(
        { err },
        "failed to read hot-restart intent; falling back to normal shutdown drain",
      );
      return {
        mode: "read_error" as const,
        skipDrain: false as const,
        activeRunIds: [] as string[],
      };
    }

    if (!intent)
      return {
        mode: "not_requested" as const,
        skipDrain: false as const,
        activeRunIds: [] as string[],
      };
    if (intent.drainRequired)
      return {
        mode: "drain_required" as const,
        skipDrain: false as const,
        activeRunIds: [] as string[],
      };
    if (!shouldHonorHotRestartIntentForProcess(intent)) {
      logger.warn(
        { expectedPid: intent.previousServerPid, currentPid: process.pid },
        "hot-restart intent targets a different server pid; falling back to normal shutdown drain",
      );
      return {
        mode: "pid_mismatch" as const,
        skipDrain: false as const,
        activeRunIds: [] as string[],
      };
    }

    const activeRuns = await db
      .select({
        run: heartbeatRuns,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.status, "running"));
    const snapshotRuns = activeRuns.map(toHotRestartIntentRun);
    const intentWithVersion = {
      ...intent,
      previousServerVersion: intent.previousServerVersion ?? serverVersion,
    };

    const serverStdioRuns = activeRuns.filter(isServerStdioBoundHotRestartRun);
    if (serverStdioRuns.length > 0) {
      const activeServerStdioRunIds = serverStdioRuns.map(({ run }) => run.id);
      await writeHotRestartShutdownSnapshot({
        intent: intentWithVersion,
        signal,
        activeRuns: snapshotRuns,
        drainReason: "active_acp_run",
        drainRunIds: activeServerStdioRunIds,
        capturedAt: now,
      });

      logger.warn(
        {
          signal,
          previousServerPid: intent.previousServerPid,
          activeRunIds: snapshotRuns.map((run) => run.runId),
          activeServerStdioRunIds,
          drainReason: "active_acp_run",
        },
        "server-stdio agent run prevents hot-restart adoption; using graceful drain and retry",
      );

      return {
        mode: "acp_drain_required" as const,
        skipDrain: false as const,
        activeRunIds: snapshotRuns.map((run) => run.runId),
        activeAcpRunIds: activeServerStdioRunIds,
        drainRunIds: activeServerStdioRunIds,
        drainReason: "active_acp_run" as const,
      };
    }

    await writeHotRestartShutdownSnapshot({
      intent: intentWithVersion,
      signal,
      activeRuns: snapshotRuns,
      capturedAt: now,
    });

    for (const { run } of activeRuns) {
      await appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message:
          "Hot restart requested; leaving child process alive for startup adoption",
        payload: {
          signal,
          previousServerPid: intent.previousServerPid,
          previousServerVersion: intentWithVersion.previousServerVersion,
          processPid: run.processPid ?? null,
          processGroupId: run.processGroupId ?? null,
        },
      });
    }

    const nativeRunIds = activeRuns
      .filter(
        ({ run, adapterType }) =>
          adapterType === "paperclip_runner" &&
          isNativeSessionId(run.nativeSessionId),
      )
      .map(({ run }) => run.id);
    const detachedNativeSessions =
      await detachNativeSessionsForRestart(nativeRunIds);

    logger.info(
      {
        signal,
        previousServerPid: intent.previousServerPid,
        activeRunIds: snapshotRuns.map((run) => run.runId),
        detachedNativeSessions,
      },
      "hot-restart shutdown snapshot captured; skipping graceful run drain",
    );

    return {
      mode: "hot_restart" as const,
      skipDrain: true as const,
      activeRunIds: snapshotRuns.map((run) => run.runId),
    };
  }

  async function reconcileHotRestartAdoption(now = new Date()) {
    let intent: Awaited<ReturnType<typeof readHotRestartIntent>>;
    try {
      intent = await readHotRestartIntent();
    } catch (err) {
      logger.warn(
        { err },
        "failed to read hot-restart intent on startup; skipping adoption",
      );
      return {
        mode: "read_error" as const,
        adoptedRunIds: [] as string[],
        finalizedWhileDownRunIds: [] as string[],
        lostRunIds: [] as string[],
        skippedRunIds: [] as string[],
      };
    }
    if (!intent) {
      return {
        mode: "not_requested" as const,
        adoptedRunIds: [] as string[],
        finalizedWhileDownRunIds: [] as string[],
        lostRunIds: [] as string[],
        skippedRunIds: [] as string[],
      };
    }

    if (!intent.shutdownSnapshot) {
      const log = intent.drainRequired
        ? logger.info.bind(logger)
        : logger.warn.bind(logger);
      log(
        {
          previousServerPid: intent.previousServerPid,
          preflightActiveRunIds: intent.preflightActiveRunIds,
          drainReason: intent.drainReason ?? null,
        },
        intent.drainRequired
          ? "drain-required restart intent has no adoption snapshot"
          : "hot-restart intent present but shutdown snapshot is missing; no runs can be adopted",
      );
    }
    const candidates = intent.shutdownSnapshot?.activeRuns ?? [];
    const missingSnapshotRunIds = findMissingHotRestartSnapshotRunIds(intent);
    const reconciliationRunIds = [
      ...new Set([
        ...candidates.map((run) => run.runId),
        ...missingSnapshotRunIds,
      ]),
    ];
    const currentRows =
      reconciliationRunIds.length > 0
        ? await db
            .select({
              run: heartbeatRuns,
              adapterType: agents.adapterType,
            })
            .from(heartbeatRuns)
            .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
            .where(inArray(heartbeatRuns.id, reconciliationRunIds))
        : [];
    const currentByRunId = new Map(currentRows.map((row) => [row.run.id, row]));

    const reportRuns: HotRestartReportRun[] = [];
    const adoptedRunIds: string[] = [];
    const finalizedWhileDownRunIds: string[] = [];
    const lostRunIds: string[] = [];
    const skippedRunIds: string[] = [];

    const classify = (
      candidate: HotRestartIntentRun,
      classification: HotRestartReportRun["classification"],
      reason: string,
      patch?: Partial<HotRestartIntentRun>,
    ) => {
      const run = {
        ...candidate,
        ...patch,
        classification,
        reason,
      } satisfies HotRestartReportRun;
      reportRuns.push(run);
      if (classification === "adopted") adoptedRunIds.push(candidate.runId);
      else if (classification === "finalized_while_down")
        finalizedWhileDownRunIds.push(candidate.runId);
      else if (classification === "lost") lostRunIds.push(candidate.runId);
      else skippedRunIds.push(candidate.runId);
    };

    for (const runId of missingSnapshotRunIds) {
      const current = currentByRunId.get(runId);
      if (!current) {
        finalizedWhileDownRunIds.push(runId);
        continue;
      }

      const candidate = toHotRestartIntentRun(current);
      if (current.run.status !== "running") {
        classify(
          candidate,
          "finalized_while_down",
          `run_status_${current.run.status}`,
        );
      } else {
        classify(candidate, "lost", "missing_shutdown_snapshot");
      }
    }

    if (lostRunIds.length > 0) {
      logger.error(
        { previousServerPid: intent.previousServerPid, lostRunIds },
        "hot-restart shutdown snapshot omitted live preflight runs; reporting them as lost",
      );
    }

    for (const candidate of candidates) {
      const current = currentByRunId.get(candidate.runId);
      if (!current) {
        classify(candidate, "finalized_while_down", "run_row_missing");
        continue;
      }

      const { run, adapterType } = current;
      const patch = {
        adapterType,
        status: run.status,
        processPid: run.processPid ?? candidate.processPid,
        processGroupId: run.processGroupId ?? candidate.processGroupId,
      };

      if (run.status !== "running") {
        classify(
          candidate,
          "finalized_while_down",
          `run_status_${run.status}`,
          patch,
        );
        continue;
      }

      const hasSelectiveAcpDrain =
        intent.drainReason === "active_acp_run" &&
        (intent.drainRunIds?.length ?? 0) > 0;
      if (
        hasSelectiveAcpDrain &&
        intent.drainRunIds?.includes(candidate.runId)
      ) {
        // A selective ACP drain is expected to persist a terminal row before
        // the new server starts. If the process was terminated but that write
        // failed, surface the run as lost instead of hiding it as an expected
        // drain skip.
        classify(candidate, "lost", "selective_drain_not_finalized", patch);
        continue;
      }
      if (intent.drainRequired && !hasSelectiveAcpDrain) {
        classify(candidate, "skipped", "drain_required", patch);
        continue;
      }

      if (run.runtimeMode === "native" && adapterType === "paperclip_runner") {
        classify(candidate, "skipped", "native_restart_recovery_owned", patch);
        continue;
      }

      if (!isTrackedLocalChildProcessAdapter(adapterType)) {
        classify(
          candidate,
          "skipped",
          "adapter_not_local_child_process",
          patch,
        );
        continue;
      }

      const processPid = run.processPid ?? candidate.processPid;
      const processGroupId = run.processGroupId ?? candidate.processGroupId;
      const processPidAlive = isProcessAlive(processPid);
      const processGroupAlive = isProcessGroupAlive(processGroupId);
      if (!processPid && !processGroupId) {
        classify(candidate, "lost", "missing_process_metadata", patch);
        continue;
      }
      if (!processPidAlive && !processGroupAlive) {
        classify(candidate, "lost", "process_not_alive", patch);
        continue;
      }

      const resultJson = mergeHotRestartAdoptionResultJson(
        parseObject(run.resultJson),
        {
          adoptedAt: now,
          previousServerPid: intent.previousServerPid,
          newServerPid: process.pid,
          previousServerVersion: intent.previousServerVersion,
          newServerVersion: serverVersion,
          processPid,
          processGroupId,
        },
      );
      const updated = await db
        .update(heartbeatRuns)
        .set({
          resultJson: preserveWorkspaceRestoreRecoveryMetadataSql(resultJson, true),
          error:
            run.errorCode === DETACHED_PROCESS_ERROR_CODE ? null : run.error,
          errorCode:
            run.errorCode === DETACHED_PROCESS_ERROR_CODE
              ? null
              : run.errorCode,
          updatedAt: now,
        })
        .where(
          and(
            eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) {
        const latest = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, run.id))
          .then((rows) => rows[0] ?? null);
        if (latest && latest.status !== "running") {
          classify(
            candidate,
            "finalized_while_down",
            `run_status_${latest.status}`,
            patch,
          );
        } else {
          classify(candidate, "lost", "adoption_update_not_applied", patch);
        }
        continue;
      }

      await appendRunEvent(updated, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "Adopted live child process after hot restart",
        payload: {
          previousServerPid: intent.previousServerPid,
          newServerPid: process.pid,
          previousServerVersion: intent.previousServerVersion,
          newServerVersion: serverVersion,
          processPid,
          processGroupId,
        },
      });
      classify(
        candidate,
        "adopted",
        processPidAlive ? "process_pid_alive" : "process_group_alive",
        patch,
      );
    }

    const report = await writeHotRestartReport({
      version: 1,
      requestedAt: intent.requestedAt,
      completedAt: now.toISOString(),
      drainRequired: intent.drainRequired,
      drainReason:
        intent.drainReason ?? (intent.drainRequired ? "requested" : null),
      previousServerPid: intent.previousServerPid,
      newServerPid: process.pid,
      previousServerVersion: intent.previousServerVersion,
      newServerVersion: serverVersion,
      adoptedRunIds,
      finalizedWhileDownRunIds,
      lostRunIds,
      skippedRunIds,
      runs: reportRuns,
    });
    await removeHotRestartIntent(undefined, intent);

    logger.info(
      {
        previousServerPid: report.previousServerPid,
        newServerPid: report.newServerPid,
        adoptedRunIds,
        finalizedWhileDownRunIds,
        lostRunIds,
        missingSnapshotRunIds,
        skippedRunIds,
      },
      "hot-restart adoption report written",
    );

    return {
      mode: "reported" as const,
      adoptedRunIds,
      finalizedWhileDownRunIds,
      lostRunIds,
      skippedRunIds,
    };
  }

  async function recoverNativeRunsAfterRestart(now = new Date()) {
    // A result committed before the old controller stopped outranks process
    // recovery. Finish its durable workspace/status suffix before deciding
    // whether any provider authority needs to be reopened.
    await reconcileNativeFinalizations(db, undefined, {
      environmentRuntime,
      onWorkspaceSettled: settleRecoveredNativeWorkspace,
    });
    scheduleRetainedNativeSessionCleanup();
    const intent = await readHotRestartIntent().catch((error) => {
      logger.warn(
        { err: error },
        "failed to read hot-restart intent before native startup recovery",
      );
      return null;
    });
    const restartKind = intent ? ("hot" as const) : ("hard" as const);
    const previousStartedAt = intent?.previousServerStartedAt
      ? new Date(intent.previousServerStartedAt)
      : null;
    const scheduledNativeRetries = await db
      .select({
        runId: nativeRunFinalizations.runId,
        nextAttemptAt: nativeRunFinalizations.nextAttemptAt,
      })
      .from(nativeRunFinalizations)
      .innerJoin(
        heartbeatRuns,
        eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      )
      .where(
        and(
          eq(heartbeatRuns.runtimeMode, "native"),
          inArray(heartbeatRuns.status, ["running", "failed"]),
          isNull(nativeRunFinalizations.resultId),
          eq(nativeRunFinalizations.phase, "retryable_failure"),
          gt(nativeRunFinalizations.nextAttemptAt, now),
        ),
      );
    for (const scheduled of scheduledNativeRetries) {
      if (scheduled.nextAttemptAt) {
        scheduleNativeSessionResumeDispatch(
          scheduled.runId,
          scheduled.nextAttemptAt,
        );
      }
    }
    const dispositions = await claimNativeRestartRecoveries({
      db,
      restartKind,
      recoveryRequestId: intent?.recoveryRequestId ?? null,
      coordinatedPreviousController: intent
        ? {
            pid: intent.previousServerPid,
            processStartedAt:
              previousStartedAt && !Number.isNaN(previousStartedAt.getTime())
                ? previousStartedAt
                : null,
          }
        : null,
      now,
    });

    const claims = dispositions.filter(
      (disposition): disposition is NativeRestartRecoveryClaim =>
        disposition.kind === "reattach_existing_runner" ||
        disposition.kind === "reattach_remote_runner" ||
        disposition.kind === "resume_dead_runner" ||
        disposition.kind === "bootstrap_incomplete",
    );
    for (const disposition of dispositions) {
      const run = await getRun(disposition.runId);
      if (run) {
        const isClaim =
          disposition.kind === "reattach_existing_runner" ||
          disposition.kind === "reattach_remote_runner" ||
          disposition.kind === "resume_dead_runner" ||
          disposition.kind === "bootstrap_incomplete";
        await appendRunEvent(run, {
          eventType: "native.recovery.transition",
          stream: "system",
          level: disposition.kind === "blocked" ? "warn" : "info",
          message:
            disposition.kind === "reattach_existing_runner" ||
            disposition.kind === "reattach_remote_runner"
              ? "Recovering the existing native runner process after server restart"
              : disposition.kind === "resume_dead_runner"
                ? "Resuming the durable native provider session after runner process loss"
                : disposition.kind === "bootstrap_incomplete"
                  ? "Restarting an incomplete native runner bootstrap on the same heartbeat run"
                  : disposition.kind === "awaiting_evidence"
                    ? "Native restart recovery is waiting for safe ownership evidence"
                    : disposition.kind === "already_finalized"
                      ? "Native restart recovery found an already-finalized result"
                      : "Native restart recovery blocked ambiguous or conflicting ownership",
          payload: {
            restartKind: isClaim ? disposition.restartKind : restartKind,
            recoveryRequestId: isClaim
              ? disposition.recoveryRequestId
              : (intent?.recoveryRequestId ?? null),
            runnerDisposition: disposition.kind,
            ...(isClaim
              ? {
                  controllerGeneration: disposition.controllerGeneration,
                  providerAttempt: disposition.providerAttempt,
                }
              : { reason: disposition.reason }),
            ...(disposition.kind === "reattach_existing_runner"
              ? {
                  processPid: disposition.process.pid,
                  processGroupId: disposition.process.processGroupId,
                  processStartedAt: disposition.process.startedAt,
                }
              : {}),
          },
        });
      }
    }
    for (const claim of claims) {
      const execution = executeRun(claim.runId, {
        nativeLeaseOwner: claim.leaseOwner,
        nativeRestartRecovery: claim,
      }).catch((error) => {
        logger.error(
          { err: error, runId: claim.runId, disposition: claim.kind },
          "native restart recovery execution failed",
        );
      });
      activeRunExecutionPromises.add(execution);
      void execution.finally(() =>
        activeRunExecutionPromises.delete(execution),
      );
    }

    return {
      restartKind,
      claims,
      dispositions,
      scheduledRetryRunIds: scheduledNativeRetries.map((entry) => entry.runId),
      awaitingEvidenceRunIds: dispositions
        .filter((entry) => entry.kind === "awaiting_evidence")
        .map((entry) => entry.runId),
      blockedRunIds: dispositions
        .filter((entry) => entry.kind === "blocked")
        .map((entry) => entry.runId),
    };
  }

  async function drainRunningRunsForShutdown(
    signal: "SIGINT" | "SIGTERM",
    now = new Date(),
    runIds: readonly string[] | null = null,
  ) {
    const selectedRunIds = runIds ? [...new Set(runIds)] : null;
    if (selectedRunIds?.length === 0) {
      return {
        interrupted: 0,
        interruptedRunIds: [],
        retryRunIds: [],
        restartSuspendedRunIds: [],
      };
    }
    const activeRuns = await db
      .select({
        run: heartbeatRuns,
        agent: agents,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        selectedRunIds
          ? and(
              eq(heartbeatRuns.status, "running"),
              inArray(heartbeatRuns.id, selectedRunIds),
            )
          : eq(heartbeatRuns.status, "running"),
      );

    const interruptedRunIds: string[] = [];
    const retryRunIds: string[] = [];
    const restartSuspendedRunIds: string[] = [];

    const settlementDeadline = new Date(Date.now() + 30_000);
    const settlements = await Promise.allSettled(activeRuns.map(async ({ run, agent }) => {
      // Shutdown owns only this boot's legacy executions. Expired foreign
      // owners belong to the reaper, not another container's drain.
      if (run.runtimeMode === "legacy" && run.controllerBootId &&
          run.controllerBootId !== legacyControllerBootId) return;
      if (isNativeRunnerOwnershipHeld(run)) return;
      if (
        run.runtimeMode === "native" &&
        agent.adapterType === "paperclip_runner"
      ) {
        // A graceful shutdown relinquishes controller authority just like a
        // hot restart. Leaving the old event consumer attached lets its
        // finalizer interrupt/suspend Claude while the next server is adopting
        // the same turn.
        await detachNativeSessionsForRestart([run.id]);
        const recoveryHistoryEntry = JSON.stringify({
          at: now.toISOString(),
          restartKind: "graceful",
          disposition: "restart_suspended",
          reason: signal,
          processPid: run.processPid,
          processStartedAt: run.processStartedAt?.toISOString() ?? null,
        });
        await db
          .update(nativeRunFinalizations)
          .set({
            recoveryState: "awaiting_runner_reattach",
            recoveryHistory: sql`(
              select coalesce(jsonb_agg(item order by ordinal), '[]'::jsonb)
              from jsonb_array_elements(
                coalesce(${nativeRunFinalizations.recoveryHistory}, '[]'::jsonb)
                || jsonb_build_array(${recoveryHistoryEntry}::jsonb)
              ) with ordinality as history(item, ordinal)
              where ordinal > greatest(
                jsonb_array_length(
                  coalesce(${nativeRunFinalizations.recoveryHistory}, '[]'::jsonb)
                  || jsonb_build_array(${recoveryHistoryEntry}::jsonb)
                ) - 20,
                0
              )
            )`,
            updatedAt: now,
          })
          .where(
            and(
              eq(nativeRunFinalizations.runId, run.id),
              isNull(nativeRunFinalizations.resultId),
            ),
          );
        await appendRunEvent(run, {
          eventType: "native.recovery.transition",
          stream: "system",
          level: "info",
          message:
            "Server shutdown suspended native controller ownership without cancelling provider work",
          payload: {
            restartKind: "graceful",
            signal,
            runnerDisposition: "awaiting_runner_reattach",
            processPid: run.processPid,
            processGroupId: run.processGroupId,
            processStartedAt: run.processStartedAt?.toISOString() ?? null,
            retryRunCreated: false,
          },
        });
        restartSuspendedRunIds.push(run.id);
        return;
      }
      const message = `Interrupted by graceful server shutdown (${signal})`;
      const running = runningProcesses.get(run.id);
      const control = run.runtimeMode === "legacy" ? adapterExecutionControls.get(run.id) : undefined;
      if (control) await beginLegacyShutdownWorkspaceSettlement(db, run, settlementDeadline);
      try {
        if (run.runtimeMode === "native") {
          await cancelHeartbeatNativeRun({
            db,
            runId: run.id,
            reason: message,
            runtimeMode: run.runtimeMode,
          });
        }
        if (running && !control) {
          await terminateHeartbeatRunProcess({
            pid: running.child.pid,
            processGroupId: running.processGroupId,
            graceMs: Math.max(1, running.graceSec) * 1000,
          });
        }
      } finally {
        if (!control && runningProcesses.get(run.id) === running) runningProcesses.delete(run.id);
      }

      const persistedCancellationResult =
        run.runtimeMode === "native"
          ? await getRun(run.id).then((current) =>
              parseObject(current?.resultJson),
            )
          : parseObject(run.resultJson);

      const interruptedStatus = await setRunStatusIfRunning(
        run.id,
        "interrupted",
        {
          finishedAt: now,
          error: message,
          errorCode: "server_shutdown_interrupted",
          signal,
          resultJson: mergeRunStopMetadataForAgent(agent, "interrupted", {
            conversationContinuationEligible: await runUsedConversationAdapter(db, run),
            resultJson: persistedCancellationResult,
            errorCode: "server_shutdown_interrupted",
            errorMessage: message,
          }),
        },
      );
      if (!interruptedStatus.updated || !interruptedStatus.run) {
        // A competing terminal write does not prove the owned adapter settled.
        if (control) {
          control.controller.abort(new Error(message));
          try {
            await waitForAdapterStop(control.settled, Math.max(1, settlementDeadline.getTime() - Date.now()));
            await finishLegacyShutdownWorkspaceSettlement(db, run);
          } catch { /* The durable fence retains this source after controller loss. */ }
        }
        return;
      }
      let interrupted = interruptedStatus.run;
      if (control) {
        // Keep the exact lease open while its adapter stops the provider and
        // copies files back. Provider release closes command admission and
        // must not race the adapter's git export or instruction collection.
        control.controller.abort(new Error(message));
        try {
          await waitForAdapterStop(control.settled, Math.max(1, settlementDeadline.getTime() - Date.now()), {
            runId: run.id, adapterType: agent.adapterType, runtimeMode: run.runtimeMode,
            abortRequested: true,
          }, control);
          await finishLegacyShutdownWorkspaceSettlement(db, run);
        } catch {
          logger.warn({ runId: run.id }, "Shutdown adapter settlement timed out; retaining the sandbox through normal cleanup");
          const [sandbox] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
            eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
            eq(environmentLeases.status, "active"), ne(environmentLeases.provider, "local"),
            or(sql`${environmentLeases.metadata}->>'driver' = 'sandbox'`,
              sql`${environmentLeases.metadata}->>'sandboxProviderPlugin' = 'true'`),
          )).limit(1);
          if (sandbox) {
            // An unjoined restore cannot certify saved files. Record the exact
            // stop-only sources and repair hold before provider cleanup starts.
            const current = await getRun(run.id, { includeExecutionEvidence: true });
            if (current) {
              const preserved = await terminalizeLegacyExecution({ db, run: current, status: current.status,
                recordRestoreFailureOnly: true, patch: { resultJson: { workspaceRestoreFailure: "restore_failed" } } });
              if (preserved) await finishLegacyShutdownWorkspaceSettlement(db, run, "expired");
            }
          }
          if (runningProcesses.get(run.id) === running && running) {
            await terminateHeartbeatRunProcess({ pid: running.child.pid, processGroupId: running.processGroupId,
              graceMs: Math.max(1, running.graceSec) * 1000 });
            if (runningProcesses.get(run.id) === running) runningProcesses.delete(run.id);
          }
        }
        // Settlement can save restore-failure evidence after the shutdown CAS.
        // Classification and retry must use the current row, not its snapshot.
        interrupted = (await getRun(run.id, { includeExecutionEvidence: true })) ?? interrupted;
      }
      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt: now,
        error: null,
      });
      interrupted =
        (await classifyAndPersistRunLiveness(
          interrupted,
          parseObject(interrupted.resultJson),
        )) ?? interrupted;

      await releaseEnvironmentLeasesForRun({
        runId: interrupted.id,
        companyId: interrupted.companyId,
        agentId: interrupted.agentId,
        status: interrupted.status,
        failureReason: interrupted.error ?? undefined,
      });

      const retry = await enqueueProcessLossRetry(interrupted, agent, now);
      if (!retry) {
        await releaseIssueExecutionAndPromote(interrupted);
      } else {
        retryRunIds.push(retry.id);
      }

      await appendRunEvent(interrupted, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message,
        payload: {
          signal,
          ...(run.processPid ? { processPid: run.processPid } : {}),
          ...(run.processGroupId ? { processGroupId: run.processGroupId } : {}),
          ...(retry ? { retryRunId: retry.id } : {}),
        },
      });

      await finalizeAgentStatus(run.agentId, "interrupted", message, {
        wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run),
      });
      interruptedRunIds.push(interrupted.id);
    }));
    for (const [index, settlement] of settlements.entries()) {
      if (settlement.status === "rejected") logger.warn({ runId: activeRuns[index]!.run.id,
        errorKind: "shutdown_settlement_failed" }, "Shutdown settlement failed; durable cleanup protection remains in place");
    }

    if (interruptedRunIds.length > 0) {
      logger.warn(
        {
          signal,
          interrupted: interruptedRunIds.length,
          interruptedRunIds,
          retryRunIds,
        },
        "interrupted running heartbeat runs for graceful shutdown",
      );
    }

    return {
      interrupted: interruptedRunIds.length,
      interruptedRunIds,
      retryRunIds,
      restartSuspendedRunIds,
    };
  }

  // Clamp the stored attempt count to the range [0, cap]. The SQL reader
  // `pendingCleanupAttemptsSql` clamps to the same range, so both readers yield
  // the same value for every input. The claim predicate compares the two values,
  // so this alignment lets the claim match for a malformed lease.
  function readPendingCleanupRetryAttempts(
    metadata: Record<string, unknown>,
  ): number {
    const value = metadata[PENDING_CLEANUP_ATTEMPTS_METADATA_KEY];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      return 0;
    return Math.min(Math.floor(value), PENDING_CLEANUP_SWEEP_ATTEMPT_CAP);
  }

  // Atomically claim one retry attempt on a pending_cleanup lease. The update
  // only matches when the lease is still pending_cleanup and its stored attempt
  // count still equals `expectedAttempts`. Two concurrent sweeps read the same
  // count, but Postgres serializes the two updates on the row and only the first
  // matches the guard. The loser gets zero rows and skips the lease. The persisted in-flight deadline also prevents a later tick
  // from starting another attempt while this one is still running.
  // Returns the attempt identity only for the sweep that won the claim.
  //
  // The update patches cleanup ownership fields without writing a copied
  // metadata object, so a concurrent write to an unrelated metadata key
  // survives. The guard reads the stored count through the safe SQL reader, so a
  // malformed value never throws.
  async function claimPendingCleanupRetryAttempt(
    leaseId: string,
    expectedAttempts: number,
    manualAttempt?: { previousId: unknown },
  ): Promise<string | null> {
    const now = new Date();
    const attemptId = randomUUID();
    const claimed = await db
      .update(environmentLeases)
      .set({
        metadata: sql`jsonb_set(${pendingCleanupMetadataObjectSql()}, array[${PENDING_CLEANUP_ATTEMPTS_METADATA_KEY}], to_jsonb(${expectedAttempts + 1}::int), true)
          || ${JSON.stringify({ ...(manualAttempt ? { pendingCleanupManualAttemptId: randomUUID() } : {}),
            pendingCleanupAttemptId: attemptId, pendingCleanupInFlight: true,
            pendingCleanupLeaseExpiresAtMs: Date.now() + 15 * 60_000,
          })}::jsonb`,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(environmentLeases.id, leaseId),
          eq(environmentLeases.status, "pending_cleanup"),
          sql`${pendingCleanupAttemptsSql()} = ${expectedAttempts}`,
          manualAttempt ? sql`coalesce(${environmentLeases.metadata}->'pendingCleanupManualAttemptId', 'null'::jsonb) is not distinct from ${JSON.stringify(manualAttempt.previousId ?? null)}::jsonb` : undefined,
          pendingCleanupRetryDueSql(Boolean(manualAttempt)),
        ),
      )
      .returning({ id: environmentLeases.id });
    return claimed.length > 0 ? attemptId : null;
  }

  // Atomically claim the one-time cap warning for a lease. The update only
  // matches when the lease is still pending_cleanup, its stored attempt count is
  // at or above the cap, and it has not yet carried the warned flag. Two
  // concurrent sweeps that both reach the cap race here, but only one update
  // sets the flag and returns a row. The loser skips the warning. This keeps the
  // warning to one log line per lease.
  //
  // The status and cap predicates are the last line of defense. They stop a warn
  // flag write to a lease that left pending_cleanup or dropped below the cap
  // between the read and this claim. The update writes only the warned key with
  // `jsonb_set`, so a concurrent write to an unrelated metadata key survives.
  async function claimPendingCleanupCapWarning(
    leaseId: string,
  ): Promise<boolean> {
    const now = new Date();
    const claimed = await db
      .update(environmentLeases)
      .set({
        metadata: sql`jsonb_set(${pendingCleanupMetadataObjectSql()}, array[${PENDING_CLEANUP_CAP_WARNED_METADATA_KEY}], to_jsonb(true), true)`,
        updatedAt: now,
      })
      .where(
        and(
          eq(environmentLeases.id, leaseId),
          eq(environmentLeases.status, "pending_cleanup"),
          sql`${pendingCleanupAttemptsSql()} >= ${PENDING_CLEANUP_SWEEP_ATTEMPT_CAP}`,
          sql`${pendingCleanupCapWarnedSql()} = false`,
        ),
      )
      .returning({ id: environmentLeases.id });
    return claimed.length > 0;
  }

  // Defer a pending_cleanup lease whose provider plugin is not ready this tick.
  // The sweep reads one page of the oldest rows, ordered by `updatedAt`. A lease
  // that the sweep only skips keeps its old `updatedAt`, so it stays the oldest
  // and refills the page on every tick. That starves a newer lease whose
  // provider is ready. The defer bumps `updatedAt` to now, so the unavailable
  // lease moves to the back of the queue and a ready lease takes its page slot.
  // The defer never writes the attempt count, so a long provider outage never
  // consumes a finite retry. The status guard keeps the write on a lease that is
  // still pending_cleanup.
  async function deferPendingCleanupLease(leaseId: string): Promise<void> {
    const now = new Date();
    await db
      .update(environmentLeases)
      .set({ updatedAt: now })
      .where(
        and(
          eq(environmentLeases.id, leaseId),
          eq(environmentLeases.status, "pending_cleanup"),
        ),
      );
  }

  // Move a guarded orphan candidate to the back of the sweep order. The
  // shared-resource guard below can skip a row on every tick as long as the
  // other owner stays live, retained, or pending cleanup. The select orders
  // by `updatedAt` ascending and takes only the oldest page, so an untouched
  // skipped row keeps refilling that same page and blocks every row behind
  // it. The bump pushes the row past the fixed-size page, so the next tick
  // reaches the rows behind it. It costs the row one extra backoff wait,
  // which is safe because the guard means a physical sandbox still exists.
  async function deferOrphanedActiveLease(leaseId: string): Promise<void> {
    const now = new Date();
    await db
      .update(environmentLeases)
      .set({ updatedAt: now })
      .where(
        and(
          eq(environmentLeases.id, leaseId),
          eq(environmentLeases.status, "active"),
        ),
      );
  }

  // An active lease is reachable only while its heartbeat run keeps the
  // running status. The reaper writes the run status and the lease release as
  // two separate statements, so a restart between them can leave a terminal
  // run and an active lease. `releaseRunLeases` also skips a lease whose
  // environment row is gone, so that lease stays active too. No later query
  // finds either lease, because every production query selects an active
  // lease by its environment or by its heartbeat run id, never by age. This
  // sweep finds both stranded classes and moves each lease to pending_cleanup,
  // so the existing pending_cleanup sweep tears the sandbox down from the
  // data already on the lease row.
  async function sweepOrphanedActiveLeases(opts: {
    backoffMs: number;
  }): Promise<{ recovered: number }> {
    const cutoff = new Date(Date.now() - opts.backoffMs);

    const rows = await db
      .select({ lease: environmentLeases })
      .from(environmentLeases)
      .leftJoin(
        heartbeatRuns,
        eq(environmentLeases.heartbeatRunId, heartbeatRuns.id),
      )
      .where(
        and(
          eq(environmentLeases.status, "active"),
          or(
            isNull(environmentLeases.heartbeatRunId),
            inArray(heartbeatRuns.status, [
              ...HEARTBEAT_RUN_TERMINAL_STATUSES,
            ]),
          ),
          lte(environmentLeases.updatedAt, cutoff),
        ),
      )
      .orderBy(asc(environmentLeases.updatedAt))
      .limit(ORPHANED_ACTIVE_LEASE_SWEEP_PAGE_SIZE);

    let recovered = 0;
    for (const { lease } of rows) {
      if (!(await allowLegacyShutdownWorkspaceCleanup(db, lease))) {
        await deferOrphanedActiveLease(lease.id);
        continue;
      }
      // A provider resource id names one physical sandbox. A different lease
      // row can still hold that same resource in a live status, so this sweep
      // must not tear down a sandbox that a different lease still owns.
      if (lease.provider && lease.providerLeaseId) {
        const [otherOwner] = await db
          .select({ id: environmentLeases.id })
          .from(environmentLeases)
          .where(
            and(
              ne(environmentLeases.id, lease.id),
              eq(environmentLeases.provider, lease.provider),
              eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
              inArray(environmentLeases.status, [
                "active",
                "retained",
                "pending_cleanup",
              ]),
            ),
          )
          .limit(1);
        if (otherOwner) {
          // Defer this row so the fixed-size page reaches the rows behind
          // it next tick, instead of re-selecting the same guarded rows
          // forever.
          await deferOrphanedActiveLease(lease.id);
          continue;
        }
      }

      // Keep the row's existing updatedAt value. The select above already
      // proved the row is older than the backoff cutoff, so the
      // pending_cleanup sweep can accept the same row in this same tick. A
      // fresh timestamp here would push the row inside that sweep's own
      // backoff window and delay the teardown by one full tick.
      const flipped = await db
        .update(environmentLeases)
        .set({
          status: "pending_cleanup",
          failureReason: "orphaned_active_lease_recovered",
        })
        .where(
          and(
            eq(environmentLeases.id, lease.id),
            eq(environmentLeases.status, "active"),
          ),
        )
        .returning({ id: environmentLeases.id });
      if (flipped.length > 0) recovered += 1;
    }

    return { recovered };
  }

  // Retry the leases stranded in "pending_cleanup". A failed destroy leaves a
  // lease in that state forever without this sweep. The reaper tick runs the
  // sweep. The backoff equals the reaper staleness threshold, so a lease waits
  // for that period between attempts. The sweep reads and writes the attempt
  // count in the lease metadata. It warns once when a lease reaches the attempt
  // threshold, then continues with slower retries. Live attempts renew their
  // cleanup claim; after controller loss, exact-resource destruction may repeat.
  async function sweepPendingCleanupLeases(opts?: {
    backoffMs?: number;
    /** One cleanup attempt per explicit user Retry, for this failed run only.
     * A later user Retry may bypass the cooldown after a provider failure,
     * but cannot take over an in-flight cleanup attempt.
     */
    explicitRetry?: { companyId: string; runId: string; actorId: string; reason?: "retry_failed_run" | "queued_comment_interrupt" };
  }): Promise<{
    swept: number;
    destroyed: number;
    capped: number;
  }> {
    const backoffMs = opts?.backoffMs ?? 0;
    const now = new Date();
    const cutoff = new Date(now.getTime() - backoffMs);

    // Flush the in-process orphan-cleanup buffer first. A failed acquire buffers
    // an orphan there when every synchronous pending-cleanup write failed after a
    // failed teardown. The flush re-inserts each buffered record, so a durable
    // `pending_cleanup` row lands once the database recovers. The flush runs
    // before the read below, so this same tick tears down a freshly-landed row.
    try {
      const flushed = opts?.explicitRetry ? null : await environmentRuntime.flushDeferredOrphanCleanups?.();
      if (flushed && (flushed.recovered > 0 || flushed.pending > 0)) {
        logger.info(
          { recovered: flushed.recovered, pending: flushed.pending },
          "flushed the in-process orphan sandbox cleanup buffer to the database",
        );
      }
    } catch {
      // A flush failure never stops the sweep. The buffer keeps the orphan for a
      // later tick, and the database rows below still need this sweep. The caught
      // exception never enters the log, because a write error can carry a
      // credential in its message, code, cause, or stack.
      logger.warn(
        "orphan sandbox cleanup buffer flush failed; the sweep continues",
      );
    }

    const rows = await db
      .select()
      .from(environmentLeases)
      .where(
        and(
          eq(environmentLeases.status, "pending_cleanup"),
          opts?.explicitRetry ? eq(environmentLeases.companyId, opts.explicitRetry.companyId) : undefined,
          opts?.explicitRetry ? eq(environmentLeases.heartbeatRunId, opts.explicitRetry.runId) : undefined,
          pendingCleanupRetryDueSql(Boolean(opts?.explicitRetry)),
          backoffMs > 0 ? lte(environmentLeases.updatedAt, cutoff) : undefined,
        ),
      )
      .orderBy(asc(environmentLeases.updatedAt))
      .limit(PENDING_CLEANUP_SWEEP_PAGE_SIZE);

    let destroyed = 0;
    let capped = 0;
    for (const row of rows) {
      if (pendingCleanupAttemptsInFlight.has(row.id)) continue;
      if (!(await allowLegacyShutdownWorkspaceCleanup(db, row))) {
        await deferPendingCleanupLease(row.id);
        continue;
      }
      const metadata = { ...(row.metadata ?? {}) } as Record<string, unknown>;
      const attempts = readPendingCleanupRetryAttempts(metadata);

      const environment = row.environmentId
        ? await environmentsSvc.getById(row.environmentId)
        : null;
      const lease = await environmentsSvc.getLeaseById(row.id);
      if (!lease) continue;

      // An orphan ephemeral lease keeps its provider, its provider lease id, and
      // its sandbox config in the lease row. A failed acquire records it, and its
      // environment row may be gone or foreign-bound. A reuse_by_environment lease
      // whose environment a delete removed keeps the same recorded data, because
      // the schema sets the environment reference to null on delete and preserves
      // the row. Both leases tear down from the recorded lease data through
      // `retryPendingSandboxTeardown`, which never reads the environment row. So
      // the sweep uses that path whenever the lease is an orphan ephemeral lease
      // or its environment row is gone. A reuse_by_environment lease whose
      // environment still exists tears down through `destroyRunLease`. That
      // path uses the provider and configuration recorded on the lease first;
      // the environment is lifecycle context and only a legacy fallback.
      const isOrphanEphemeralLease = lease.leasePolicy === "ephemeral";
      const useRecordedTeardown = isOrphanEphemeralLease || !environment || hasStopOnlyCleanup(lease);

      // Do not consume a finite cleanup attempt while the provider plugin is
      // briefly unavailable. A plugin worker restart, a plugin reload, or a
      // plugin reinstall makes the provider unavailable for a short window. The
      // plugin can be missing or not ready in that window. A teardown then throws,
      // and the atomic claim below would count that throw against the cap, so a
      // long restart or reload could exhaust the retries and strand a live
      // sandbox. So probe the provider first, and defer the lease this tick when
      // the provider is not ready. The sweep preserves the pending_cleanup row,
      // and a later sweep retries after the provider recovers. The probe reports
      // ready only for a permanent condition (a missing provider string, a
      // built-in provider, or no worker manager), so a genuine teardown failure
      // still runs, throws, and counts toward the cap. A runtime with no probe
      // method treats the lease as ready, so the sweep keeps its earlier
      // behavior.
      const workerReady = environmentRuntime.isPendingCleanupWorkerReady
        ? await environmentRuntime.isPendingCleanupWorkerReady({
            environment,
            lease,
          })
        : true;
      if (!workerReady) {
        // Move the unavailable lease to the back of the sweep queue. Otherwise
        // the oldest unavailable rows refill the page on every tick and starve a
        // newer lease that has a ready provider. The defer bumps `updatedAt`
        // only, so it consumes no finite retry attempt.
        await deferPendingCleanupLease(row.id);
        continue;
      }

      // Atomically claim the attempt before the retry. Only the winning sweep
      // increments the count and tears the sandbox down, so an overlapping sweep
      // cannot start another attempt while this one holds the cleanup lease.
      // The deadline survives a server restart; the counter saturates at the
      // escalation threshold while attempt identities remain unique.
      const claimed = await claimPendingCleanupRetryAttempt(row.id, attempts,
        opts?.explicitRetry ? { previousId: metadata.pendingCleanupManualAttemptId } : undefined);
      if (!claimed) continue;
      pendingCleanupAttemptsInFlight.add(row.id);
      lease.metadata = { ...lease.metadata, pendingCleanupAttemptId: claimed };
      let activeRenewal: Promise<void> | null = null;
      const renewal = setInterval(() => {
        if (activeRenewal) return;
        activeRenewal = db.update(environmentLeases).set({
          metadata: sql`jsonb_set(${pendingCleanupMetadataObjectSql()}, '{pendingCleanupLeaseExpiresAtMs}', to_jsonb(${Date.now() + 15 * 60_000}::bigint))`,
        }).where(and(eq(environmentLeases.id, row.id), eq(environmentLeases.status, "pending_cleanup"),
          sql`${environmentLeases.metadata}->>'pendingCleanupAttemptId' = ${claimed}`,
          sql`${environmentLeases.metadata}->>'pendingCleanupInFlight' = 'true'`))
          .then(() => {})
          .catch(() => logger.warn({ leaseId: row.id }, "cleanup ownership renewal failed"))
          .finally(() => { activeRenewal = null; });
      }, 30_000);
      renewal.unref();

      try {
        if (opts?.explicitRetry) await logActivity(db, {
          companyId: row.companyId, actorType: "user", actorId: opts.explicitRetry.actorId,
          action: "environment_lease.cleanup_retried", entityType: "environment_lease", entityId: row.id,
          runId: opts.explicitRetry.runId, details: { attempt: attempts + 1, reason: opts.explicitRetry.reason ?? "retry_failed_run" },
        });
        if (useRecordedTeardown) {
          // Tear the sandbox down from the recorded provider config and the
          // cleanup-authorized secret versions. Preserve any provider receipt;
          // a completed retry must grant the same evidence as initial cleanup.
          const receipt = await environmentRuntime.retryPendingSandboxTeardown({
            environment,
            lease,
          });
          const released = hasStopOnlyCleanup(lease)
            ? await settleStopOnlyCleanup(db, lease, { attemptId: claimed, receipt })
            : await environmentsSvc.releaseLease(lease.id, "expired", {
            expectedPendingCleanupAttemptId: claimed,
            cleanupStatus: "success",
            failureReason: "pending_cleanup_retry",
            remoteExecutionTermination: remoteTerminationReceipt(lease, receipt),
          });
          if (released) destroyed += 1;
        } else if (environment) {
          const result = await environmentRuntime.destroyRunLease({
            environment,
            lease,
            failureReason: "pending_cleanup_retry",
          });
          if (result && result.status !== "pending_cleanup") {
            destroyed += 1;
          }
        }
      } catch {
        // The recorded-data teardown throws on failure, so revert the lease to
        // pending_cleanup for a later sweep. The claimed attempt still counts
        // for backoff, so requests stay bounded. The `destroyRunLease`
        // path reverts the lease itself, so this revert only runs for the
        // recorded-data teardown path.
        if (useRecordedTeardown) {
          await environmentsSvc.releaseLease(lease.id, "pending_cleanup", {
            expectedPendingCleanupAttemptId: claimed,
            cleanupStatus: "failed",
            failureReason: "pending_cleanup_retry",
          });
        }
        // Log a constant errorKind only. The exception can carry a credential in
        // its name, code, message, cause, or stack, so the sweep never reads it.
        logger.warn(
          {
            errorKind: PENDING_CLEANUP_RETRY_ERROR_KIND,
            leaseId: row.id,
            environmentId: row.environmentId,
            attempts: attempts + 1,
          },
          "pending_cleanup lease retry failed",
        );
      } finally {
        clearInterval(renewal);
        // A hung renewal must not retain process-local cleanup ownership.
        // Late renewals are attempt-fenced and never write the retry cooldown.
        pendingCleanupAttemptsInFlight.delete(row.id);
      }
      if (attempts + 1 >= PENDING_CLEANUP_SWEEP_ATTEMPT_CAP) {
        capped += 1;
        // Warn once, then continue automatic cleanup with backoff. The atomic claim
        // keeps the warning to one log line even when two sweeps overlap.
        if (metadata[PENDING_CLEANUP_CAP_WARNED_METADATA_KEY] !== true) {
          const warned = await claimPendingCleanupCapWarning(row.id);
          if (warned) {
            logger.warn(
              { leaseId: row.id, environmentId: row.environmentId, attempts },
              "environment lease needs operator attention; automatic cleanup continues with backoff",
            );
          }
        }
      }
      // Persist the cooldown independently of process memory. A crash before
      // this write leaves the bounded in-flight lease for a later sweep.
      await db.update(environmentLeases).set({
        metadata: sql`${pendingCleanupMetadataObjectSql()} || ${JSON.stringify({
          pendingCleanupInFlight: false,
          pendingCleanupRetryAfterMs: Date.now() + (attempts + 1 >= PENDING_CLEANUP_SWEEP_ATTEMPT_CAP
            ? 30 * 60_000 : Math.min(30 * 60_000, Math.max(30_000, backoffMs))),
        })}::jsonb`,
      }).where(and(eq(environmentLeases.id, lease.id),
        sql`${environmentLeases.metadata}->>'pendingCleanupAttemptId' = ${claimed}`));
      if (lease.heartbeatRunId) {
        // Delivery failure must not revert successful provider cleanup. A new
        // message can still use the persisted receipt on its next admission.
        await (async () => {
          await acknowledgeRemoteStop(lease.heartbeatRunId!, lease.companyId);
          const run = await getRun(lease.heartbeatRunId!);
          if (run) await resumeRemoteStopComments(run);
        })().catch(() => logger.warn({ leaseId: lease.id }, "could not reconsider messages after cleanup retry"));
      }
    }

    return { swept: rows.length, destroyed, capped };
  }

  async function markNativeOwnershipUnverified(
    run: typeof heartbeatRuns.$inferSelect,
    evidence: {
      reason:
        | "live_process_identifier"
        | "observed_owner_unverified"
        | "adopted_runner_authentication_timeout"
        | "native_chat_workspace_scope_mismatch";
      processPidAlive?: boolean;
      processGroupAlive?: boolean;
    },
  ) {
    const durableOwnershipHold =
      evidence.reason === "adopted_runner_authentication_timeout" ||
      evidence.reason === "native_chat_workspace_scope_mismatch";
    if (
      run.errorCode === NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE &&
      run.error === NATIVE_OWNERSHIP_UNVERIFIED_MESSAGE &&
      (!durableOwnershipHold || isNativeRunnerOwnershipHeld(run))
    )
      return run;
    const blockedStatus = run.status === "failed" ? "failed" : "running";
    const blockedWrite = await setRunStatusFromLive(
      run.id,
      blockedStatus,
      [blockedStatus],
      {
        error: NATIVE_OWNERSHIP_UNVERIFIED_MESSAGE,
        errorCode: NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
        ...(durableOwnershipHold
          ? {
              nativePhase: "terminal_failure",
              nativePhaseUpdatedAt: new Date(),
            }
          : {}),
      },
    );
    if (!blockedWrite.updated || !blockedWrite.run) {
      return blockedWrite.run ?? run;
    }
    const blocked = blockedWrite.run;
    await appendRunEvent(blocked, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: NATIVE_OWNERSHIP_UNVERIFIED_MESSAGE,
      payload: {
        reason: evidence.reason,
        ...(evidence.processPidAlive === true ? { processPidAlive: true } : {}),
        ...(evidence.processGroupAlive === true
          ? { processGroupAlive: true }
          : {}),
      },
    });
    return blocked;
  }

  async function settleRecoveredNativeWorkspace(input: {
    runId: string;
    companyId: string;
    agentId: string;
    succeeded: boolean;
  }) {
    const settledRun = await getRun(input.runId);
    const workspaceSyncReference = readNativeWorkspaceSyncReference(
      parseObject(settledRun?.runnerProfileJson).nativeWorkspaceSync,
    );
    await releaseEnvironmentLeasesForRun({
      runId: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: settledRun?.status,
      failureReason: settledRun?.error ?? undefined,
      providerResourceDisposition: input.succeeded && (!parseObject(settledRun?.resultJson).workspaceExportRetry || workspaceSyncReference?.resourceDisposition === "destroy")
        ? (workspaceSyncReference?.resourceDisposition ?? "stop_and_retain")
        : "stop_and_retain",
    });
    await releaseRuntimeServicesForRun(input.runId).catch(() => undefined);
    await finalizeAgentStatus(
      input.agentId,
      input.succeeded ? "succeeded" : "failed",
      input.succeeded
        ? null
        : (settledRun?.error ?? "native_workspace_sync_out_failed"),
      {
        wasFirstHeartbeat: settledRun
          ? timerClaimWasFirstHeartbeat(settledRun)
          : undefined,
      },
    ).catch(() => undefined);
  }

  function scheduleRetainedNativeSessionCleanup() {
    // The per-database sweep joins startup and periodic callers. One bounded
    // control-only repair must not hold up unrelated provider ingress or the
    // entire orphan reaper, but shutdown must still await its physical owner.
    const cleanup = reconcileRetainedNativeSessionCleanups(db, {
      cleanup: (input) => reconcileRetainedNativeSessionCleanup(db, input),
      onError: (error, runId) => {
        logger.warn(
          { err: error, runId },
          "retained native session cleanup failed",
        );
      },
    })
      .then(() => undefined)
      .catch((error) => {
        logger.warn({ err: error }, "retained native cleanup discovery failed");
      })
      // The bounded maintenance attempt may fail before an already-started
      // database callback settles. Keep shutdown ownership until the original
      // operations finish; their timeout cannot authorize closing the database.
      .finally(() => drainRetainedRunnerdMaintenanceOperations());
    activeRunExecutionPromises.add(cleanup);
    void cleanup.finally(() => activeRunExecutionPromises.delete(cleanup));
  }

  async function reapOrphanedRuns(opts?: { staleThresholdMs?: number }) {
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const now = new Date();
    // Recovery never launches a provider or infers stopped ownership from
    // terminal status. Uncaptured local copies require durable stop evidence.
    await instructionCopies.recoverStopped().catch(error => {
      logger.warn({ err: error }, "failed to recover stopped instruction copies");
    });
    await instructionCopies.recoverCaptured().catch(error => {
      logger.warn({ err: error }, "failed to retry captured instruction revisions");
    });

    // Complete persisted native results before generic orphan recovery. The
    // reconciler reads the durable workspace barrier and persisted runtime
    // mode, never the current feature flag.
    await reconcileNativeFinalizations(db, undefined, {
      environmentRuntime,
      onWorkspaceSettled: settleRecoveredNativeWorkspace,
    }).catch((error) => {
      logger.warn(
        { err: error },
        "failed to reconcile persisted native finalizations before orphan reaping",
      );
    });
    scheduleRetainedNativeSessionCleanup();
    await dispatchPendingNativeStatusWakeups().catch((error) => {
      logger.warn(
        { err: error },
        "failed to dispatch persisted native status wake intents before orphan reaping",
      );
    });

    // A retryable native run can retain process identifiers from the failed
    // attempt. Inspect them before the recovery claim: a live identifier is
    // unowned and blocks recovery, while identifiers that are all dead can be
    // cleared with a compare-and-set so the explicit retryable failure becomes
    // claimable in this same sweep.
    const retryableNativeProcesses = await db
      .select({ run: heartbeatRuns })
      .from(heartbeatRuns)
      .innerJoin(
        nativeRunFinalizations,
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      )
      .where(
        and(
          inArray(heartbeatRuns.status, ["running", "failed"]),
          eq(heartbeatRuns.runtimeMode, "native"),
          eq(nativeRunFinalizations.phase, "retryable_failure"),
          isNull(nativeRunFinalizations.resultId),
        ),
      );
    const claimableNativeRunIds = new Set<string>();
    for (const { run } of retryableNativeProcesses) {
      if (isNativeRunnerOwnershipHeld(run)) continue;
      if (!run.processPid && !run.processGroupId) {
        claimableNativeRunIds.add(run.id);
        continue;
      }
      const processPidAlive =
        !!run.processPid && isProcessAlive(run.processPid);
      const processGroupAlive =
        !!run.processGroupId && isProcessGroupAlive(run.processGroupId);
      if (processPidAlive || processGroupAlive) {
        await markNativeOwnershipUnverified(run, {
          reason: "live_process_identifier",
          processPidAlive,
          processGroupAlive,
        });
        continue;
      }
      const cleared = await db.transaction(async tx => {
        const cleared = await tx
          .update(heartbeatRuns)
          .set({
            processPid: null,
            processGroupId: null,
            processStartedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(heartbeatRuns.id, run.id),
              eq(heartbeatRuns.runtimeMode, "native"),
              run.processPid === null
                ? isNull(heartbeatRuns.processPid)
                : eq(heartbeatRuns.processPid, run.processPid),
              run.processGroupId === null
                ? isNull(heartbeatRuns.processGroupId)
                : eq(heartbeatRuns.processGroupId, run.processGroupId),
              run.processStartedAt === null
                ? isNull(heartbeatRuns.processStartedAt)
                : eq(heartbeatRuns.processStartedAt, run.processStartedAt),
            ),
          )
          .returning({ id: heartbeatRuns.id })
          .then((rows) => rows[0] ?? null);
        if (cleared) await recordNativeLocalProcessStop(tx as unknown as Db, run);
        return cleared;
      });
      if (cleared) claimableNativeRunIds.add(cleared.id);
    }

    // An explicit result-less retryable failure resumes on the original run.
    // The database lease is claimed before dispatch so concurrent service
    // instances cannot open competing recoveries; executeRun receives the exact
    // claimed owner. Expired `observed` ownership never enters this set.
    const nativeResumeClaims =
      claimableNativeRunIds.size === 0
        ? []
        : await dispatchNativeSessionResumptions({
            db,
            runnerInstanceId:
              runtimeEnv.PAPERCLIP_INSTANCE_ID?.trim() || "paperclip-heartbeat",
            now,
            runIds: [...claimableNativeRunIds],
            dispatch: (claim) => {
              const execution = executeRun(claim.runId, {
                nativeLeaseOwner: claim.leaseOwner,
              }).catch((error) => {
                logger.error(
                  { err: error, runId: claim.runId },
                  "persisted native session resume failed",
                );
              });
              activeRunExecutionPromises.add(execution);
              void execution.finally(() =>
                activeRunExecutionPromises.delete(execution),
              );
            },
          }).catch((error) => {
            logger.warn(
              { err: error },
              "failed to claim persisted native session resumptions",
            );
            return [];
          });
    const resumedRunIds = new Set(
      nativeResumeClaims.map((claim) => claim.runId),
    );

    // A terminal issue transition writes this intent in the same transaction
    // that closes the question's task, even when its card is retained. Consume
    // it before generic orphan recovery so a restart preserves cancellation.
    const cancellationRequests = await db
      .select({
        id: heartbeatRuns.id,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.status, [
            ...CANCELLABLE_HEARTBEAT_RUN_STATUSES,
          ]),
          sql`${heartbeatRuns.contextSnapshot} -> ${NATIVE_QUESTION_CANCELLATION_CONTEXT_KEY} is not null`,
        ),
      );
    for (const request of cancellationRequests) {
      const marker = parseObject(
        parseObject(request.contextSnapshot)[
          NATIVE_QUESTION_CANCELLATION_CONTEXT_KEY
        ],
      );
      const issueId = readNonEmptyString(marker.issueId);
      const issueStatus = readNonEmptyString(marker.issueStatus);
      const interactionId = readNonEmptyString(marker.interactionId);
      const kind = readNonEmptyString(marker.kind);
      const reason =
        kind === "interaction_withdrawn"
          ? "Question withdrawn while waiting for operator input"
          : kind === "interaction_cancelled"
            ? "Cancelled while waiting for operator input"
            : "Task closed while waiting for operator input";
      try {
        await cancelRunInternal(request.id, reason, {
          resultJson: {
            ...(kind === "interaction_withdrawn" && interactionId
              ? { withdrawnInteractionId: interactionId }
              : {}),
            ...(kind === "interaction_cancelled" && interactionId
              ? { cancelledInteractionId: interactionId }
              : {}),
            ...((!kind || kind === "issue_terminal") && issueStatus
              ? { cancelledByIssueStatus: issueStatus }
              : {}),
            ...(issueId ? { cancelledIssueId: issueId } : {}),
          },
        });
      } catch (err) {
        // Keep the marker intact for the next startup/periodic sweep.
        logger.warn(
          { err, runId: request.id },
          "native question cancellation recovery attempt failed",
        );
      }
    }

    // Find all runs stuck in "running" state (queued runs are legitimately waiting; resumeQueuedRuns handles them)
    const activeRuns = await db
      .select({
        run: heartbeatRuns,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
        nativeCoordinatorPhase: nativeRunFinalizations.phase,
        nativeRecoveryState: nativeRunFinalizations.recoveryState,
        nativeControllerBootId: nativeRunFinalizations.controllerBootId,
        nativeControllerPid: nativeRunFinalizations.controllerPid,
        nativeControllerProcessStartedAt:
          nativeRunFinalizations.controllerProcessStartedAt,
        nativeControllerLeaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
        nativeWorkspaceFinalizationPending: pendingNativeWorkspaceFinalizationCondition(db),
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .leftJoin(
        nativeRunFinalizations,
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      )
      .where(eq(heartbeatRuns.status, "running"));

    const monitorIssueIds = [
      ...new Set(
        activeRuns.flatMap(({ run }) => {
          const runContext = parseObject(run.contextSnapshot);
          if (readNonEmptyString(runContext.wakeReason) !== "issue_monitor_due")
            return [];
          const issueId = readNonEmptyString(runContext.issueId);
          return issueId ? [issueId] : [];
        }),
      ),
    ];
    const monitorIssues =
      monitorIssueIds.length > 0
        ? await db
            .select({
              id: issues.id,
              companyId: issues.companyId,
              monitorNextCheckAt: issues.monitorNextCheckAt,
            })
            .from(issues)
            .where(inArray(issues.id, monitorIssueIds))
        : [];
    const monitorNextCheckAtByIssue = new Map(
      monitorIssues.map((issue) => [
        `${issue.companyId}:${issue.id}`,
        issue.monitorNextCheckAt,
      ]),
    );

    const reaped: string[] = [];
    const currentNativeController = await currentNativeControllerIdentity();

    for (const {
      run,
      adapterType,
      adapterConfig,
      nativeCoordinatorPhase,
      nativeRecoveryState,
      nativeControllerBootId,
      nativeControllerPid,
      nativeControllerProcessStartedAt,
      nativeControllerLeaseExpiresAt,
      nativeWorkspaceFinalizationPending,
    } of activeRuns) {
      // Authentication timeout requires an explicit ownership resolution, not
      // repeated reattachment or a process-gone guess on subsequent sweeps.
      if (isNativeRunnerOwnershipHeld(run)) continue;
      // The accepted result, not a missing provider process, owns this suffix.
      // The reconciler above either finishes it, records a bounded failure, or
      // preserves its explicit physical-copyback hold. Keep its source lease.
      if (nativeWorkspaceFinalizationPending) continue;
      const nativeRun = run.runtimeMode === "native";
      const nativeProcessPidAlive =
        nativeRun && !!run.processPid && isProcessAlive(run.processPid);
      const nativeProcessGroupAlive =
        nativeRun &&
        !!run.processGroupId &&
        isProcessGroupAlive(run.processGroupId);
      const coordinatorOwnedByCurrentController =
        nativeRun &&
        nativeControllerBootId === currentNativeController.bootId &&
        nativeControllerPid === currentNativeController.pid &&
        nativeControllerProcessStartedAt?.getTime() ===
          currentNativeController.processStartedAt.getTime() &&
        !!nativeControllerLeaseExpiresAt &&
        nativeControllerLeaseExpiresAt.getTime() > now.getTime();
      const locallyTracked =
        runningProcesses.has(run.id) ||
        activeRunExecutions.has(run.id) ||
        coordinatorOwnedByCurrentController;
      if (
        nativeRun &&
        ([
          "awaiting_evidence",
          "awaiting_runner_reattach",
          "resuming_session",
          "bootstrap_incomplete",
        ].includes(nativeRecoveryState ?? "") ||
          nativeCoordinatorPhase === "retryable_failure")
      ) {
        continue;
      }
      const observedOwnerUnverified =
        nativeRun &&
        (nativeCoordinatorPhase === "observed" ||
          (nativeCoordinatorPhase === null &&
            run.nativePhase === "observed")) &&
        !resumedRunIds.has(run.id) &&
        !locallyTracked;
      // Persisted numeric process identifiers prove only that some process is
      // alive, not that Paperclip still owns it. Likewise an observed native
      // coordinator without a live in-process execution has no durable proof
      // that its prior provider owner stopped. Keep both cases running but
      // blocked: never signal, finalize, or retry them automatically. This gate
      // intentionally precedes resumedRunIds so a claim cannot bypass the
      // ownership check.
      if (
        !locallyTracked &&
        (nativeProcessPidAlive ||
          nativeProcessGroupAlive ||
          observedOwnerUnverified)
      ) {
        await markNativeOwnershipUnverified(run, {
          reason:
            nativeProcessPidAlive || nativeProcessGroupAlive
              ? "live_process_identifier"
              : "observed_owner_unverified",
          processPidAlive: nativeProcessPidAlive,
          processGroupAlive: nativeProcessGroupAlive,
        });
        continue;
      }
      if (resumedRunIds.has(run.id)) continue;
      if (locallyTracked) continue;
      if (await hasLiveLegacyController(db, run)) continue;

      // Apply staleness threshold to avoid false positives
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      const currentAdapterTracksLocalChild =
        isTrackedLocalChildProcessAdapter(adapterType);
      const tracksLegacyLocalChild =
        run.runtimeMode !== "native" && currentAdapterTracksLocalChild;
      // Native runner processes also persist child metadata, but they must not
      // inherit legacy retry or termination authority. Use their PID/group only
      // for a read-only liveness check so a lost in-memory handle cannot cause
      // overlapping provider/tool execution while that child is still alive.
      const checksPersistedChildLiveness =
        currentAdapterTracksLocalChild || run.runtimeMode === "native";
      const processPidAlive =
        checksPersistedChildLiveness &&
        run.processPid &&
        isProcessAlive(run.processPid);
      const processGroupAlive =
        checksPersistedChildLiveness &&
        run.processGroupId &&
        isProcessGroupAlive(run.processGroupId);
      if (
        (processPidAlive || processGroupAlive) &&
        readHotRestartAdoptionMetadata(parseObject(run.resultJson))
      ) {
        continue;
      }
      if (processPidAlive || processGroupAlive) {
        if (run.errorCode !== DETACHED_PROCESS_ERROR_CODE) {
          const detachedMessage = processPidAlive
            ? `Lost in-memory process handle, but child pid ${run.processPid} is still alive`
            : `Lost in-memory process handle, but persisted process group ${run.processGroupId} is still alive`;
          const detachedRun = await setRunStatus(run.id, "running", {
            error: detachedMessage,
            errorCode: DETACHED_PROCESS_ERROR_CODE,
          });
          if (detachedRun) {
            await appendRunEvent(detachedRun, {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: detachedMessage,
              payload: {
                processPid: run.processPid ?? null,
                processGroupId: run.processGroupId ?? null,
                ownedProcessHandle: false,
              },
            });
          }
        }
        continue;
      }

      const runContext = parseObject(run.contextSnapshot);
      const monitorIssueId = readNonEmptyString(runContext.issueId);
      const monitorNextCheckAt = monitorIssueId
        ? monitorNextCheckAtByIssue.get(`${run.companyId}:${monitorIssueId}`)
        : undefined;
      const monitorDispatchLostWithoutFutureWake =
        readNonEmptyString(runContext.wakeReason) === "issue_monitor_due" &&
        monitorNextCheckAt !== undefined &&
        (!monitorNextCheckAt || monitorNextCheckAt.getTime() <= now.getTime());
      const shouldRetry =
        (run.processLossRetryCount ?? 0) < 1 &&
        ((tracksLegacyLocalChild &&
          (!!run.processPid || !!run.processGroupId)) ||
          monitorDispatchLostWithoutFutureWake);
      if (!(await revokeExpiredLegacyController(db, run))) continue;
      const baseMessage = buildProcessLossMessage(run);
      const processLossDiagnostic = buildProcessLossDiagnostic({
        run,
        nowMs: Date.now(),
        observerStartedAtMs: performance.timeOrigin,
        checksPersistedChildLiveness,
        retryEligible: shouldRetry,
      });
      const conversationContinuationEligible = await runUsedConversationAdapter(db, run);

      const failureWrite = await setRunStatusFromLive(
        run.id,
        "failed",
        ["running"],
        {
          error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
          errorCode: "process_lost",
          finishedAt: now,
          resultJson: (() => {
            const result = mergeRunStopMetadataForAgent(
              { adapterType, adapterConfig },
              "failed",
              {
                conversationContinuationEligible,
                resultJson: { ...parseObject(run.resultJson), processLossDiagnostic },
                errorCode: "process_lost",
                errorMessage: shouldRetry
                  ? `${baseMessage}; retrying once`
                  : baseMessage,
              },
            );
            return result;
          })(),
        },
      );
      if (!failureWrite.updated || !failureWrite.run) continue;
      let finalizedRun: typeof heartbeatRuns.$inferSelect | null =
        failureWrite.run;
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
      });
      if (!finalizedRun) finalizedRun = await getRun(run.id);
      if (!finalizedRun) continue;
      finalizedRun =
        (await classifyAndPersistRunLiveness(
          finalizedRun,
          parseObject(finalizedRun.resultJson),
        )) ?? finalizedRun;
      await releaseEnvironmentLeasesForRun({
        runId: finalizedRun.id,
        companyId: finalizedRun.companyId,
        agentId: finalizedRun.agentId,
        status: finalizedRun.status,
        failureReason: finalizedRun.error ?? undefined,
      });

      let retriedRun: typeof heartbeatRuns.$inferSelect | null = null;
      const retryAgent = await getAgent(run.agentId);
      if (shouldRetry) {
        if (retryAgent) {
          retriedRun = await enqueueProcessLossRetry(
            finalizedRun,
            retryAgent,
            now,
          );
        }
      } else if (retryAgent) {
        const scheduled =
          await scheduleInteractionContinuationInfrastructureRetryIfEligible(
            finalizedRun,
            retryAgent,
          );
        retriedRun = scheduled?.outcome === "scheduled" ? scheduled.run : null;
      }

      if (!retriedRun) {
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      await appendRunEvent(finalizedRun, {
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message: shouldRetry
          ? `${baseMessage}; queued retry ${retriedRun?.id ?? ""}`.trim()
          : baseMessage,
        payload: {
          ...(run.processPid ? { processPid: run.processPid } : {}),
          ...(run.processGroupId ? { processGroupId: run.processGroupId } : {}),
          ...(retriedRun ? { retryRunId: retriedRun.id } : {}),
        },
      });

      await finalizeAgentStatus(run.agentId, "failed", baseMessage, {
        wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run),
      });
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
      reaped.push(run.id);
    }

    if (reaped.length > 0) {
      logger.warn(
        { reapedCount: reaped.length, runIds: reaped },
        "reaped orphaned heartbeat runs",
      );
    }

    // Recover an active lease whose run already ended before the same-tick
    // pending_cleanup sweep, so this tick can stop the recovered sandbox.
    // Isolate the sweep so its failure never hides the reaper result.
    try {
      const orphanedActiveLeaseSweep = await sweepOrphanedActiveLeases({
        backoffMs: staleThresholdMs,
      });
      if (orphanedActiveLeaseSweep.recovered > 0) {
        logger.warn(
          { recovered: orphanedActiveLeaseSweep.recovered },
          "recovered orphaned active environment leases",
        );
      }
    } catch {
      // Log a constant errorKind only. The exception can carry a credential in
      // its name, code, message, cause, or stack, so the sweep never reads it.
      logger.error(
        { errorKind: ORPHANED_ACTIVE_LEASE_SWEEP_ERROR_KIND },
        "orphaned active environment lease sweep failed",
      );
    }

    // Retry stranded pending_cleanup leases on the same tick. Isolate the sweep
    // so its failure never hides the reaper result. The backoff equals the
    // reaper staleness threshold.
    try {
      const sweep = await sweepPendingCleanupLeases({
        backoffMs: staleThresholdMs,
      });
      if (sweep.destroyed > 0 || sweep.capped > 0) {
        logger.warn(
          {
            destroyed: sweep.destroyed,
            capped: sweep.capped,
            swept: sweep.swept,
          },
          "swept pending_cleanup environment leases",
        );
      }
    } catch {
      // Log a constant errorKind only. The exception can carry a credential in
      // its name, code, message, cause, or stack, so the sweep never reads it.
      logger.error(
        { errorKind: PENDING_CLEANUP_SWEEP_ERROR_KIND },
        "pending_cleanup lease sweep failed",
      );
    }

    return { reaped: reaped.length, runIds: reaped };
  }

  return {
    sweepPendingCleanupLeases,
    markNativeOwnershipUnverified,
    prepareHotRestartShutdown,
    reconcileHotRestartAdoption,
    recoverNativeRunsAfterRestart,
    reapOrphanedRuns,
    sweepOrphanedActiveLeases,
    drainRunningRunsForShutdown,
  };
}
