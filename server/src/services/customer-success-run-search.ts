import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
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
import { notFound } from "../errors.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";
import { getRunLogStore, isRunLogStoreType, type RunLogStore } from "./run-log-store.js";
import { listRunPlatformDiagnostics } from "./run-platform-diagnostics.js";

const DEFAULT_SEARCH_RUN_LIMIT = 100;
const MAX_COUNTED_RUNS_IN_WINDOW = 10_000;
const SEARCH_WALL_BUDGET_MS = 6_000;
const LOG_CHUNK_BYTES = 128 * 1024;
const MAX_LOG_BYTES_PER_RUN = 2 * 1024 * 1024;
const MAX_TOTAL_LOG_BYTES = 12 * 1024 * 1024;
const MAX_EXCERPT_CHARS = 240;

type TextRedactor = (text: string) => string;

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function findLiteralIndex(haystack: string, needle: string, caseSensitive: boolean): number {
  if (!haystack || !needle) return -1;
  return caseSensitive
    ? haystack.indexOf(needle)
    : haystack.toLowerCase().indexOf(needle.toLowerCase());
}

/**
 * Redact the full decoded source text BEFORE choosing, slicing, or collapsing
 * whitespace for the excerpt so registered secrets crossing excerpt boundaries
 * or spanning multiple lines can never leak partial fragments.
 */
function extractRedactedExcerpt(
  rawSource: string,
  needle: string,
  caseSensitive: boolean,
  redactor: TextRedactor,
): string | undefined {
  if (!rawSource || findLiteralIndex(rawSource, needle, caseSensitive) < 0) return undefined;
  const redacted = redactor(rawSource);
  let idx = findLiteralIndex(redacted, needle, caseSensitive);
  if (idx < 0) {
    // Pattern overlapped a redacted secret; center around the redaction marker.
    idx = redacted.indexOf(REDACTED_EVENT_VALUE);
    if (idx < 0) idx = 0;
  }
  const radius = Math.floor((MAX_EXCERPT_CHARS - Math.min(needle.length, MAX_EXCERPT_CHARS / 2)) / 2);
  const start = Math.max(0, idx - Math.max(20, radius));
  const end = Math.min(redacted.length, start + MAX_EXCERPT_CHARS);
  const snippet = redacted.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < redacted.length ? "…" : "";
  return `${prefix}${snippet}${suffix}`;
}

function isStatementTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { code?: unknown; cause?: { code?: unknown } };
  return record.code === "57014" || record.cause?.code === "57014";
}

function buildEventMatchCondition(pattern: string, caseSensitive: boolean): SQL {
  const jsonInner = JSON.stringify(pattern).slice(1, -1);
  if (caseSensitive) {
    if (jsonInner === pattern) {
      return sql`(strpos(coalesce(${schema.heartbeatRunEvents.message}, ''), ${pattern}) > 0 OR strpos(coalesce(${schema.heartbeatRunEvents.payload}::text, ''), ${pattern}) > 0)`;
    }
    return sql`(strpos(coalesce(${schema.heartbeatRunEvents.message}, ''), ${pattern}) > 0 OR strpos(coalesce(${schema.heartbeatRunEvents.payload}::text, ''), ${pattern}) > 0 OR strpos(coalesce(${schema.heartbeatRunEvents.payload}::text, ''), ${jsonInner}) > 0)`;
  }
  if (jsonInner === pattern) {
    return sql`(strpos(lower(coalesce(${schema.heartbeatRunEvents.message}, '')), lower(${pattern})) > 0 OR strpos(lower(coalesce(${schema.heartbeatRunEvents.payload}::text, '')), lower(${pattern})) > 0)`;
  }
  return sql`(strpos(lower(coalesce(${schema.heartbeatRunEvents.message}, '')), lower(${pattern})) > 0 OR strpos(lower(coalesce(${schema.heartbeatRunEvents.payload}::text, '')), lower(${pattern})) > 0 OR strpos(lower(coalesce(${schema.heartbeatRunEvents.payload}::text, '')), lower(${jsonInner})) > 0)`;
}

function collectDecodedStrings(value: unknown, out: string[]): void {
  if (value == null) return;
  if (typeof value === "string") {
    if (value.length > 0) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDecodedStrings(item, out);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectDecodedStrings(v, out);
    }
  }
}

