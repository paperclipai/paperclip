import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  heartbeatRunEvents,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import { redactCurrentUserText, type CurrentUserRedactionOptions } from "../../log-redaction.js";
import type { RunLogHandle, RunLogReadOptions, RunLogStore } from "../run-log-store.js";
import { instanceSettingsService } from "../instance-settings.js";
import { compactRunLogChunk } from "../heartbeat/run-log.js";
import { beginIdleTrackedWork } from "../task-admission.js";
import { agentIdentityService } from "../agent-identity.js";
import { createRunSecretRedactionRegistry } from "../run-secret-redaction.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { logger } from "../../middleware/logger.js";
import { createNativeRunLogExporter, nativeRunLogSourceWhere } from "./native-run-log-export.js";

interface Recovery {
  work: Promise<void>;
  controller: AbortController;
  readers: number;
}
const recoveries = new WeakMap<Db, Map<string, Recovery>>();
function awaitRecovery(recovery: Recovery, signal?: AbortSignal) {
  signal?.throwIfAborted();
  recovery.readers++;
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener("abort", abort);
      recovery.readers--;
      return true;
    };
    const abort = () => {
      if (!finish()) return;
      if (!recovery.readers) recovery.controller.abort(signal!.reason);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    recovery.work.then(
      () => {
        if (finish()) resolve();
      },
      (error) => {
        if (finish()) reject(error);
      },
    );
  });
}

export async function readRecoverableRunLog(
  db: Db,
  store: RunLogStore,
  handle: RunLogHandle,
  options?: RunLogReadOptions,
  known?: { runtimeMode?: string | null; status?: string; logBytes?: number | null },
) {
  if (
    handle.store === "s3_segments" &&
    known?.runtimeMode !== "legacy" &&
    known?.status !== "running" &&
    (known?.logBytes === undefined || known.logBytes === null)
  )
    await recoverSettledNativeRunLog(db, store, handle.logRef, undefined, options?.signal).catch(
      () => {
        options?.signal?.throwIfAborted();
        logger.warn(
          { runId: handle.logRef.split("/").at(-1) },
          "Native run log repair is incomplete; serving the published prefix",
        );
      },
    );
  return store.read(handle, options);
}

export async function recoverSettledNativeRunLog(
  db: Db,
  store: RunLogStore,
  logRef: string,
  getRedactionOptions: () => Promise<CurrentUserRedactionOptions> = async () => ({
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  }),
  requestSignal?: AbortSignal,
) {
  requestSignal?.throwIfAborted();
  const binding = /^([a-f0-9-]+)\/([a-f0-9-]+)\/([a-f0-9-]+)$/.exec(logRef);
  if (!binding) throw new Error("invalid_native_run_log_reference");
  let pending = recoveries.get(db);
  if (!pending) {
    pending = new Map();
    recoveries.set(db, pending);
  }
  const existing = pending.get(logRef);
  if (existing) return awaitRecovery(existing, requestSignal);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
  const finishWork = beginIdleTrackedWork();
  const runId = binding[3]!,
    companyId = binding[1]!;
  const eligible = () =>
    and(
      eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, binding[2]!),
      eq(heartbeatRuns.logStore, "s3_segments"),
      eq(heartbeatRuns.logRef, logRef),
      eq(heartbeatRuns.runtimeMode, "native"),
      inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out"]),
      isNull(heartbeatRuns.logBytes),
      sql`not exists (select 1 from ${nativeRunFinalizations} where ${and(
        eq(nativeRunFinalizations.runId, runId),
        eq(nativeRunFinalizations.companyId, companyId),
        gt(nativeRunFinalizations.leaseExpiresAt, new Date()),
      )})`,
    );
  const recover = (async () => {
    signal.throwIfAborted();
    const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eligible());
    signal.throwIfAborted();
    if (!run) return;
    const [redaction, identityRedactor, secrets] = await Promise.all([
      getRedactionOptions(),
      agentIdentityService(db).createExistingLogRedactor(companyId, binding[2]!),
      createRunSecretRedactionRegistry(db).redactionValuesForRun(companyId, runId),
    ]);
    for (const value of secrets)
      identityRedactor.values.push(...createAgentIdentityRedactor(value).values);
    identityRedactor.values.sort((left, right) => right.length - left.length);
    const handle = await store.begin({
      companyId,
      agentId: binding[2]!,
      runId,
      previousStore: "s3_segments",
      signal,
      assertWriterAuthority: async () => {
        signal.throwIfAborted();
        const [current] = await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eligible());
        if (!current) throw new Error("native_run_log_recovery_authority_lost");
      },
    });
    let sequence = handle.initialSequence ?? 0;
    let lastSourceCursor = handle.initialSourceCursor ?? 0;
    const receipts: Promise<number>[] = [];
    let failure: unknown;
    const exporter = createNativeRunLogExporter({
      db,
      companyId,
      runId,
      afterCursor: handle.initialSourceCursor ?? 0,
      signal,
      enqueue: async (sourceCursor, chunk) => {
        const receipt = await store.enqueue!(handle, {
          stream: "stdout",
          ts: new Date().toISOString(),
          seq: ++sequence,
          sourceCursor,
          chunk: compactRunLogChunk(
            redactCurrentUserText(identityRedactor.chunk("stdout", chunk), redaction),
          ),
        });
        receipts.push(
          receipt.committed.catch((error) => {
            failure ??= error;
            return 0;
          }),
        );
        lastSourceCursor = sourceCursor;
      },
      flush: async () => {
        await store.flush!(handle);
        await Promise.all(receipts.splice(0));
        if (failure) throw failure;
      },
    });
    try {
      await exporter.recover();
    } catch (error) {
      failure ??= error;
    } finally {
      const summary = await store.finalize(handle, { computeDigest: false });
      if (summary.bytes === null) failure ??= new Error("native_run_log_recovery_incomplete");
      if (!failure && summary.bytes !== null) {
        signal.throwIfAborted();
        const updated = await db
          .update(heartbeatRuns)
          .set({
            logBytes: summary.bytes,
            logSha256: summary.sha256,
            lastOutputSeq: sequence,
            lastOutputBytes: summary.bytes,
          })
          .where(
            and(
              eligible(),
              sql`not exists (select 1 from ${heartbeatRunEvents} where ${and(
                nativeRunLogSourceWhere(companyId, runId),
                gt(heartbeatRunEvents.seq, lastSourceCursor),
              )})`,
            ),
          )
          .returning({ id: heartbeatRuns.id });
        if (!updated.length) throw new Error("native_run_log_recovery_source_changed");
      }
    }
    if (failure) throw failure;
  })();
  const recovery: Recovery = {
    controller,
    readers: 0,
    work: recover.finally(() => {
      pending.delete(logRef);
      finishWork();
    }),
  };
  pending.set(logRef, recovery);
  await awaitRecovery(recovery, requestSignal);
}
