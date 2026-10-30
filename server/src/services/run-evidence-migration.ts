import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  heartbeatRunEvents,
  nativeRunFinalizations,
  providerTraceRecords,
  type Db,
} from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { createObjectByteJournal } from "./object-byte-journal.js";
import {
  createProviderTraceObjectStore,
  importingProviderTraceRef,
} from "./provider-trace-object-store.js";
import { openLegacyRunLogForMigration } from "./run-log-store.js";
import { resolveRunEvidenceStorage } from "./run-evidence-storage.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import {
  createNativeRunLogCoverageVerifier,
  nativeRunLogSourceWhere,
} from "./native-runtime/native-run-log-export.js";

const SETTLED = ["succeeded", "failed", "cancelled", "timed_out"];
export interface RunEvidenceMigrationItem {
  kind: "log" | "trace";
  id: string;
  state: "inventoried" | "migrated" | "blocked";
  bytes?: number;
  sha256?: string;
  reason?: string;
}

export async function migrateRunEvidence(
  db: Db,
  options: {
    apply: boolean;
    companyId?: string;
    afterRunId?: string;
    afterTraceId?: string;
    limit?: number;
    kinds?: readonly ("log" | "trace")[];
    signal?: AbortSignal;
  },
): Promise<{
  items: RunEvidenceMigrationItem[];
  nextRunId?: string;
  nextTraceId?: string;
}> {
  const limit = options.limit ?? 50;
  options.signal?.throwIfAborted();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Migration limit must be between 1 and 100");
  const config = resolveRunEvidenceStorage();
  if (!config) throw new Error("Run evidence migration requires instance S3 storage");
  function drainedWriter(now = new Date()) {
    return and(
      inArray(heartbeatRuns.status, SETTLED),
      or(
        isNull(heartbeatRuns.controllerLeaseExpiresAt),
        lte(heartbeatRuns.controllerLeaseExpiresAt, now),
      ),
      sql`not exists (select 1 from ${nativeRunFinalizations} where ${and(
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
        eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
        gt(nativeRunFinalizations.leaseExpiresAt, now),
      )})`,
    );
  }
  async function assertDrained(runId: string, companyId: string) {
    const [run] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), drainedWriter()),
      );
    if (!run) throw new Error("legacy_writer_not_drained");
  }
  const items: RunEvidenceMigrationItem[] = [];
  const logs =
    options.kinds && !options.kinds.includes("log")
      ? []
      : await db
          .select({
            id: heartbeatRuns.id,
            companyId: heartbeatRuns.companyId,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
            runtimeMode: heartbeatRuns.runtimeMode,
            logRef: heartbeatRuns.logRef,
            bytes: heartbeatRuns.logBytes,
            sha256: heartbeatRuns.logSha256,
            lastSequence: heartbeatRuns.lastOutputSeq,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.logStore, "local_file"),
              options.companyId ? eq(heartbeatRuns.companyId, options.companyId) : undefined,
              options.afterRunId ? gt(heartbeatRuns.id, options.afterRunId) : undefined,
            ),
          )
          .orderBy(asc(heartbeatRuns.id))
          .limit(limit);
  for (const run of logs) {
    options.signal?.throwIfAborted();
    const item: RunEvidenceMigrationItem = {
      kind: "log",
      id: run.id,
      state: "inventoried",
    };
    items.push(item);
    try {
      if (!SETTLED.includes(run.status)) throw new Error("legacy_writer_not_settled");
      if (!run.logRef) throw new Error("legacy_reference_missing");
      await assertDrained(run.id, run.companyId);
      const ref = `${run.companyId}/${run.agentId}/${run.id}`;
      const journal = createObjectByteJournal({
        provider: config.provider,
        prefix: `${config.keyPrefix || "run-logs"}/segments-v1/${ref}`,
      });
      let writer = options.apply
        ? await journal.claim({
            expectedOwner: (await journal.head(options.signal))?.head.owner ?? null,
            signal: options.signal,
            assertAuthority: async () => {
              const [current] = await db
                .select({ id: heartbeatRuns.id })
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.id, run.id),
                    eq(heartbeatRuns.companyId, run.companyId),
                    eq(heartbeatRuns.logStore, "local_file"),
                    eq(heartbeatRuns.logRef, run.logRef!),
                    drainedWriter(),
                  ),
                );
              if (!current) throw new Error("legacy_writer_changed");
            },
          })
        : null;
      const source = await openLegacyRunLogForMigration(run.logRef);
      if (source.source === "mirror" && (run.bytes === null || !run.sha256)) {
        source.stream.destroy();
        throw new Error("mirror_completeness_unproven");
      }
      const hash = createHash("sha256");
      const nativeCoverage =
        run.runtimeMode === "native" && (run.bytes === null || run.sha256 === null)
          ? createNativeRunLogCoverageVerifier(db, run.companyId, run.id)
          : undefined;
      let offset = 0,
        tail = Buffer.alloc(0),
        sequence = run.lastSequence;
      try {
        for await (const chunk of source.stream) {
          options.signal?.throwIfAborted();
          const bytes = Buffer.from(chunk);
          hash.update(bytes);
          await nativeCoverage?.write(bytes);
          tail = Buffer.concat([tail, bytes]).subarray(-262144);
          if (writer) {
            const overlap = Math.min(bytes.length, Math.max(0, writer.head.end - offset));
            if (
              overlap &&
              !(await journal.readRange(writer.head, offset, overlap, options.signal)).equals(
                bytes.subarray(0, overlap),
              )
            )
              throw new Error("migration_prefix_conflict");
            if (overlap < bytes.length)
              writer = await journal.append(writer, bytes.subarray(overlap), options.signal);
          }
          offset += bytes.length;
        }
      } finally {
        source.stream.destroy();
      }
      const digest = hash.digest("hex");
      if (
        (source.bytes !== undefined && source.bytes !== offset) ||
        (run.bytes !== null && run.bytes !== offset) ||
        (run.sha256 && run.sha256 !== digest)
      )
        throw new Error("legacy_length_or_digest_mismatch");
      for (const line of tail.toString("utf8").split("\n")) {
        try {
          const entry = JSON.parse(line);
          if (Number.isSafeInteger(entry.seq)) sequence = Math.max(sequence, entry.seq);
        } catch {}
      }
      item.bytes = offset;
      item.sha256 = digest;
      let sourceCursor = (await nativeCoverage?.finish()) ?? 0;
      if (run.runtimeMode === "native" && !nativeCoverage) {
        const [source] = await db
          .select({ seq: heartbeatRunEvents.seq })
          .from(heartbeatRunEvents)
          .where(nativeRunLogSourceWhere(run.companyId, run.id))
          .orderBy(desc(heartbeatRunEvents.seq))
          .limit(1);
        sourceCursor = source?.seq ?? 0;
      }
      if (writer) {
        options.signal?.throwIfAborted();
        if (writer.head.end !== offset) throw new Error("migration_prefix_exceeds_source");

        const remoteHash = createHash("sha256");
        for (let start = 0; start < offset; start += 1024 * 1024)
          remoteHash.update(
            await journal.readRange(writer.head, start, 1024 * 1024, options.signal),
          );
        if (remoteHash.digest("hex") !== digest)
          throw new Error("migration_remote_digest_mismatch");
        writer.head = { ...writer.head, sequence, sourceCursor };
        await journal.close(writer, options.signal);
        options.signal?.throwIfAborted();
        const [updated] = await db
          .update(heartbeatRuns)
          .set({ logStore: "s3_segments", logRef: ref })
          .where(
            and(
              eq(heartbeatRuns.id, run.id),
              eq(heartbeatRuns.companyId, run.companyId),
              eq(heartbeatRuns.logStore, "local_file"),
              eq(heartbeatRuns.logRef, run.logRef),
              run.bytes === null
                ? isNull(heartbeatRuns.logBytes)
                : eq(heartbeatRuns.logBytes, run.bytes),
              run.sha256 === null
                ? isNull(heartbeatRuns.logSha256)
                : eq(heartbeatRuns.logSha256, run.sha256),
              drainedWriter(),
              run.runtimeMode === "native"
                ? sql`not exists (select 1 from ${heartbeatRunEvents} where ${and(
                    nativeRunLogSourceWhere(run.companyId, run.id),
                    gt(heartbeatRunEvents.seq, sourceCursor),
                  )})`
                : undefined,
            ),
          )
          .returning({ id: heartbeatRuns.id });
        if (!updated) throw new Error("migration_publication_conflict");
        item.state = "migrated";
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      item.state = "blocked";
      item.reason = error instanceof Error ? error.message : "migration_failed";
    }
  }
  options.signal?.throwIfAborted();
  const traces =
    options.kinds && !options.kinds.includes("trace")
      ? []
      : await db
          .select({ trace: providerTraceRecords, runStatus: heartbeatRuns.status })
          .from(providerTraceRecords)
          .innerJoin(
            heartbeatRuns,
            and(
              eq(heartbeatRuns.id, providerTraceRecords.runId),
              eq(heartbeatRuns.companyId, providerTraceRecords.companyId),
            ),
          )
          .where(
            and(
              sql`${providerTraceRecords.traceRef} not like 's3-segments-v1:%'`,
              isNull(providerTraceRecords.deletedAt),
              gt(providerTraceRecords.expiresAt, new Date()),
              options.companyId ? eq(providerTraceRecords.companyId, options.companyId) : undefined,
              options.afterTraceId ? gt(providerTraceRecords.id, options.afterTraceId) : undefined,
            ),
          )
          .orderBy(asc(providerTraceRecords.id))
          .limit(limit);
  const traceObjects =
    traces.length && options.apply
      ? createProviderTraceObjectStore(config.provider, config.tracePrefix)
      : null;
  for (const { trace, runStatus } of traces) {
    options.signal?.throwIfAborted();
    const item: RunEvidenceMigrationItem = {
      kind: "trace",
      id: trace.id,
      state: "inventoried",
    };
    items.push(item);
    try {
      if (!SETTLED.includes(runStatus) || trace.status === "capturing")
        throw new Error("legacy_trace_writer_not_settled");
      await assertDrained(trace.runId, trace.companyId);
      const importing = importingProviderTraceRef(trace.traceRef);
      if (importing && (importing[1] !== trace.companyId || importing[2] !== trace.runId))
        throw new Error("trace_import_binding_mismatch");
      const filename = importing?.[3] ?? trace.traceRef;
      if (!/^[a-f0-9-]+\.ndjson$/.test(filename)) throw new Error("invalid_legacy_trace_ref");
      const file = path.join(
        process.env.PROVIDER_TRACE_BASE_PATH ||
          path.join(resolvePaperclipInstanceRoot(), "data", "provider-traces"),
        filename,
      );
      for (const sidecar of [file, `${file}.rehydration`]) {
        const stat = await fs.stat(sidecar).catch((error) => {
          if (error.code === "ENOENT" && sidecar !== file) return null;
          throw error;
        });
        if (stat && (!stat.isFile() || stat.size > 192 * 1024 * 1024))
          throw new Error("legacy_trace_capture_size_invalid");
      }
      const sourceHash = createHash("sha256");
      let byteCount = 0,
        nativeTail: number | undefined;
      for (const [index, sidecar] of [file, `${file}.rehydration`].entries()) {
        const source = createReadStream(sidecar, {
          highWaterMark: 1024 * 1024,
          signal: options.signal,
        });
        try {
          let first = true;
          for await (const chunk of source) {
            const bytes = Buffer.from(chunk);
            if (
              index === 1 &&
              first &&
              bytes.length &&
              nativeTail !== undefined &&
              nativeTail !== 10
            ) {
              sourceHash.update("\n");
              byteCount++;
            }
            first = false;
            sourceHash.update(bytes);
            byteCount += bytes.length;
            if (index === 0 && bytes.length) nativeTail = bytes.at(-1);
          }
        } catch (error) {
          if (index !== 1 || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        } finally {
          source.destroy();
        }
      }
      const digest = `sha256:${sourceHash.digest("hex")}`;
      if (trace.digest && trace.digest !== digest) throw new Error("legacy_trace_digest_mismatch");
      item.bytes = byteCount;
      item.sha256 = digest;
      if (traceObjects) {
        options.signal?.throwIfAborted();
        const ref = `s3-segments-v1:${trace.companyId}/${trace.runId}/${filename}`;
        const pendingRef = ref.replace("s3-segments-v1:", "s3-import-v1:");
        if (!importing) {
          const staged = await db.transaction(async (tx) => {
            await notifyDeliveryWork(tx, DELIVERY_QUEUES.providerTraceRetention);
            return tx
              .update(providerTraceRecords)
              .set({ traceRef: pendingRef })
              .where(
                and(
                  eq(providerTraceRecords.id, trace.id),
                  eq(providerTraceRecords.traceRef, trace.traceRef),
                  isNull(providerTraceRecords.deletedAt),
                  gt(providerTraceRecords.expiresAt, new Date()),
                ),
              )
              .returning({ id: providerTraceRecords.id });
          });
          if (!staged.length) throw new Error("trace_migration_staging_conflict");
          trace.traceRef = pendingRef;
        }
        await traceObjects.open(
          ref,
          file,
          async () => {
            await assertDrained(trace.runId, trace.companyId);
            const [current] = await db
              .select({ id: providerTraceRecords.id })
              .from(providerTraceRecords)
              .where(
                and(
                  eq(providerTraceRecords.id, trace.id),
                  eq(providerTraceRecords.traceRef, trace.traceRef),
                  isNull(providerTraceRecords.deletedAt),
                  gt(providerTraceRecords.expiresAt, new Date()),
                ),
              );
            if (!current) throw new Error("trace_migration_authority_changed");
          },
          { restore: false, signal: options.signal },
        );
        await traceObjects.finish(ref);
        const remoteHash = createHash("sha256");
        let remoteBytes = 0;
        for await (const chunk of traceObjects.readChunks(ref, options.signal)) {
          remoteHash.update(chunk);
          remoteBytes += chunk.length;
        }
        if (remoteBytes !== byteCount || `sha256:${remoteHash.digest("hex")}` !== digest)
          throw new Error("trace_migration_remote_digest_mismatch");
        options.signal?.throwIfAborted();
        const updated = await db.transaction(async (tx) => {
          await notifyDeliveryWork(tx, DELIVERY_QUEUES.providerTraceRetention);
          return tx
            .update(providerTraceRecords)
            .set({ traceRef: ref })
            .where(
              and(
                eq(providerTraceRecords.id, trace.id),
                eq(providerTraceRecords.traceRef, trace.traceRef),
                isNull(providerTraceRecords.deletedAt),
                gt(providerTraceRecords.expiresAt, new Date()),
                sql`exists (select 1 from ${heartbeatRuns} where ${and(
                  eq(heartbeatRuns.id, trace.runId),
                  eq(heartbeatRuns.companyId, trace.companyId),
                  drainedWriter(),
                )})`,
              ),
            )
            .returning({ id: providerTraceRecords.id });
        });
        if (!updated.length) throw new Error("trace_migration_publication_conflict");
        item.state = "migrated";
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      item.state = "blocked";
      item.reason = error instanceof Error ? error.message : "trace_migration_failed";
    }
  }
  return {
    items,
    nextRunId: logs.length === limit ? logs.at(-1)!.id : undefined,
    nextTraceId: traces.length === limit ? traces.at(-1)!.trace.id : undefined,
  };
}
