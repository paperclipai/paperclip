import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { workspaceOperations } from "@paperclipai/db";
import type { WorkspaceOperation, WorkspaceOperationPhase, WorkspaceOperationStatus } from "@paperclipai/shared";
import { asc, desc, eq, gte, inArray, isNull, lt, or, and } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../log-redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import { getWorkspaceOperationLogStore } from "./workspace-operation-log-store.js";

type WorkspaceOperationRow = typeof workspaceOperations.$inferSelect;

/**
 * Managed runtime control actions. Every one of these mutates the runtime rows and
 * local listeners of a single execution workspace, so only one may be live at a time.
 */
const RUNTIME_CONTROL_ACTIONS = new Set(["start", "stop", "restart", "repair", "run"]);

/**
 * Identity of this server process. A `running` runtime-control operation stamped with a
 * different owner id can only have been left behind by another (now gone) process, which
 * is what makes bounded recovery safe: we never guess about our own live operations.
 */
const RUNTIME_CONTROL_OWNER_ID = randomUUID();

/** How often a live operation refreshes its ownership stamp. */
export const RUNTIME_CONTROL_HEARTBEAT_MS = 10_000;

/**
 * How long an operation may go without a heartbeat before another owner may terminalize
 * it. Deliberately several heartbeat intervals so a slow-but-live start is never stolen.
 */
export const RUNTIME_CONTROL_STALE_AFTER_MS = 60_000;

/**
 * Last-resort ceiling for a managed runtime lifecycle control. Past this the operation is
 * failed by its own owner so it always reaches a terminal state, even when the underlying
 * start hangs on an unresponsive process or provider that keeps the owner alive. Generous
 * enough to cover a cold runtime provision (a full dependency install) on a large repo.
 */
export const RUNTIME_CONTROL_MAX_DURATION_MS = 30 * 60_000;

/**
 * Workspace jobs are operator-authored commands (builds, migrations, test suites) that can
 * legitimately run far longer than a lifecycle control, so they get a much wider ceiling —
 * still finite, so a wedged job cannot hold the workspace forever.
 */
export const WORKSPACE_JOB_MAX_DURATION_MS = 4 * 60 * 60_000;

function defaultRuntimeControlTimeoutMs(action: string | null) {
  if (!action) return null;
  return action === "run" ? WORKSPACE_JOB_MAX_DURATION_MS : RUNTIME_CONTROL_MAX_DURATION_MS;
}

export class WorkspaceOperationTimeoutError extends Error {
  constructor(public readonly timeoutMs: number, action: string | null) {
    super(
      `Managed workspace ${action ?? "runtime"} operation exceeded its ${Math.round(timeoutMs / 1000)}s time budget and was failed so it can be retried or stopped.`,
    );
    this.name = "WorkspaceOperationTimeoutError";
  }
}

type RuntimeControlOwnerStamp = {
  ownerId: string;
  pid: number;
  action: string;
  heartbeatAt: string;
};

function readRuntimeControlAction(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const action = (metadata as Record<string, unknown>).action;
  if (typeof action !== "string" || !RUNTIME_CONTROL_ACTIONS.has(action)) return null;
  return action;
}

function readRuntimeControlOwner(metadata: unknown): RuntimeControlOwnerStamp | null {
  if (!metadata || typeof metadata !== "object") return null;
  const owner = (metadata as Record<string, unknown>).runtimeControlOwner;
  if (!owner || typeof owner !== "object") return null;
  const record = owner as Record<string, unknown>;
  if (typeof record.ownerId !== "string") return null;
  return {
    ownerId: record.ownerId,
    pid: typeof record.pid === "number" ? record.pid : 0,
    action: typeof record.action === "string" ? record.action : "start",
    heartbeatAt: typeof record.heartbeatAt === "string" ? record.heartbeatAt : new Date(0).toISOString(),
  };
}

/**
 * Operation ids this process is actively driving. An operation owned by this process but
 * missing from this set can only be a leftover from a request that died without unwinding,
 * so it is safe to terminalize immediately instead of waiting out the staleness window.
 */
const liveRuntimeControlOperationIds = new Set<string>();

/**
 * Whether the process that stamped an operation is still alive on this host. A dead owner can
 * never heartbeat again, so its operation is recoverable immediately instead of after the
 * staleness window — which is what makes recovery after a crash or restart prompt. Signal 0
 * only probes; it never touches the process.
 */
function ownerProcessIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user: treat it as alive.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Compare-and-swap predicate for an operation's `updated_at`.
 *
 * Postgres stores `timestamptz` at microsecond precision but the driver hands JS a
 * millisecond-precision `Date`, so an `=` against the value we just read never matches a row
 * whose timestamp came from the column's `defaultNow()` — which is exactly the shape of every
 * row a pre-recovery build left behind, i.e. the stranded operations this sweep exists to
 * clear. Matching the millisecond bucket instead is still a true CAS: a concurrent heartbeat
 * writes a `Date` in a different millisecond, so it still wins the row.
 */
function updatedAtUnchanged(updatedAt: Date) {
  return and(
    gte(workspaceOperations.updatedAt, updatedAt),
    lt(workspaceOperations.updatedAt, new Date(updatedAt.getTime() + 1)),
  );
}

export function resetWorkspaceRuntimeControlStateForTests() {
  liveRuntimeControlOperationIds.clear();
}

export function workspaceRuntimeControlOwnerIdForTests() {
  return RUNTIME_CONTROL_OWNER_ID;
}

/**
 * Same-process serialization of managed runtime controls. The durable sweep below is what
 * recovers stranded operations across processes; this in-memory claim is the cheaper first
 * line of defense that rejects an overlapping control in this process before any row is
 * written. Kept from the runtime-lease chain (PAP-17205) and composed with the ownership
 * machinery above: the claim is taken before the operation row exists, so a recovery sweep
 * can never see a live control it is not yet tracking.
 */
const activeRuntimeControls = new Map<string, { action: string; startedAt: Date }>();

export async function runExclusiveWorkspaceRuntimeControl<T>(input: {
  executionWorkspaceId: string;
  action: string;
  run: () => Promise<T>;
}): Promise<T> {
  const active = activeRuntimeControls.get(input.executionWorkspaceId);
  if (active) {
    throw conflict("A managed runtime control operation is already in progress for this execution workspace.", {
      code: "workspace_runtime_control_in_progress",
      executionWorkspaceId: input.executionWorkspaceId,
      activeAction: active.action,
      requestedAction: input.action,
      startedAt: active.startedAt.toISOString(),
      remediation: "Wait for the active operation to reach a terminal state before retrying.",
    });
  }

  const claim = { action: input.action, startedAt: new Date() };
  activeRuntimeControls.set(input.executionWorkspaceId, claim);
  try {
    return await input.run();
  } finally {
    if (activeRuntimeControls.get(input.executionWorkspaceId) === claim) {
      activeRuntimeControls.delete(input.executionWorkspaceId);
    }
  }
}

export function resetWorkspaceRuntimeControlLocksForTests() {
  activeRuntimeControls.clear();
}

