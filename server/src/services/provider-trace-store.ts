import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, ne, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { providerTraceRecords } from "@paperclipai/db";
import type {
  ProviderTraceFrame,
  ProviderTraceMetadata,
} from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logActivity } from "./activity-log.js";

export const PROVIDER_TRACE_MAX_BYTES = 64 * 1024 * 1024;
export const PROVIDER_TRACE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const EXPIRED_PROVIDER_TRACE_REF = "00000000-0000-0000-0000-000000000000.ndjson";

export function providerTraceRequiredChannels(provider: string): string[] {
  if (provider === "opencode") return ["typescript_opencode_native"];
  if (provider === "acpx") return ["typescript_acpx_native"];
  return ["rust_native", "typescript_runnerd_rehydration"];
}

type TraceRow = typeof providerTraceRecords.$inferSelect;

function traceRoot() {
  return (
    process.env.PROVIDER_TRACE_BASE_PATH ??
    path.resolve(resolvePaperclipInstanceRoot(), "data", "provider-traces")
  );
}

function tracePath(traceRef: string) {
  if (
    path.basename(traceRef) !== traceRef ||
    !/^[a-f0-9-]+\.ndjson$/.test(traceRef)
  ) {
    throw new Error("invalid_provider_trace_ref");
  }
  return path.resolve(traceRoot(), traceRef);
}

function rehydrationTracePath(traceRef: string) {
  return `${tracePath(traceRef)}.rehydration`;
}

function asMetadata(row: TraceRow): ProviderTraceMetadata {
  return {
    schema: "paperclip.provider_trace_metadata.v1",
    id: row.id,
    runId: row.runId,
    companyId: row.companyId,
    status: row.status as ProviderTraceMetadata["status"],
    provider: row.provider,
    frameCount: row.frameCount,
    byteCount: row.byteCount,
    digest: row.digest as ProviderTraceMetadata["digest"],
    reason: row.reason,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    deletedAt: row.deletedAt,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const SECRET_KEY =
  /(authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
const REASONING_KEY =
  /(^|[_-])(analysis|reasoning|chain[_-]?of[_-]?thought)($|[_-])/i;
const SECRET_VALUE =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;

function redactParsed(
  value: unknown,
  pathParts: string[] = [],
  withheld: string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactParsed(item, [...pathParts, String(index)], withheld),
    );
  }
  if (typeof value === "string" && SECRET_VALUE.test(value)) {
    withheld.push(pathParts.join(".") || "$raw");
    return "[withheld]";
  }
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const reasoningObject =
    source.type === "reasoning" || source.type === "analysis";
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    const childPath = [...pathParts, key];
    if (
      SECRET_KEY.test(key) ||
      REASONING_KEY.test(key) ||
      (reasoningObject && key !== "type" && key !== "id" && key !== "status")
    ) {
      output[key] = "[withheld]";
      withheld.push(childPath.join("."));
      continue;
    }
    output[key] = redactParsed(child, childPath, withheld);
  }
  return output;
}

function redactedFrame(entry: Record<string, unknown>) {
  const rawBase64 = typeof entry.rawBase64 === "string" ? entry.rawBase64 : "";
  const withheldPaths: string[] = [];
  let parsed: unknown = null;
  try {
    parsed = redactParsed(
      JSON.parse(Buffer.from(rawBase64, "base64").toString("utf8")),
      [],
      withheldPaths,
    );
  } catch {
    withheldPaths.push("$raw");
  }
  const { rawBase64: _raw, ...safe } = entry;
  return {
    ...safe,
    parsed,
    withheldPaths,
    exactAvailable: rawBase64.length > 0,
  };
}

export function redactProviderTraceFrame(entry: Record<string, unknown>) {
  return redactedFrame(entry);
}

async function readTraceBytes(traceRef: string) {
  const nativeBytes = await fs.readFile(tracePath(traceRef));
  const rehydrationBytes = await fs
    .readFile(rehydrationTracePath(traceRef))
    .catch(() => Buffer.alloc(0));
  if (rehydrationBytes.byteLength === 0) return nativeBytes;
  const separator =
    nativeBytes.byteLength > 0 && nativeBytes.at(-1) !== 0x0a
      ? Buffer.from("\n")
      : Buffer.alloc(0);
  return Buffer.concat([nativeBytes, separator, rehydrationBytes]);
}

