import { and, count, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import * as schema from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  MAX_INSPECTION_SEARCH_RUNS,
  MAX_INSPECTION_SEARCH_SAMPLE_RUNS,
  type InspectionQuery,
  type InspectionRunSearchPatternHit,
  type InspectionRunSearchResult,
  type InspectionRunSearchSample,
} from "@paperclipai/shared";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";
import { getRunLogStore, isRunLogStoreType } from "./run-log-store.js";
import { listRunPlatformDiagnostics } from "./run-platform-diagnostics.js";

const DEFAULT_SEARCH_RUN_LIMIT = 100;
const SEARCH_WALL_BUDGET_MS = 6_000;
const LOG_CHUNK_BYTES = 128 * 1024;
const MAX_LOG_BYTES_PER_RUN = 2 * 1024 * 1024;
const MAX_TOTAL_LOG_BYTES = 12 * 1024 * 1024;
const MAX_EXCERPT_CHARS = 240;

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function findLiteralIndex(haystack: string, needle: string, caseSensitive: boolean): number {
  if (!haystack || !needle) return -1;
  return caseSensitive
    ? haystack.indexOf(needle)
    : haystack.toLowerCase().indexOf(needle.toLowerCase());
}

function extractExcerpt(haystack: string, needle: string, caseSensitive: boolean): string | undefined {
  const idx = findLiteralIndex(haystack, needle, caseSensitive);
  if (idx < 0) return undefined;
  const radius = Math.floor((MAX_EXCERPT_CHARS - needle.length) / 2);
  const start = Math.max(0, idx - Math.max(20, radius));
  const end = Math.min(haystack.length, start + MAX_EXCERPT_CHARS);
  const snippet = haystack.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < haystack.length ? "…" : "";
  return `${prefix}${snippet}${suffix}`;
}

async function scanRunLogForPatterns(
  store: "local_file" | "s3_segments" | "s3_archive",
  logRef: string,
  patterns: readonly string[],
  caseSensitive: boolean,
  remainingIndexes: Set<number>,
  includeExcerpts: boolean,
  budget: { bytes: number; deadlineMs: number },
): Promise<{
  matched: Map<number, string | undefined>;
  truncated: boolean;
}> {
  const matched = new Map<number, string | undefined>();
  if (remainingIndexes.size === 0) return { matched, truncated: false };
  const maxPatternLen = Math.max(...patterns.map((p) => p.length));
  const overlapChars = Math.max(0, maxPatternLen - 1);
  let offset = 0;
  let scannedForRun = 0;
  let tail = "";
  let truncated = false;
  const logStore = getRunLogStore();

  while (remainingIndexes.size > 0) {
    if (Date.now() >= budget.deadlineMs || budget.bytes <= 0 || scannedForRun >= MAX_LOG_BYTES_PER_RUN) {
      truncated = true;
      break;
    }
    const readLimit = Math.min(LOG_CHUNK_BYTES, budget.bytes, MAX_LOG_BYTES_PER_RUN - scannedForRun);
    let chunk: { content: string; nextOffset?: number };
    try {
      chunk = await logStore.read({ store, logRef }, { offset, limitBytes: readLimit });
    } catch {
      break;
    }
    if (!chunk.content) break;
    const chunkBytes = Buffer.byteLength(chunk.content, "utf8");
    budget.bytes -= chunkBytes;
    scannedForRun += chunkBytes;

    const windowText = tail + chunk.content;
    for (const idx of [...remainingIndexes]) {
      const pattern = patterns[idx]!;
      if (findLiteralIndex(windowText, pattern, caseSensitive) >= 0) {
        matched.set(idx, includeExcerpts ? extractExcerpt(windowText, pattern, caseSensitive) : undefined);
        remainingIndexes.delete(idx);
      }
    }

    if (chunk.nextOffset === undefined || chunk.nextOffset <= offset) break;
    offset = chunk.nextOffset;
    tail = overlapChars > 0 ? windowText.slice(-overlapChars) : "";
  }

  return { matched, truncated };
}