function findDecodedEventMatch(
  message: string | null | undefined,
  payload: unknown,
  pattern: string,
  caseSensitive: boolean,
): string | undefined {
  if (typeof message === "string" && findLiteralIndex(message, pattern, caseSensitive) >= 0) {
    return message;
  }
  const strings: string[] = [];
  collectDecodedStrings(payload, strings);
  for (const text of strings) {
    if (findLiteralIndex(text, pattern, caseSensitive) >= 0) return text;
  }
  return undefined;
}

/**
 * Decode complete NDJSON run-log lines into their literal `chunk` payloads so
 * callers can search literal quotes, backslashes, and newlines rather than JSON
 * escape sequences. Non-JSON lines fall back to their literal text.
 */
function decodeNdjsonChunkText(content: string): string {
  const parts: string[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!trimmed) continue;
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as { chunk?: unknown };
        if (typeof parsed.chunk === "string") {
          parts.push(parsed.chunk);
          continue;
        }
      } catch {
        // Fall back to literal line below when not valid JSON.
      }
    }
    parts.push(trimmed);
  }
  return parts.join("");
}

async function readWithDeadline<T>(
  promise: Promise<T>,
  remainingMs: number,
  controller: AbortController,
): Promise<T> {
  if (remainingMs <= 0) {
    controller.abort();
    throw new Error("search deadline exceeded");
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("search deadline exceeded"));
        }, remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function scanRunLogForPatterns(
  logStore: RunLogStore,
  store: "local_file" | "s3_segments" | "s3_archive",
  logRef: string,
  patterns: readonly string[],
  caseSensitive: boolean,
  remainingIndexes: Set<number>,
  redactor: TextRedactor | null,
  budget: { bytes: number; deadlineMs: number; now: () => number },
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
  let lineRemainder = "";
  let truncated = false;

  while (remainingIndexes.size > 0) {
    const remainingMs = budget.deadlineMs - budget.now();
    if (remainingMs <= 0 || budget.bytes <= 0 || scannedForRun >= MAX_LOG_BYTES_PER_RUN) {
      truncated = true;
      break;
    }
    const readLimit = Math.min(LOG_CHUNK_BYTES, budget.bytes, MAX_LOG_BYTES_PER_RUN - scannedForRun);
    const controller = new AbortController();
    let chunk: { content: string; nextOffset?: number };
    try {
      chunk = await readWithDeadline(
        logStore.read({ store, logRef }, { offset, limitBytes: readLimit, signal: controller.signal }),
        remainingMs,
        controller,
      );
    } catch {
      truncated = true;
      break;
    }
    if (!chunk.content) break;

    // Preserve multibyte UTF-8 boundaries and whole NDJSON lines across paged reads.
    let usableContent = chunk.content;
    let nextOffset = chunk.nextOffset;
    const isEof = nextOffset === undefined || nextOffset <= offset;
    if (!isEof) {
      const lastNewline = chunk.content.lastIndexOf("\n");
      if (lastNewline >= 0) {
        usableContent = chunk.content.slice(0, lastNewline + 1);
        const usableBytes = Buffer.byteLength(usableContent, "utf8");
        if (usableBytes > 0) nextOffset = offset + usableBytes;
      } else if (usableContent.endsWith("\uFFFD")) {
        // A multibyte UTF-8 character was cut at the page boundary. Re-encoding the
        // clean prefix gives the exact byte offset where that character begins.
        const cleanPrefix = usableContent.replace(/\uFFFD+$/, "");
        const cleanBytes = Buffer.byteLength(cleanPrefix, "utf8");
        if (cleanBytes > 0) {
          usableContent = cleanPrefix;
          nextOffset = offset + cleanBytes;
        }
      }
    }

    const chunkBytes = Buffer.byteLength(usableContent, "utf8");
    budget.bytes -= chunkBytes;
    scannedForRun += chunkBytes;

    const combinedLines = lineRemainder + usableContent;
    let textToDecode = "";
    if (isEof) {
      textToDecode = combinedLines;
      lineRemainder = "";
    } else {
      const lastNewline = combinedLines.lastIndexOf("\n");
      if (lastNewline >= 0) {
        textToDecode = combinedLines.slice(0, lastNewline + 1);
        lineRemainder = combinedLines.slice(lastNewline + 1);
      } else if (combinedLines.length <= LOG_CHUNK_BYTES * 2) {
        lineRemainder = combinedLines;
      } else {
        // Extremely long non-newline line: decode incrementally instead of buffering unboundedly.
        textToDecode = combinedLines;
        lineRemainder = "";
      }
    }

    if (textToDecode) {
      const decoded = decodeNdjsonChunkText(textToDecode);
      const windowText = tail + decoded;
      for (const idx of [...remainingIndexes]) {
        const pattern = patterns[idx]!;
        if (findLiteralIndex(windowText, pattern, caseSensitive) >= 0) {
          matched.set(
            idx,
            redactor ? extractRedactedExcerpt(windowText, pattern, caseSensitive, redactor) : undefined,
          );
          remainingIndexes.delete(idx);
        }
      }
      tail = overlapChars > 0 ? windowText.slice(-overlapChars) : "";
    }

    if (isEof) break;
    offset = nextOffset!;
  }

  return { matched, truncated };
}