async function readEntries(traceRef: string) {
  const content = (await readTraceBytes(traceRef)).toString("utf8");
  return content.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [record(JSON.parse(line))];
    } catch {
      return [
        {
          kind: "trace_status",
          status: "incomplete",
          reason: "invalid_sidecar_record",
        },
      ];
    }
  });
}

export function assessProviderTraceEntries(
  entries: Record<string, unknown>[],
  options: {
    invalidRecordCount?: number;
    requiredChannels?: string[];
  } = {},
): { status: "complete" | "incomplete" | "truncated"; reason: string | null } {
  if ((options.invalidRecordCount ?? 0) > 0) {
    return { status: "incomplete", reason: "invalid_sidecar_record" };
  }

  for (const entry of entries) {
    if (entry.kind !== "frame") continue;
    const encoded =
      typeof entry.rawBase64 === "string" ? entry.rawBase64 : null;
    const byteLength = Number(entry.byteLength);
    const digest = typeof entry.digest === "string" ? entry.digest : null;
    if (encoded === null || !Number.isSafeInteger(byteLength) || !digest) {
      return { status: "incomplete", reason: "invalid_frame_metadata" };
    }
    const raw = Buffer.from(encoded, "base64");
    if (
      raw.toString("base64") !== encoded ||
      raw.byteLength !== byteLength ||
      `sha256:${createHash("sha256").update(raw).digest("hex")}` !== digest
    ) {
      return { status: "incomplete", reason: "provider_frame_digest_mismatch" };
    }
  }

  const channels = new Set(options.requiredChannels ?? []);
  for (const entry of entries) {
    if (typeof entry.debugChannel === "string")
      channels.add(entry.debugChannel);
  }
  for (const channel of channels) {
    const channelEntries = entries.filter(
      (entry) => entry.debugChannel === channel,
    );
    if (channelEntries.length === 0) {
      return {
        status: "incomplete",
        reason: `trace_channel_missing:${channel}`,
      };
    }
    for (let index = 0; index < channelEntries.length; index += 1) {
      if (Number(channelEntries[index]?.debugSequence) !== index + 1) {
        return {
          status: "incomplete",
          reason: `trace_debug_sequence_gap:${channel}`,
        };
      }
    }
    const terminal = channelEntries.at(-1)!;
    if (terminal.kind !== "trace_status") {
      return {
        status: "incomplete",
        reason: `trace_channel_ack_missing:${channel}`,
      };
    }
    if (
      Number(terminal.acknowledgedDebugSequence) !==
      Number(terminal.debugSequence) - 1
    ) {
      return {
        status: "incomplete",
        reason: `trace_channel_ack_invalid:${channel}`,
      };
    }
  }

  const statuses = entries.filter((entry) => entry.kind === "trace_status");
  const incomplete = statuses.find((entry) => entry.status === "incomplete");
  if (incomplete) {
    return {
      status: "incomplete",
      reason:
        typeof incomplete.reason === "string"
          ? incomplete.reason
          : "trace_channel_incomplete",
    };
  }
  const truncated = statuses.find((entry) => entry.status === "truncated");
  if (truncated) {
    return {
      status: "truncated",
      reason:
        typeof truncated.reason === "string"
          ? truncated.reason
          : "provider_trace_max_bytes_exceeded",
    };
  }
  if (statuses.length === 0) {
    return { status: "incomplete", reason: "trace_terminal_ack_missing" };
  }
  return { status: "complete", reason: null };
}