function toWorkspaceOperation(row: WorkspaceOperationRow): WorkspaceOperation {
  return {
    id: row.id,
    companyId: row.companyId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    issueId: row.issueId ?? null,
    phase: row.phase as WorkspaceOperationPhase,
    command: row.command ?? null,
    cwd: row.cwd ?? null,
    status: row.status as WorkspaceOperationStatus,
    exitCode: row.exitCode ?? null,
    logStore: row.logStore ?? null,
    logRef: row.logRef ?? null,
    logBytes: row.logBytes ?? null,
    logSha256: row.logSha256 ?? null,
    logCompressed: row.logCompressed,
    stdoutExcerpt: row.stdoutExcerpt ?? null,
    stderrExcerpt: row.stderrExcerpt ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function appendExcerpt(current: string, chunk: string) {
  return `${current}${chunk}`.slice(-4096);
}

function combineMetadata(
  base: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | null | undefined,
) {
  if (!base && !patch) return null;
  return {
    ...(base ?? {}),
    ...(patch ?? {}),
  };
}

export interface WorkspaceOperationRecorder {
  attachExecutionWorkspaceId(executionWorkspaceId: string | null): Promise<void>;
  recordOperation(input: {
    phase: WorkspaceOperationPhase;
    command?: string | null;
    cwd?: string | null;
    metadata?: Record<string, unknown> | null;
    /**
     * Wall-clock ceiling for `run`. On expiry the operation is failed (terminal) and the
     * timeout error is rethrown, so a hung provider can never leave an active operation.
     */
    timeoutMs?: number | null;
    run: (reportProgress: (input: {
      metadata?: Record<string, unknown> | null;
      system?: string | null;
    }) => Promise<void>) => Promise<{
      status?: WorkspaceOperationStatus;
      exitCode?: number | null;
      stdout?: string | null;
      stderr?: string | null;
      system?: string | null;
      metadata?: Record<string, unknown> | null;
    }>;
  }): Promise<WorkspaceOperation>;
}

export function workspaceOperationService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const logStore = getWorkspaceOperationLogStore();

  async function getById(id: string) {
    const row = await db
      .select()
      .from(workspaceOperations)
      .where(eq(workspaceOperations.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? toWorkspaceOperation(row) : null;
  }

  /**
   * Terminalize `running` managed runtime-control operations that no live owner can still
   * be driving, and return the ones that are genuinely still live.
   *
   * Recovery is bounded on both axes: an operation owned by another server process is only
   * reclaimed after {@link RUNTIME_CONTROL_STALE_AFTER_MS} without a heartbeat, and the
   * terminalizing UPDATE is a compare-and-swap on `updated_at`, so an owner that heartbeats
   * concurrently keeps its operation. Only this process's own abandoned operations (owned
   * by us but no longer tracked in-process) are reclaimed without waiting.
   */
  async function sweepRuntimeControlOperations(
    executionWorkspaceId: string | null | undefined,
    options?: { now?: Date; staleAfterMs?: number },
  ) {
    const now = options?.now ?? new Date();
    const staleAfterMs = options?.staleAfterMs ?? RUNTIME_CONTROL_STALE_AFTER_MS;
    const candidates = await db
      .select()
      .from(workspaceOperations)
      .where(
        executionWorkspaceId
          ? and(
              eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId),
              eq(workspaceOperations.status, "running"),
            )
          : eq(workspaceOperations.status, "running"),
      );

    const reconciledIds: string[] = [];
    const live: WorkspaceOperation[] = [];

    for (const candidate of candidates) {
      const action = readRuntimeControlAction(candidate.metadata);
      if (!action) continue;

      const owner = readRuntimeControlOwner(candidate.metadata);
      const lastSignalAt = owner
        ? new Date(owner.heartbeatAt)
        : (candidate.updatedAt ?? candidate.startedAt ?? new Date(0));
      const silentForMs = now.getTime() - lastSignalAt.getTime();

      const ownedByThisProcess = owner?.ownerId === RUNTIME_CONTROL_OWNER_ID;
      const abandonedByThisProcess = ownedByThisProcess && !liveRuntimeControlOperationIds.has(candidate.id);
      const ownedHereAndLive = ownedByThisProcess && liveRuntimeControlOperationIds.has(candidate.id);
      // A previous server process that no longer exists cannot heartbeat again, so its
      // operations are recoverable at once instead of after the staleness window.
      const ownerProcessGone = owner !== null && !ownedByThisProcess && !ownerProcessIsAlive(owner.pid);

      if (ownedHereAndLive) {
        // This process is driving it right now; its own time budget is what terminalizes it.
        live.push(toWorkspaceOperation(candidate));
        continue;
      }
      if (!abandonedByThisProcess && !ownerProcessGone && silentForMs < staleAfterMs) {
        live.push(toWorkspaceOperation(candidate));
        continue;
      }

      const finishedAt = new Date();
      const reconciliationMessage =
        `Reconciled stale managed runtime ${action} operation: ${
          ownerProcessGone
            ? `the owning server process (pid ${owner?.pid}) is gone`
            : abandonedByThisProcess
              ? "the owning request no longer exists"
              : `no live owner has reported progress for ${Math.round(silentForMs / 1000)}s`
        }, so the operation was failed to release the execution workspace for retry or stop.\n`;
      // Compare-and-swap on `updated_at`: a live owner that heartbeats between the read and
      // this write moves the column and keeps its operation.
      const claimed = await db
        .update(workspaceOperations)
        .set({
          status: "failed",
          stderrExcerpt: appendExcerpt(candidate.stderrExcerpt ?? "", reconciliationMessage),
          metadata: combineMetadata(candidate.metadata as Record<string, unknown> | null, {
            reconciled: true,
            reconciliationReason: abandonedByThisProcess
              ? "abandoned_runtime_control"
              : "orphaned_runtime_control",
            reconciledAt: finishedAt.toISOString(),
          }),
          finishedAt,
          updatedAt: finishedAt,
        })
        .where(
          and(
            eq(workspaceOperations.id, candidate.id),
            eq(workspaceOperations.status, "running"),
            candidate.updatedAt
              ? updatedAtUnchanged(candidate.updatedAt)
              : isNull(workspaceOperations.updatedAt),
          ),
        )
        .returning({ id: workspaceOperations.id })
        .then((rows) => rows[0] ?? null);
      if (!claimed) {
        // Someone else moved the row; re-read so callers see the current truth.
        const refreshed = await getById(candidate.id);
        if (refreshed?.status === "running") live.push(refreshed);
        continue;
      }

      liveRuntimeControlOperationIds.delete(candidate.id);
      reconciledIds.push(candidate.id);

      if (candidate.logStore && candidate.logRef) {
        const handle = {
          store: candidate.logStore as "local_file",
          logRef: candidate.logRef,
        };
        try {
          await logStore.append(handle, {
            stream: "stderr",
            chunk: reconciliationMessage,
            ts: finishedAt.toISOString(),
          });
          const finalized = await logStore.finalize(handle);
          await db
            .update(workspaceOperations)
            .set({
              logBytes: finalized.bytes,
              logSha256: finalized.sha256,
              logCompressed: finalized.compressed,
              updatedAt: new Date(),
            })
            .where(eq(workspaceOperations.id, candidate.id));
        } catch {
          // The terminal row and stderr excerpt stay inspectable even when the external log
          // file from the previous process is gone.
        }
      }
    }

    return { reconciled: reconciledIds.length, operationIds: reconciledIds, live };
  }

  return {
    getById,

    /**
     * Bounded recovery entrypoint. Safe to call on startup and before every managed control.
     */
    async reconcileStaleRuntimeControlOperations(
      executionWorkspaceId?: string | null,
      options?: { now?: Date; staleAfterMs?: number },
    ) {
      const result = await sweepRuntimeControlOperations(executionWorkspaceId, options);
      return { reconciled: result.reconciled, operationIds: result.operationIds };
    },

    /**
     * Refuse a managed runtime control while another one is genuinely live for the same
     * execution workspace. Stale operations are recovered first, so a workspace stranded by
     * a dead request or a previous server process becomes controllable again on its own.
     */
    async assertRuntimeControlAvailable(input: {
      executionWorkspaceId: string;
      action: string;
      options?: { now?: Date; staleAfterMs?: number };
    }) {
      const { live } = await sweepRuntimeControlOperations(input.executionWorkspaceId, input.options);
      const blocking = live[0];
      if (!blocking) return;
      const owner = readRuntimeControlOwner(blocking.metadata);
      throw conflict("A managed runtime control operation is already in progress for this execution workspace.", {
        code: "workspace_runtime_control_in_progress",
        executionWorkspaceId: input.executionWorkspaceId,
        activeAction: readRuntimeControlAction(blocking.metadata) ?? owner?.action ?? null,
        requestedAction: input.action,
        activeOperationId: blocking.id,
        startedAt: blocking.startedAt instanceof Date ? blocking.startedAt.toISOString() : blocking.startedAt,
        remediation:
          "Wait for the active operation to reach a terminal state before retrying; abandoned operations are recovered automatically.",
      });
    },

    createRecorder(input: {
      companyId: string;
      heartbeatRunId?: string | null;
      executionWorkspaceId?: string | null;
      issueId?: string | null;
    }): WorkspaceOperationRecorder {
      let executionWorkspaceId = input.executionWorkspaceId ?? null;
      const createdIds: string[] = [];

      return {
        async attachExecutionWorkspaceId(nextExecutionWorkspaceId) {
          executionWorkspaceId = nextExecutionWorkspaceId ?? null;
          if (!executionWorkspaceId || createdIds.length === 0) return;
          await db
            .update(workspaceOperations)
            .set({
              executionWorkspaceId,
              updatedAt: new Date(),
            })
            .where(inArray(workspaceOperations.id, createdIds));
        },

        async recordOperation(recordInput) {
          const currentUserRedactionOptions = {
            enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
          };
          const startedAt = new Date();
          const id = randomUUID();
          const handle = await logStore.begin({
            companyId: input.companyId,
            operationId: id,
          });

          let stdoutExcerpt = "";
          let stderrExcerpt = "";
          const append = async (stream: "stdout" | "stderr" | "system", chunk: string | null | undefined) => {
            if (!chunk) return;
            const sanitizedChunk = redactCurrentUserText(chunk, currentUserRedactionOptions);
            if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
            if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
            await logStore.append(handle, {
              stream,
              chunk: sanitizedChunk,
              ts: new Date().toISOString(),
            });
          };

          // Managed runtime controls get an ownership stamp so bounded recovery can tell a
          // slow-but-live operation from one abandoned by a dead request or server process.
          const runtimeControlAction = readRuntimeControlAction(recordInput.metadata);
          let currentMetadata = runtimeControlAction
            ? {
                ...(recordInput.metadata ?? {}),
                runtimeControlOwner: {
                  ownerId: RUNTIME_CONTROL_OWNER_ID,
                  pid: process.pid,
                  action: runtimeControlAction,
                  heartbeatAt: startedAt.toISOString(),
                } satisfies RuntimeControlOwnerStamp,
              }
            : recordInput.metadata ?? null;

          // Claim in-process before the row exists, so there is no ordering in which a recovery
          // sweep can observe an operation stamped by this process but not yet tracked by it —
          // which is the one state that would let recovery terminalize a genuinely live start.
          if (runtimeControlAction) liveRuntimeControlOperationIds.add(id);

          try {
            await db.insert(workspaceOperations).values({
              id,
              companyId: input.companyId,
              executionWorkspaceId,
              heartbeatRunId: input.heartbeatRunId ?? null,
              issueId: input.issueId ?? null,
              phase: recordInput.phase,
              command: recordInput.command ?? null,
              cwd: recordInput.cwd ?? null,
              status: "running",
              logStore: handle.store,
              logRef: handle.logRef,
              metadata: redactCurrentUserValue(
                currentMetadata,
                currentUserRedactionOptions,
              ) as Record<string, unknown> | null,
              startedAt,
              updatedAt: startedAt,
            });
          } catch (insertError) {
            liveRuntimeControlOperationIds.delete(id);
            throw insertError;
          }
          createdIds.push(id);

          let heartbeatTimer: NodeJS.Timeout | null = null;
          let timeoutTimer: NodeJS.Timeout | null = null;
          if (runtimeControlAction) {
            heartbeatTimer = setInterval(() => {
              const heartbeatAt = new Date();
              currentMetadata = combineMetadata(currentMetadata, {
                runtimeControlOwner: {
                  ownerId: RUNTIME_CONTROL_OWNER_ID,
                  pid: process.pid,
                  action: runtimeControlAction,
                  heartbeatAt: heartbeatAt.toISOString(),
                } satisfies RuntimeControlOwnerStamp,
              });
              void db
                .update(workspaceOperations)
                .set({
                  metadata: redactCurrentUserValue(
                    currentMetadata,
                    currentUserRedactionOptions,
                  ) as Record<string, unknown> | null,
                  updatedAt: heartbeatAt,
                })
                .where(and(eq(workspaceOperations.id, id), eq(workspaceOperations.status, "running")))
                .catch(() => undefined);
            }, RUNTIME_CONTROL_HEARTBEAT_MS);
            heartbeatTimer.unref?.();
          }

          const reportProgress = async (progress: {
            metadata?: Record<string, unknown> | null;
            system?: string | null;
          }) => {
            await append("system", progress.system ?? null);
            currentMetadata = combineMetadata(currentMetadata, progress.metadata);
            await db
              .update(workspaceOperations)
              .set({
                metadata: redactCurrentUserValue(
                  currentMetadata,
                  currentUserRedactionOptions,
                ) as Record<string, unknown> | null,
                stdoutExcerpt: stdoutExcerpt || null,
                stderrExcerpt: stderrExcerpt || null,
                updatedAt: new Date(),
              })
              .where(and(eq(workspaceOperations.id, id), eq(workspaceOperations.status, "running")));
          };

          const timeoutMs = recordInput.timeoutMs ?? defaultRuntimeControlTimeoutMs(runtimeControlAction);
          const settle = async () => {
            if (!timeoutMs || timeoutMs <= 0) return await recordInput.run(reportProgress);
            const timeout = new Promise<never>((_resolve, reject) => {
              timeoutTimer = setTimeout(
                () => reject(new WorkspaceOperationTimeoutError(timeoutMs, runtimeControlAction)),
                timeoutMs,
              );
              timeoutTimer.unref?.();
            });
            return await Promise.race([recordInput.run(reportProgress), timeout]);
          };

          try {
            const result = await settle();
            await append("system", result.system ?? null);
            await append("stdout", result.stdout ?? null);
            await append("stderr", result.stderr ?? null);
            const finalized = await logStore.finalize(handle);
            const finishedAt = new Date();
            const row = await db
              .update(workspaceOperations)
              .set({
                executionWorkspaceId,
                status: result.status ?? "succeeded",
                exitCode: result.exitCode ?? null,
                stdoutExcerpt: stdoutExcerpt || null,
                stderrExcerpt: stderrExcerpt || null,
                logBytes: finalized.bytes,
                logSha256: finalized.sha256,
                logCompressed: finalized.compressed,
                metadata: redactCurrentUserValue(
                  combineMetadata(currentMetadata, result.metadata),
                  currentUserRedactionOptions,
                ) as Record<string, unknown> | null,
                finishedAt,
                updatedAt: finishedAt,
              })
              .where(eq(workspaceOperations.id, id))
              .returning()
              .then((rows) => rows[0] ?? null);
            if (!row) throw notFound("Workspace operation not found");
            return toWorkspaceOperation(row);
          } catch (error) {
            await append("stderr", error instanceof Error ? error.message : String(error));
            const finalized = await logStore.finalize(handle).catch(() => null);
            const finishedAt = new Date();
            await db
              .update(workspaceOperations)
              .set({
                executionWorkspaceId,
                status: "failed",
                stdoutExcerpt: stdoutExcerpt || null,
                stderrExcerpt: stderrExcerpt || null,
                logBytes: finalized?.bytes ?? null,
                logSha256: finalized?.sha256 ?? null,
                logCompressed: finalized?.compressed ?? false,
                // Only managed controls carry a failure reason; other phases keep the metadata
                // they were recorded with.
                ...(runtimeControlAction
                  ? {
                      metadata: redactCurrentUserValue(
                        combineMetadata(currentMetadata, {
                          failureReason: error instanceof WorkspaceOperationTimeoutError
                            ? "runtime_control_timeout"
                            : "runtime_control_error",
                        }),
                        currentUserRedactionOptions,
                      ) as Record<string, unknown> | null,
                    }
                  : {}),
                finishedAt,
                updatedAt: finishedAt,
              })
              .where(eq(workspaceOperations.id, id));
            throw error;
          } finally {
            // Releasing the in-process claim before the request unwinds is what lets the very
            // next control call proceed, and lets recovery treat a leftover row as abandoned.
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            if (timeoutTimer) clearTimeout(timeoutTimer);
            liveRuntimeControlOperationIds.delete(id);
          }
        },
      };
    },

    listForRun: async (runId: string, executionWorkspaceId?: string | null) => {
      const conditions = [eq(workspaceOperations.heartbeatRunId, runId)];
      if (executionWorkspaceId) {
        const cleanupCondition = and(
          eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId)!,
          isNull(workspaceOperations.heartbeatRunId),
        )!;
        if (cleanupCondition) conditions.push(cleanupCondition);
      }

      const rows = await db
        .select()
        .from(workspaceOperations)
        .where(conditions.length === 1 ? conditions[0]! : or(...conditions)!)
        .orderBy(asc(workspaceOperations.startedAt), asc(workspaceOperations.createdAt), asc(workspaceOperations.id));

      return rows.map(toWorkspaceOperation);
    },

    listForExecutionWorkspace: async (executionWorkspaceId: string) => {
      const rows = await db
        .select()
        .from(workspaceOperations)
        .where(eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId))
        .orderBy(desc(workspaceOperations.startedAt), desc(workspaceOperations.createdAt));
      return rows.map(toWorkspaceOperation);
    },

    readLog: async (operationId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const operation = await getById(operationId);
      if (!operation) throw notFound("Workspace operation not found");
      if (!operation.logStore || !operation.logRef) throw notFound("Workspace operation log not found");

      const result = await logStore.read(
        {
          store: operation.logStore as "local_file",
          logRef: operation.logRef,
        },
        opts,
      );

      return {
        operationId,
        store: operation.logStore,
        logRef: operation.logRef,
        ...result,
        // Workspace-operation log chunks are sanitized before append-time storage.
        // Returning the stored chunk avoids another whole-string rewrite per poll.
        content: result.content,
      };
    },
  };
}

export { toWorkspaceOperation };
