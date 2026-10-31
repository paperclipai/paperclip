import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { AdapterInvocationMeta, AdapterRuntimeEvent } from "../../adapters/index.js";
import { redactCurrentUserText, type CurrentUserRedactionOptions } from "../../log-redaction.js";
import type { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { touchHeartbeatRunRuntimeStatus } from "../heartbeat-run-runtime-status.js";
import { publishLiveEvent } from "../live-events.js";
import { isRunLogStoreType, type RunLogHandle, type RunLogStore } from "../run-log-store.js";
import { appendExcerpt, compactRunLogChunk } from "./run-log.js";
import { createNativeRunLogExporter } from "../native-runtime/native-run-log-export.js";
import { createRunSecretRedactionRegistry } from "../run-secret-redaction.js";
import {
  isHeartbeatRunRuntimeStatusActive,
  publishHeartbeatRunRuntimeProgress,
  type createHeartbeatLifecycle,
} from "./run-lifecycle.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
export const ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS = 60 * 1000;
export const ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS = 5 * 1000;

type Run = typeof heartbeatRuns.$inferSelect;

export interface HeartbeatRunOutputInput {
  run: Run;
  runId: string;
  issueId: string | null;
  runLogStore: Pick<RunLogStore, "begin" | "append" | "enqueue" | "flush">;
  identityRedactor: Pick<ReturnType<typeof createAgentIdentityRedactor>, "chunk" | "redact">;
  secretKeys: Set<string>;
  appendRunEvent: ReturnType<typeof createHeartbeatLifecycle>["appendRunEvent"];
  getCurrentUserRedactionOptions: () => Promise<CurrentUserRedactionOptions>;
  assertWriterAuthority?: () => Promise<void>;
  runtimeLogSecretValues?: readonly string[];
}

/**
 * True only when the persisted run row proves no earlier attempt began its log.
 * The first begin() records logStore/logRef before any output can be appended
 * or mirrored to object storage; output sequence and final size are recorded
 * after that. A row with none of them has no durable log prefix to restore.
 */
export function isNewRunLog(
  run: Pick<Run, "logStore" | "logRef" | "logBytes" | "lastOutputSeq">,
): boolean {
  return (
    run.logStore == null &&
    run.logRef == null &&
    run.logBytes == null &&
    Number(run.lastOutputSeq ?? 0) === 0
  );
}

/** One recorder per execution attempt; the log store itself stays service-scoped. */
export function createHeartbeatRunOutput(db: Db, input: HeartbeatRunOutputInput) {
  const {
    run,
    runId,
    issueId,
    runLogStore,
    identityRedactor,
    secretKeys,
    appendRunEvent,
    getCurrentUserRedactionOptions,
  } = input;
  let handle: RunLogHandle | null = null;
  let stdoutExcerpt = "";
  let stderrExcerpt = "";
  let outputSeq = Number(run.lastOutputSeq ?? 0);
  let lastOutputFlushAt: Date | null = run.lastOutputAt ?? null;
  let lastLogRuntimeStatusTouchMs = 0;
  const outputProgressState: {
    pending: {
      at: Date;
      seq: number;
      stream: "stdout" | "stderr";
      bytes: number;
    } | null;
  } = { pending: null };
  let persistedLogBytes = Number(run.logBytes ?? 0);
  let progressWrite: Promise<void> | null = null;
  let recordingFailureReported = false;
  const flushOutputProgress = async (opts?: { force?: boolean }) => {
    if (progressWrite) {
      await progressWrite;
      if (opts?.force) return flushOutputProgress(opts);
      return;
    }
    const pendingOutputProgress = outputProgressState.pending;
    if (!pendingOutputProgress) return;
    const shouldFlush =
      opts?.force === true ||
      !lastOutputFlushAt ||
      pendingOutputProgress.at.getTime() - lastOutputFlushAt.getTime() >=
        ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS;
    if (!shouldFlush) return;
    progressWrite = db
      .update(heartbeatRuns)
      .set({
        lastOutputAt: pendingOutputProgress.at,
        lastOutputSeq: pendingOutputProgress.seq,
        lastOutputStream: pendingOutputProgress.stream,
        lastOutputBytes: pendingOutputProgress.bytes,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, run.id))
      .then(() => {
        lastOutputFlushAt = pendingOutputProgress.at;
        if (outputProgressState.pending === pendingOutputProgress)
          outputProgressState.pending = null;
      })
      .finally(() => {
        progressWrite = null;
      });
    await progressWrite;
  };
  // Bind handlers to the run row persisted at execution start. Progress writes
  // above use only the immutable run ID from the initial row.
  async function begin(currentRun: Run) {
    const run = currentRun;
    if (run.logStore != null && !isRunLogStoreType(run.logStore))
      throw new Error("Run log backend is not supported");
    handle = await runLogStore.begin({
      companyId: run.companyId,
      agentId: run.agentId,
      runId,
      newRun: isNewRunLog(run),
      assertWriterAuthority: input.assertWriterAuthority,
      previousStore: run.logStore ?? undefined,
    });

    outputSeq = handle.initialSequence ?? outputSeq;
    persistedLogBytes = handle.initialBytes ?? persistedLogBytes;
    await db
      .update(heartbeatRuns)
      .set({
        logStore: handle.store,
        logRef: handle.logRef,
        ...(handle.store === "s3_segments" ? { logBytes: null, logSha256: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId));

    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    if (
      handle.store === "s3_segments" &&
      run.runtimeMode === "native" &&
      input.runtimeLogSecretValues?.length
    ) {
      const registry = createRunSecretRedactionRegistry(db);
      for (const value of new Set(input.runtimeLogSecretValues))
        await registry.register(run.companyId, runId, value);
    }
    const reportRecordingFailure = async () => {
      if (recordingFailureReported) return;
      recordingFailureReported = true;
      await appendRunEvent(currentRun, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "Run log persistence is incomplete",
        payload: { reason: "object_log_persistence_failed" },
      }).catch(() => undefined);
    };
    const appendIdentityRedactedLog = async (
      stream: "stdout" | "stderr",
      chunk: string,
      waitForCommit = true,
      sourceCursor?: number,
    ) => {
      const sanitizedChunk = compactRunLogChunk(
        redactCurrentUserText(chunk, currentUserRedactionOptions),
      );
      if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
      if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
      const ts = new Date().toISOString();

      outputSeq += 1;
      const chunkSeq = outputSeq;
      let committed: Promise<number> = Promise.resolve(0);
      if (handle) {
        const event = {
          stream,
          chunk: sanitizedChunk,
          ts,
          seq: chunkSeq,
          sourceCursor,
        };
        committed = runLogStore.enqueue
          ? (await runLogStore.enqueue(handle, event)).committed
          : runLogStore.append(handle, event);
      }
      const recorded = committed.then(async (appendedBytes) => {
        persistedLogBytes += appendedBytes;
        outputProgressState.pending = {
          at: new Date(ts),
          seq: chunkSeq,
          stream,
          bytes: persistedLogBytes,
        };
        await flushOutputProgress();

        // Streamed CLI output is real run activity: keep the in-memory
        // runtime status ("Working... / X ago") fresh between structured
        // events so sandbox runs with mid-run log streaming never show a
        // minutes-stale timestamp. Throttled to avoid churning the live
        // event stream on every 250ms tail chunk.
        const logActivityAt = new Date(ts);
        if (
          isHeartbeatRunRuntimeStatusActive(run.status) &&
          logActivityAt.getTime() - lastLogRuntimeStatusTouchMs >=
            ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS
        ) {
          lastLogRuntimeStatusTouchMs = logActivityAt.getTime();
          const touchedStatus = touchHeartbeatRunRuntimeStatus({
            companyId: run.companyId,
            issueId,
            agentId: run.agentId,
            runId: run.id,
            at: logActivityAt,
          });
          if (touchedStatus) publishHeartbeatRunRuntimeProgress(touchedStatus);
        }

        const payloadChunk =
          sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
            ? sanitizedChunk.slice(sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
            : sanitizedChunk;

        publishLiveEvent({
          companyId: run.companyId,
          type: "heartbeat.run.log",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            issueId,
            ts,
            seq: chunkSeq,
            stream,
            chunk: payloadChunk,
            logRef: handle?.logRef,
            logStore: handle?.store,
            truncated: payloadChunk.length !== sanitizedChunk.length,
          },
        });
      });
      if (waitForCommit) await recorded;
      else void recorded.catch(reportRecordingFailure);
    };
    const onLog = (stream: "stdout" | "stderr", chunk: string) => {
      const external = handle?.store === "s3_segments";
      const recorded = appendIdentityRedactedLog(
        stream,
        identityRedactor.chunk(stream, chunk),
        !external,
      );
      return external ? recorded.catch(reportRecordingFailure) : recorded;
    };
    const nativeExporter =
      handle.store === "s3_segments" && run.runtimeMode === "native"
        ? createNativeRunLogExporter({
            db,
            companyId: run.companyId,
            runId,
            afterCursor: handle.initialSourceCursor ?? 0,
            enqueue: (cursor, chunk) =>
              appendIdentityRedactedLog(
                "stdout",
                identityRedactor.chunk("stdout", chunk),
                false,
                cursor,
              ),
            flush: () => runLogStore.flush!(handle!),
          })
        : undefined;
    if (nativeExporter) await nativeExporter.recover();
    const onPersistedNativeLog = nativeExporter
      ? (cursor: number, chunk: string) =>
          nativeExporter.record(cursor, chunk).catch(reportRecordingFailure)
      : undefined;
    const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
      meta = identityRedactor.redact(meta);
      if (meta.env && secretKeys.size > 0) {
        for (const key of secretKeys) {
          if (key in meta.env) meta.env[key] = "***REDACTED***";
        }
      }
      await appendRunEvent(currentRun, {
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: meta as unknown as Record<string, unknown>,
      });
    };

    const onAdapterEvent = async (event: AdapterRuntimeEvent) => {
      event = identityRedactor.redact(event);
      const eventType = event.eventType.trim();
      // This namespace attests host-owned handoff cleanup. Legacy adapters do
      // not carry nativeSource identities, so they must never author it.
      if (!eventType || eventType.startsWith("legacy.case_handoff_")) return;
      await appendRunEvent(currentRun, {
        eventType: eventType.slice(0, 120),
        stream: event.stream,
        level: event.level,
        color: event.color,
        message: event.message,
        payload: event.payload,
      });
    };

    return {
      currentUserRedactionOptions,
      appendIdentityRedactedLog,
      onLog,
      onPersistedNativeLog,
      onAdapterMeta,
      onAdapterEvent,
    };
  }

  return {
    begin,
    get handle() {
      return handle;
    },
    outputProgressState,
    flushOutputProgress,
    // Finalization awaits I/O and can receive more output before persisting excerpts.
    get stdoutExcerpt() {
      return stdoutExcerpt;
    },
    get stderrExcerpt() {
      return stderrExcerpt;
    },
  };
}