/**
 * Bounded, read-only, match-only search across a tenant stack's runs.
 *
 * Phase 1 runs inside a read-only repeatable-read DB transaction with a local
 * statement timeout bound to the remaining search deadline: it loads candidate
 * runs, runs in-database `strpos` matching over `heartbeat_run_events` (both raw
 * and JSON-escaped literal forms, verified against decoded JSON strings), and
 * pre-resolves run secret redactors only when `includeExcerpts: true`.
 *
 * Phase 2 runs OUTSIDE the database transaction so fallback `RunLogStore` reads
 * (local disk or S3) never hold a DB snapshot or pool connection open, and each
 * read is bounded by the remaining wall-clock deadline via `AbortSignal`.
 *
 * Zero customer prose leaves the stack unless `includeExcerpts: true` (which
 * requires an explicit `companyId` and redacts the full decoded text before
 * choosing or slicing any excerpt).
 */
export async function searchCustomerSuccessRuns(
  db: Db,
  q: InspectionQuery,
  options: { now?: () => number; wallBudgetMs?: number; logStore?: RunLogStore } = {},
): Promise<InspectionRunSearchResult> {
  const now = options.now ?? Date.now;
  const wallBudgetMs = options.wallBudgetMs ?? SEARCH_WALL_BUDGET_MS;
  const deadlineMs = now() + wallBudgetMs;
  const patterns = q.patterns!;
  const caseSensitive = q.caseSensitive === true;
  const includeExcerpts = q.includeExcerpts === true;
  const limit = Math.min(MAX_INSPECTION_SEARCH_RUNS, Math.max(1, q.limit ?? DEFAULT_SEARCH_RUN_LIMIT));

  type CandidateRun = {
    id: string;
    companyId: string;
    status: string;
    driverKind: string | null;
    runtimeMode: string;
    error: string | null;
    errorCode: string | null;
    stderrExcerpt: string | null;
    stdoutExcerpt: string | null;
    logStore: string | null;
    logRef: string | null;
    createdAt: Date;
  };

  // Phase 1: Bounded DB queries inside a read-only repeatable-read transaction.
  const dbPhase = await db.transaction(
    async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const statementTimeoutMs = Math.max(100, Math.min(wallBudgetMs, deadlineMs - now()));
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${Math.floor(statementTimeoutMs)}'`));

      if (q.companyId) {
        const [company] = await tx
          .select({ id: schema.companies.id })
          .from(schema.companies)
          .where(eq(schema.companies.id, q.companyId));
        if (!company) throw notFound("Inspection company not found");
      }

      const runPredicates: SQL[] = [];
      if (q.companyId) runPredicates.push(eq(schema.heartbeatRuns.companyId, q.companyId));
      if (q.createdAfter) runPredicates.push(gte(schema.heartbeatRuns.createdAt, new Date(q.createdAfter)));
      if (q.createdBefore) runPredicates.push(lt(schema.heartbeatRuns.createdAt, new Date(q.createdBefore)));
      const whereClause = runPredicates.length > 0 ? and(...runPredicates) : undefined;

      // Bound the total count scan so a stack with huge history never stalls here.
      const cappedSubquery = tx
        .select({ one: sql<number>`1`.as("one") })
        .from(schema.heartbeatRuns)
        .where(whereClause)
        .limit(MAX_COUNTED_RUNS_IN_WINDOW + 1)
        .as("capped_runs");
      const [{ total: totalRaw }] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(cappedSubquery);
      const countHitCap = Number(totalRaw) > MAX_COUNTED_RUNS_IN_WINDOW;
      const runsTotalInWindow = Math.min(Number(totalRaw), MAX_COUNTED_RUNS_IN_WINDOW);

      const runs: CandidateRun[] = await tx
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

      let truncated = countHitCap || runsTotalInWindow > runs.length;
      if (runs.length === 0) {
        return {
          runs,
          runsTotalInWindow,
          truncated,
          diagnosticsByRun: new Map<string, string[]>(),
          matchedByRun: new Map<string, Map<number, string | undefined>>(),
          runsWithEvents: new Set<string>(),
          redactorsByRun: new Map<string, TextRedactor>(),
        };
      }

      const runIds = runs.map((r) => r.id);
      const diagnosticsByRun = await listRunPlatformDiagnostics(tx, runIds, q.companyId);
      const redactions = includeExcerpts ? createRunSecretRedactionRegistry(tx) : null;
      const redactorsByRun = new Map<string, TextRedactor>();

      const getRedactor = async (companyId: string, runId: string): Promise<TextRedactor | null> => {
        if (!redactions) return null;
        let redactor = redactorsByRun.get(runId);
        if (!redactor) {
          redactor = await redactions.redactorForRun(companyId, runId);
          redactorsByRun.set(runId, redactor);
        }
        return redactor;
      };

      const matchedByRun = new Map<string, Map<number, string | undefined>>();
      for (const run of runs) {
        const hits = new Map<number, string | undefined>();
        const runFields = [run.error, run.errorCode, run.stderrExcerpt, run.stdoutExcerpt]
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .join("\n");
        if (runFields) {
          for (let i = 0; i < patterns.length; i++) {
            const pattern = patterns[i]!;
            if (findLiteralIndex(runFields, pattern, caseSensitive) >= 0) {
              const redactor = includeExcerpts ? await getRedactor(run.companyId, run.id) : null;
              hits.set(
                i,
                redactor ? extractRedactedExcerpt(runFields, pattern, caseSensitive, redactor) : undefined,
              );
            }
          }
        }
        matchedByRun.set(run.id, hits);
      }

      const eventRunRows = await tx
        .selectDistinct({ runId: schema.heartbeatRunEvents.runId })
        .from(schema.heartbeatRunEvents)
        .where(inArray(schema.heartbeatRunEvents.runId, runIds));
      const runsWithEvents = new Set(eventRunRows.map((r) => r.runId));

      // Push literal substring pre-filtering into PostgreSQL (raw + JSON-escaped
      // forms) and verify against decoded JSON string values in bounded batches so
      // counts are identical with or without excerpts and genuine matches behind
      // JSON-key hits are never silently dropped.
      const EVENT_CANDIDATE_BATCH_SIZE = 10;
      const MAX_EVENT_CANDIDATES_PER_RUN = 100;
      const runById = new Map(runs.map((r) => [r.id, r]));

      for (let i = 0; i < patterns.length; i++) {
        if (now() >= deadlineMs) {
          truncated = true;
          break;
        }
        const pattern = patterns[i]!;
        let remainingIds = runIds.filter((id) => !matchedByRun.get(id)!.has(i) && runsWithEvents.has(id));
        if (remainingIds.length === 0) continue;

        const matchCondition = buildEventMatchCondition(pattern, caseSensitive);
        let excerptsAdded = runs.filter((r) => matchedByRun.get(r.id)!.has(i)).length;

        try {
          for (
            let batchStart = 1;
            remainingIds.length > 0 && batchStart <= MAX_EVENT_CANDIDATES_PER_RUN;
            batchStart += EVENT_CANDIDATE_BATCH_SIZE
          ) {
            if (now() >= deadlineMs) {
              truncated = true;
              break;
            }
            const batchEnd = Math.min(batchStart + EVENT_CANDIDATE_BATCH_SIZE - 1, MAX_EVENT_CANDIDATES_PER_RUN);
            const ranked = tx
              .select({
                runId: schema.heartbeatRunEvents.runId,
                message: schema.heartbeatRunEvents.message,
                payload: schema.heartbeatRunEvents.payload,
                rn: sql<number>`row_number() over (partition by ${schema.heartbeatRunEvents.runId} order by ${schema.heartbeatRunEvents.seq} asc)`.as(
                  "rn",
                ),
              })
              .from(schema.heartbeatRunEvents)
              .where(and(inArray(schema.heartbeatRunEvents.runId, remainingIds), matchCondition))
              .as("ranked_events");

            const eventRows = await tx
              .select({
                runId: ranked.runId,
                message: ranked.message,
                payload: ranked.payload,
              })
              .from(ranked)
              .where(sql`${ranked.rn} >= ${batchStart} and ${ranked.rn} <= ${batchEnd}`);

            const rowsSeenByRun = new Map<string, number>();
            for (const eventRow of eventRows) {
              rowsSeenByRun.set(eventRow.runId, (rowsSeenByRun.get(eventRow.runId) ?? 0) + 1);
              const hits = matchedByRun.get(eventRow.runId);
              if (!hits || hits.has(i)) continue;
              const decoded = findDecodedEventMatch(eventRow.message, eventRow.payload, pattern, caseSensitive);
              if (decoded === undefined) continue;
              let excerpt: string | undefined;
              if (includeExcerpts && excerptsAdded < MAX_INSPECTION_SEARCH_SAMPLE_RUNS) {
                const run = runById.get(eventRow.runId)!;
                const redactor = await getRedactor(run.companyId, run.id);
                if (redactor) {
                  excerpt = extractRedactedExcerpt(decoded, pattern, caseSensitive, redactor);
                  excerptsAdded += 1;
                }
              }
              hits.set(i, excerpt);
            }

            const expectedFullBatch = batchEnd - batchStart + 1;
            // Only keep runs that have not yet matched AND filled the entire batch
            // (meaning more SQL-matching events may exist for that run).
            remainingIds = remainingIds.filter(
              (id) => !matchedByRun.get(id)!.has(i) && (rowsSeenByRun.get(id) ?? 0) >= expectedFullBatch,
            );
          }

          if (remainingIds.length > 0) {
            truncated = true;
          }
        } catch (err) {
          if (isStatementTimeoutError(err)) {
            truncated = true;
            break;
          }
          throw err;
        }
      }

      // Always pre-resolve secret redactors inside the tx for any runs that will need
      // RunLogStore fallback scanning when excerpts are requested, even when `truncated`
      // is already true (e.g. runsTotalInWindow > limit).
      if (includeExcerpts) {
        for (const run of runs) {
          if (!run.logRef || !isRunLogStoreType(run.logStore)) continue;
          const needsLogScan = run.runtimeMode !== "native" || !runsWithEvents.has(run.id);
          if (!needsLogScan) continue;
          const hits = matchedByRun.get(run.id)!;
          if (hits.size < patterns.length) {
            await getRedactor(run.companyId, run.id);
          }
        }
      }

      return {
        runs,
        runsTotalInWindow,
        truncated,
        diagnosticsByRun,
        matchedByRun,
        runsWithEvents,
        redactorsByRun,
      };
    },
    { accessMode: "read only", isolationLevel: "repeatable read" },
  );

  // Phase 2: Outside any DB transaction, scan fallback RunLogStore streams with
  // per-read AbortSignal + wall-clock budget.
  const { runs, runsTotalInWindow, diagnosticsByRun, matchedByRun, runsWithEvents, redactorsByRun } = dbPhase;
  let truncated = dbPhase.truncated;

  const byStatus: Record<string, number> = {};
  const byDriver: Record<string, number> = {};
  const byDiagnostic: Record<string, number> = {};

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

  for (const run of runs) {
    increment(byStatus, run.status);
    increment(byDriver, run.driverKind ?? "unknown");
    for (const code of diagnosticsByRun.get(run.id) ?? []) {
      increment(byDiagnostic, code);
    }
  }

  const logStore = options.logStore ?? getRunLogStore();
  const logBudget = { bytes: MAX_TOTAL_LOG_BYTES, deadlineMs, now };
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
      logStore,
      run.logStore,
      String(run.logRef),
      patterns,
      caseSensitive,
      remaining,
      // Fail closed: never use an identity fallback when includeExcerpts is true.
      includeExcerpts ? (redactorsByRun.get(run.id) ?? null) : null,
      logBudget,
    );
    if (scanned.truncated) truncated = true;
    for (const [patternIdx, excerpt] of scanned.matched) {
      hits.set(patternIdx, excerpt);
    }
  }

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
        const excerpt = includeExcerpts ? hits.get(idx) : undefined;
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

  const coOccurrence = [...coOccurrenceCounts.values()].sort(
    (a, b) => b.matchedRuns - a.matchedRuns || a.patterns.join("\0").localeCompare(b.patterns.join("\0")),
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
