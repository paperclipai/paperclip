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
import { createNativeRunLogExporter } from "./native-run-log-export.js";

const recoveries = new WeakMap<Db, Map<string, Promise<void>>>();

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
    await recoverSettledNativeRunLog(db, store, handle.logRef);
  return store.read(handle, options);
}

export async function recoverSettledNativeRunLog(
  db: Db,
  store: RunLogStore,
  logRef: string,
  getRedactionOptions: () => Promise<CurrentUserRedactionOptions> = async () => ({
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  }),
) {
  const binding = /^([a-f0-9-]+)\/([a-f0-9-]+)\/([a-f0-9-]+)$/.exec(logRef);
  if (!binding) throw new Error("invalid_native_run_log_reference");
  let pending = recoveries.get(db);
  if (!pending) {
    pending = new Map();
    recoveries.set(db, pending);
  }
  const existing = pending.get(logRef);
  if (existing) return existing;
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
    const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eligible());
    if (!run) return;
    const redaction = await getRedactionOptions();
    const handle = await store.begin({
      companyId,
      agentId: binding[2]!,
      runId,
      previousStore: "s3_segments",
      assertWriterAuthority: async () => {
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
      enqueue: async (sourceCursor, chunk) => {
        const receipt = await store.enqueue!(handle, {
          stream: "stdout",
          ts: new Date().toISOString(),
          seq: ++sequence,
          sourceCursor,
          chunk: compactRunLogChunk(redactCurrentUserText(chunk, redaction)),
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
      const summary = await store.finalize(handle);
      if (summary.bytes === null) failure ??= new Error("native_run_log_recovery_incomplete");
      if (!failure && summary.bytes !== null) {
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
                eq(heartbeatRunEvents.runId, runId),
                eq(heartbeatRunEvents.companyId, companyId),
                gt(heartbeatRunEvents.seq, lastSourceCursor),
                sql`${heartbeatRunEvents.sourceEventId} is not null`,
              )})`,
            ),
          )
          .returning({ id: heartbeatRuns.id });
        if (!updated.length) throw new Error("native_run_log_recovery_source_changed");
      }
    }
    if (failure) throw failure;
  })();
  pending.set(logRef, recover);
  try {
    await recover;
  } finally {
    pending.delete(logRef);
  }
}
