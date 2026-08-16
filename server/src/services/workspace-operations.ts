import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { workspaceOperations } from "@paperclipai/db";
import type { WorkspaceOperation, WorkspaceOperationPhase, WorkspaceOperationStatus } from "@paperclipai/shared";
import { asc, desc, eq, inArray, isNull, or, and } from "drizzle-orm";
import { HttpError, notFound } from "../errors.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../log-redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import { getWorkspaceOperationLogStore } from "./workspace-operation-log-store.js";

type WorkspaceOperationRow = typeof workspaceOperations.$inferSelect;

export interface WorkspaceOperationFailureEvidence {
  operationId: string;
  operationLogPath: string;
  code: string;
  message: string;
  remediation: string;
  details: {
    port?: number;
    attemptedPortCount?: number;
    conflictingExecutionWorkspaceId?: string;
    conflictingProjectWorkspaceId?: string;
  } | null;
  failedAt: string;
}

const WORKSPACE_OPERATION_FAILURE_PROPERTY = "paperclipWorkspaceOperationFailure";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSafeFailureDetails(value: unknown): WorkspaceOperationFailureEvidence["details"] {
  if (!isRecord(value)) return null;
  const details: NonNullable<WorkspaceOperationFailureEvidence["details"]> = {};
  if (typeof value.port === "number" && Number.isInteger(value.port)) details.port = value.port;
  if (typeof value.attemptedPortCount === "number" && Number.isInteger(value.attemptedPortCount)) {
    details.attemptedPortCount = value.attemptedPortCount;
  }
  if (typeof value.conflictingExecutionWorkspaceId === "string") {
    details.conflictingExecutionWorkspaceId = value.conflictingExecutionWorkspaceId;
  }
  if (typeof value.conflictingProjectWorkspaceId === "string") {
    details.conflictingProjectWorkspaceId = value.conflictingProjectWorkspaceId;
  }
  return Object.keys(details).length > 0 ? details : null;
}

function buildWorkspaceOperationFailureEvidence(input: {
  operationId: string;
  failedAt: Date;
  error: unknown;
  metadata: Record<string, unknown> | null | undefined;
}): WorkspaceOperationFailureEvidence {
  const httpDetails = input.error instanceof HttpError && isRecord(input.error.details)
    ? input.error.details
    : null;
  const action = typeof input.metadata?.action === "string" ? input.metadata.action : null;
  const isRuntimeStart = action === "start" || action === "restart";
  const code = typeof httpDetails?.code === "string"
    ? httpDetails.code
    : isRuntimeStart
      ? "workspace_runtime_start_failed"
      : "workspace_operation_failed";
  const message = input.error instanceof HttpError
    ? input.error.message
    : isRuntimeStart
      ? "Workspace runtime service failed to start."
      : "Workspace operation failed.";
  const remediation = typeof httpDetails?.remediation === "string"
    ? httpDetails.remediation
    : "Review the workspace operation log, correct the runtime configuration or dependency, and retry.";

  return {
    operationId: input.operationId,
    operationLogPath: `/api/workspace-operations/${input.operationId}/log`,
    code,
    message,
    remediation,
    details: readSafeFailureDetails(httpDetails),
    failedAt: input.failedAt.toISOString(),
  };
}

export function attachWorkspaceOperationFailureEvidence(
  error: unknown,
  evidence: WorkspaceOperationFailureEvidence,
) {
  const target = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(target, WORKSPACE_OPERATION_FAILURE_PROPERTY, {
    configurable: true,
    enumerable: false,
    value: evidence,
    writable: true,
  });
  return target;
}

export function getWorkspaceOperationFailureEvidence(
  error: unknown,
): WorkspaceOperationFailureEvidence | null {
  if (!(error instanceof Error)) return null;
  const value = (error as unknown as Record<string, unknown>)[WORKSPACE_OPERATION_FAILURE_PROPERTY];
  if (!isRecord(value)) return null;
  return value as unknown as WorkspaceOperationFailureEvidence;
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
    run: () => Promise<{
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

  return {
    getById,

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
              recordInput.metadata ?? null,
              currentUserRedactionOptions,
            ) as Record<string, unknown> | null,
            startedAt,
          });
          createdIds.push(id);

          try {
            const result = await recordInput.run();
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
                  combineMetadata(recordInput.metadata, result.metadata),
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
            const failureEvidence = buildWorkspaceOperationFailureEvidence({
              operationId: id,
              failedAt: finishedAt,
              error,
              metadata: recordInput.metadata,
            });
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
                metadata: redactCurrentUserValue(
                  combineMetadata(recordInput.metadata, { failureEvidence }),
                  currentUserRedactionOptions,
                ) as Record<string, unknown> | null,
                finishedAt,
                updatedAt: finishedAt,
              })
              .where(eq(workspaceOperations.id, id));
            throw attachWorkspaceOperationFailureEvidence(error, failureEvidence);
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