export function providerTraceStore(db: Db) {
  async function removeTraceFiles(traceRef: string) {
    for (const filePath of [tracePath(traceRef), rehydrationTracePath(traceRef)]) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async function expireRow(row: TraceRow, now: Date) {
    let expired = row;
    let newlyExpired = false;
    if (!row.deletedAt) {
      if (row.expiresAt.getTime() > now.getTime()) return null;
      const updated = await db
        .update(providerTraceRecords)
        .set({
          status: "expired",
          deletedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(providerTraceRecords.id, row.id),
          isNull(providerTraceRecords.deletedAt),
          lte(providerTraceRecords.expiresAt, now),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;
      expired = updated;
      newlyExpired = true;
    } else if (row.expiresAt.getTime() > now.getTime()) {
      return null;
    }

    // The database tombstone is authoritative before filesystem cleanup, so
    // concurrent readers fail closed. traceRef becomes a durable completion
    // marker only after both raw sidecars are absent; failures are retried by
    // later reads and cleanup passes.
    if (expired.traceRef !== EXPIRED_PROVIDER_TRACE_REF) {
      await removeTraceFiles(expired.traceRef);
      await db
        .update(providerTraceRecords)
        .set({
          status: "expired",
          traceRef: EXPIRED_PROVIDER_TRACE_REF,
          updatedAt: now,
        })
        .where(and(
          eq(providerTraceRecords.id, expired.id),
          lte(providerTraceRecords.expiresAt, now),
          eq(providerTraceRecords.traceRef, expired.traceRef),
        ));
      expired = { ...expired, traceRef: EXPIRED_PROVIDER_TRACE_REF };
    }
    if (newlyExpired) {
      await logActivity(db, {
        companyId: row.companyId,
        actorType: "system",
        actorId: "provider-trace-expiry",
        runId: row.runId,
        action: "provider_trace.expired",
        entityType: "heartbeat_run",
        entityId: row.runId,
        details: {
          traceId: row.id,
          expiredAt: now.toISOString(),
          payloadLogged: false,
        },
      });
    }
    return expired;
  }

  async function cleanupExpired(now = new Date()) {
    const expired = await db
      .select()
      .from(providerTraceRecords)
      .where(
        and(
          lte(providerTraceRecords.expiresAt, now),
          or(
            isNull(providerTraceRecords.deletedAt),
            ne(providerTraceRecords.traceRef, EXPIRED_PROVIDER_TRACE_REF),
          ),
        ),
      );
    const removed: TraceRow[] = [];
    for (const row of expired) {
      const removedRow = await expireRow(row, now);
      if (removedRow) removed.push(removedRow);
    }
    return removed;
  }

  async function prepare(input: {
    runId: string;
    companyId: string;
    provider: string;
    requestedBy: string;
  }) {
    await cleanupExpired().catch(() => []);
    const existing = await db
      .select()
      .from(providerTraceRecords)
      .where(eq(providerTraceRecords.runId, input.runId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) {
      const now = new Date();
      const expired = existing.expiresAt.getTime() <= now.getTime();
      if (expired) await expireRow(existing, now);
      if (existing.deletedAt || expired) {
        throw new Error("provider_trace_unavailable");
      }
      return {
        metadata: asMetadata(existing),
        path: tracePath(existing.traceRef),
      };
    }

    await fs.mkdir(traceRoot(), { recursive: true, mode: 0o700 });
    const traceRef = `${randomUUID()}.ndjson`;
    const filePath = tracePath(traceRef);
    const handle = await fs.open(filePath, "wx", 0o600);
    await handle.close();
    await fs.chmod(filePath, 0o600);
    const expiresAt = new Date(Date.now() + PROVIDER_TRACE_RETENTION_MS);
    const row = await db
      .insert(providerTraceRecords)
      .values({
        runId: input.runId,
        companyId: input.companyId,
        status: "capturing",
        provider: input.provider,
        traceRef,
        requestedBy: input.requestedBy,
        expiresAt,
      })
      .returning()
      .then((rows) => rows[0]);
    if (!row) throw new Error("provider_trace_metadata_create_failed");
    return { metadata: asMetadata(row), path: filePath };
  }

  async function getByRun(runId: string, companyId?: string) {
    const where = companyId
      ? and(
          eq(providerTraceRecords.runId, runId),
          eq(providerTraceRecords.companyId, companyId),
        )
      : eq(providerTraceRecords.runId, runId);
    return db
      .select()
      .from(providerTraceRecords)
      .where(where)
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getReadableByRun(runId: string, companyId: string) {
    const row = await getByRun(runId, companyId);
    if (!row) return null;
    const now = new Date();
    if (row.deletedAt) {
      if (
        row.expiresAt.getTime() <= now.getTime()
        && row.traceRef !== EXPIRED_PROVIDER_TRACE_REF
      ) {
        await expireRow(row, now);
      }
      return null;
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      await expireRow(row, now);
      return null;
    }
    return row;
  }

  async function listMetadataForRuns(companyId: string, runIds: string[]) {
    if (runIds.length === 0) return [];
    const rows = await db
      .select()
      .from(providerTraceRecords)
      .where(
        and(
          eq(providerTraceRecords.companyId, companyId),
          inArray(providerTraceRecords.runId, runIds.slice(0, 100)),
        ),
      );
    return rows.map(asMetadata);
  }

  async function finalize(
    runId: string,
    companyId: string,
    failureReason?: string | null,
  ) {
    const row = await getReadableByRun(runId, companyId);
    if (!row) return null;
    let bytes: Buffer;
    try {
      bytes = await readTraceBytes(row.traceRef);
    } catch {
      const updatedAt = new Date();
      const finalized = await db
        .update(providerTraceRecords)
        .set({
          status: "incomplete",
          reason: failureReason ?? "trace_sidecar_missing",
          updatedAt,
        })
        .where(and(
          eq(providerTraceRecords.id, row.id),
          isNull(providerTraceRecords.deletedAt),
          gt(providerTraceRecords.expiresAt, updatedAt),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!finalized) await getReadableByRun(runId, companyId);
      return finalized;
    }
    let invalidRecordCount = 0;
    const entries = bytes
      .toString("utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          return line.trim() ? [record(JSON.parse(line))] : [];
        } catch {
          invalidRecordCount += 1;
          return [];
        }
      });
    const frames = entries.filter((entry) => entry.kind === "frame");
    const requiredChannels = providerTraceRequiredChannels(row.provider);
    const integrity = assessProviderTraceEntries(entries, {
      invalidRecordCount,
      requiredChannels,
    });
    const terminalStatus = failureReason ? "incomplete" : integrity.status;
    const updatedAt = new Date();
    const finalized = await db
      .update(providerTraceRecords)
      .set({
        status: terminalStatus,
        frameCount: frames.length,
        byteCount: frames.reduce(
          (total, frame) => total + (Number(frame.byteLength) || 0),
          0,
        ),
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        reason: failureReason ?? integrity.reason,
        updatedAt,
      })
      .where(and(
        eq(providerTraceRecords.id, row.id),
        isNull(providerTraceRecords.deletedAt),
        gt(providerTraceRecords.expiresAt, updatedAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!finalized) await getReadableByRun(runId, companyId);
    return finalized;
  }

  async function inspect(runId: string, companyId: string) {
    const row = await getReadableByRun(runId, companyId);
    if (!row) return { trace: null, entries: [] };
    const entries = await readEntries(row.traceRef).catch(() => []);
    return {
      trace: asMetadata(row),
      entries: entries.map((entry) =>
        entry.kind === "frame" ? redactedFrame(entry) : entry,
      ),
    };
  }

  async function readExactEntries(runId: string, companyId: string) {
    const row = await getReadableByRun(runId, companyId);
    if (!row) return null;
    return readEntries(row.traceRef);
  }

  async function revealFrame(
    runId: string,
    companyId: string,
    frameId: number,
  ) {
    const row = await getReadableByRun(runId, companyId);
    if (!row) return null;
    const entry = (await readEntries(row.traceRef)).find(
      (candidate) =>
        candidate.kind === "frame" && Number(candidate.frameId) === frameId,
    );
    return entry
      ? (entry as unknown as ProviderTraceFrame & { kind: "frame" })
      : null;
  }

  async function download(runId: string, companyId: string) {
    const row = await getReadableByRun(runId, companyId);
    if (!row) return null;
    return { row, bytes: await readTraceBytes(row.traceRef) };
  }

  async function remove(runId: string, companyId: string) {
    const row = await getByRun(runId, companyId);
    if (!row || row.deletedAt) return null;
    // Manual deletion is filesystem-first and strict: a reported success must
    // never leave raw sidecars orphaned behind an inaccessible database row.
    await removeTraceFiles(row.traceRef);
    const now = new Date();
    return db
      .update(providerTraceRecords)
      .set({
        status: "deleted",
        deletedAt: now,
        updatedAt: now,
      })
      .where(eq(providerTraceRecords.id, row.id))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  return {
    prepare,
    finalize,
    inspect,
    readExactEntries,
    revealFrame,
    download,
    remove,
    getByRun,
    listMetadataForRuns,
    cleanupExpired,
  };
}