/**
 * Bounded, read-only, match-only search across a tenant stack's runs.
 *
 * Checks `heartbeat_runs` columns, runs in-database `strpos` matching over
 * `heartbeat_run_events` (so native runs never ship megabytes of JSONB or pull
 * S3 logs), and falls back to streaming `RunLogStore` with overlap windows for
 * legacy/non-native runs or runs without stored events.
 *
 * Zero customer prose leaves the stack unless `includeExcerpts: true` (which
 * requires an explicit `companyId` and redacts every snippet via the run's
 * secret redaction registry).
 */
export async function searchCustomerSuccessRuns(
  tx: Db,
  q: InspectionQuery,
  options: { now?: () => number; wallBudgetMs?: number } = {},
): Promise<InspectionRunSearchResult> {
  const now = options.now ?? Date.now;
  const deadlineMs = now() + (options.wallBudgetMs ?? SEARCH_WALL_BUDGET_MS);
  const patterns = q.patterns!;
  const caseSensitive = q.caseSensitive === true;
  const includeExcerpts = q.includeExcerpts === true;
  const limit = Math.min(MAX_INSPECTION_SEARCH_RUNS, Math.max(1, q.limit ?? DEFAULT_SEARCH_RUN_LIMIT));

  const runPredicates: SQL[] = [];
  if (q.companyId) runPredicates.push(eq(schema.heartbeatRuns.companyId, q.companyId));
  if (q.createdAfter) runPredicates.push(gte(schema.heartbeatRuns.createdAt, new Date(q.createdAfter)));
  if (q.createdBefore) runPredicates.push(lt(schema.heartbeatRuns.createdAt, new Date(q.createdBefore)));
  const whereClause = runPredicates.length > 0 ? and(...runPredicates) : undefined;

  const [{ total: totalRaw }] = await tx
    .select({ total: count() })
    .from(schema.heartbeatRuns)
    .where(whereClause);
  const runsTotalInWindow = Number(totalRaw);

  const runs = await tx
    .select({
      id: schema.heartbeatRuns.id,
      companyId: schema.heartbeatRuns.companyId,
      status: schema.heartbeatRuns.status,
      driverKind: schema.heartbeatRuns.driverKind,
      runtimeMode: schema.heartbeatRuns.runtimeMode,
      error: schema.heartbeatRuns.error,
      errorCode: schema.heartbeatRuns.errorCode,
      stderrExcerpt: schema.heartbeatRuns.stderrExcerpt,
      stdoutExcerpt: schema.heartbeatRuns.stdoutExcerpt,
      logStore: schema.heartbeatRuns.logStore,
      logRef: schema.heartbeatRuns.logRef,
      createdAt: schema.heartbeatRuns.createdAt,
    })
    .from(schema.heartbeatRuns)
    .where(whereClause)
    .orderBy(desc(schema.heartbeatRuns.createdAt), desc(schema.heartbeatRuns.id))
    .limit(limit);

  const byStatus: Record<string, number> = {};
  const byDriver: Record<string, number> = {};
  const byDiagnostic: Record<string, number> = {};
  let truncated = runsTotalInWindow > runs.length;

  const patternHits: InspectionRunSearchPatternHit[] = patterns.map((pattern) => ({
    pattern,
    matchedRuns: 0,
    byStatus: {},
    byDriver: {},
    byRuntimeMode: {},
    firstSeenAt: null,
    lastSeenAt: null,
    sampleRuns: [],
  }));

  if (runs.length === 0) {
    return {
      runsScanned: 0,
      runsTotalInWindow,
      truncated,
      byStatus,
      byDriver,
      byDiagnostic,
      patterns: patternHits,
      coOccurrence: [],
    };
  }

  const runIds = runs.map((r) => r.id);
  const diagnosticsByRun = await listRunPlatformDiagnostics(tx, runIds, q.companyId);

  // Per-run matched pattern indexes and optional unredacted excerpt candidates.
  const matchedByRun = new Map<string, Map<number, string | undefined>>();
  for (const run of runs) {
    increment(byStatus, run.status);
    increment(byDriver, run.driverKind ?? "unknown");
    for (const code of diagnosticsByRun.get(run.id) ?? []) {
      increment(byDiagnostic, code);
    }

    const hits = new Map<number, string | undefined>();
    const runFields = [run.error, run.errorCode, run.stderrExcerpt, run.stdoutExcerpt]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join("\n");
    if (runFields) {
      for (let i = 0; i < patterns.length; i++) {
        if (findLiteralIndex(runFields, patterns[i]!, caseSensitive) >= 0) {
          hits.set(i, includeExcerpts ? extractExcerpt(runFields, patterns[i]!, caseSensitive) : undefined);
        }
      }
    }
    matchedByRun.set(run.id, hits);
  }

  // Track which runs actually have rows in heartbeat_run_events (for fallback decisions).
  const eventCountRows = await tx
    .select({
      runId: schema.heartbeatRunEvents.runId,
      total: count(),
    })
    .from(schema.heartbeatRunEvents)
    .where(inArray(schema.heartbeatRunEvents.runId, runIds))
    .groupBy(schema.heartbeatRunEvents.runId);
  const runsWithEvents = new Set(eventCountRows.filter((r) => Number(r.total) > 0).map((r) => r.runId));

  // Push literal substring matching into PostgreSQL so megabytes of event JSONB
  // never cross the wire just to answer a boolean match.
  for (let i = 0; i < patterns.length; i++) {
    if (now() >= deadlineMs) {
      truncated = true;
      break;
    }
    const pattern = patterns[i]!;
    const candidateIds = runIds.filter((id) => !matchedByRun.get(id)!.has(i) && runsWithEvents.has(id));
    if (candidateIds.length === 0) continue;

    const matchCondition = caseSensitive
      ? sql`(strpos(coalesce(${schema.heartbeatRunEvents.message}, ''), ${pattern}) > 0 OR strpos(coalesce(${schema.heartbeatRunEvents.payload}::text, ''), ${pattern}) > 0)`
      : sql`(strpos(lower(coalesce(${schema.heartbeatRunEvents.message}, '')), lower(${pattern})) > 0 OR strpos(lower(coalesce(${schema.heartbeatRunEvents.payload}::text, '')), lower(${pattern})) > 0)`;

    const eventMatches = await tx
      .selectDistinct({ runId: schema.heartbeatRunEvents.runId })
      .from(schema.heartbeatRunEvents)
      .where(and(inArray(schema.heartbeatRunEvents.runId, candidateIds), matchCondition));

    for (const match of eventMatches) {
      matchedByRun.get(match.runId)!.set(i, undefined);
    }
  }

  // Fallback to streaming RunLogStore for legacy/non-native runs (whose stdout/stderr
  // lives only in runs.log) or runs with a logRef and zero stored events.
  const logBudget = { bytes: MAX_TOTAL_LOG_BYTES, deadlineMs };
  for (const run of runs) {
    if (!run.logRef || !isRunLogStoreType(run.logStore)) continue;
    const needsLogScan = run.runtimeMode !== "native" || !runsWithEvents.has(run.id);
    if (!needsLogScan) continue;

    const hits = matchedByRun.get(run.id)!;
    const remaining = new Set<number>();
    for (let i = 0; i < patterns.length; i++) {
      if (!hits.has(i)) remaining.add(i);
    }
    if (remaining.size === 0) continue;

    const scanned = await scanRunLogForPatterns(
      run.logStore,
      String(run.logRef),
      patterns,
      caseSensitive,
      remaining,
      includeExcerpts,
      logBudget,
    );
    if (scanned.truncated) truncated = true;
    for (const [patternIdx, excerpt] of scanned.matched) {
      hits.set(patternIdx, excerpt);
    }
  }

  // Fetch redacted excerpts ONLY when explicitly requested on a company-scoped
  // single-stack search, and only for the first MAX_INSPECTION_SEARCH_SAMPLE_RUNS hits.
  const redactions = includeExcerpts ? createRunSecretRedactionRegistry(tx) : null;
  const coOccurrenceCounts = new Map<string, { patterns: string[]; matchedRuns: number }>();

  for (const run of runs) {
    const hits = matchedByRun.get(run.id)!;
    if (hits.size === 0) continue;
    const createdAtIso = run.createdAt.toISOString();
    const driver = run.driverKind ?? "unknown";
    const diagnostics = diagnosticsByRun.get(run.id) ?? [];

    const matchedIndexes = [...hits.keys()].sort((a, b) => a - b);
    const coKey = matchedIndexes.join(",");
    const existingCo = coOccurrenceCounts.get(coKey);
    if (existingCo) {
      existingCo.matchedRuns += 1;
    } else {
      coOccurrenceCounts.set(coKey, {
        patterns: matchedIndexes.map((idx) => patterns[idx]!),
        matchedRuns: 1,
      });
    }

    for (const idx of matchedIndexes) {
      const bucket = patternHits[idx]!;
      bucket.matchedRuns += 1;
      increment(bucket.byStatus, run.status);
      increment(bucket.byDriver, driver);
      increment(bucket.byRuntimeMode, run.runtimeMode);
      if (bucket.firstSeenAt === null || createdAtIso < bucket.firstSeenAt) bucket.firstSeenAt = createdAtIso;
      if (bucket.lastSeenAt === null || createdAtIso > bucket.lastSeenAt) bucket.lastSeenAt = createdAtIso;

      if (bucket.sampleRuns.length < MAX_INSPECTION_SEARCH_SAMPLE_RUNS) {
        let excerpt: string | undefined;
        if (includeExcerpts && redactions) {
          let rawExcerpt = hits.get(idx);
          if (!rawExcerpt && now() < deadlineMs) {
            const pattern = patterns[idx]!;
            const matchCondition = caseSensitive
              ? sql`(strpos(coalesce(${schema.heartbeatRunEvents.message}, ''), ${pattern}) > 0 OR strpos(coalesce(${schema.heartbeatRunEvents.payload}::text, ''), ${pattern}) > 0)`
              : sql`(strpos(lower(coalesce(${schema.heartbeatRunEvents.message}, '')), lower(${pattern})) > 0 OR strpos(lower(coalesce(${schema.heartbeatRunEvents.payload}::text, '')), lower(${pattern})) > 0)`;
            const [eventRow] = await tx
              .select({
                message: schema.heartbeatRunEvents.message,
                payloadText: sql<string>`coalesce(${schema.heartbeatRunEvents.payload}::text, '')`,
              })
              .from(schema.heartbeatRunEvents)
              .where(and(eq(schema.heartbeatRunEvents.runId, run.id), matchCondition))
              .limit(1);
            if (eventRow) {
              rawExcerpt =
                extractExcerpt(eventRow.message ?? "", pattern, caseSensitive) ??
                extractExcerpt(eventRow.payloadText ?? "", pattern, caseSensitive);
            }
          }
          if (rawExcerpt) {
            excerpt = await redactions.redactForRun(run.companyId, run.id, rawExcerpt);
          }
        }
        const sample: InspectionRunSearchSample = {
          runId: run.id,
          companyId: run.companyId,
          status: run.status,
          driverKind: run.driverKind,
          runtimeMode: run.runtimeMode,
          createdAt: createdAtIso,
          diagnostics,
          ...(excerpt ? { excerpt } : {}),
        };
        bucket.sampleRuns.push(sample);
      }
    }
  }

  const coOccurrence = [...coOccurrenceCounts.values()].sort((a, b) =>
    b.matchedRuns - a.matchedRuns || a.patterns.join("\0").localeCompare(b.patterns.join("\0")),
  );

  return {
    runsScanned: runs.length,
    runsTotalInWindow,
    truncated,
    byStatus,
    byDriver,
    byDiagnostic,
    patterns: patternHits,
    coOccurrence,
  };
}
