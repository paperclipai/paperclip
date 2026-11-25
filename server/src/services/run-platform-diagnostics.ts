import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import {
  detectRunPlatformDiagnostics,
  isRunPlatformDiagnosticCode,
  RUN_PLATFORM_DIAGNOSTIC_CODES,
  type RunPlatformDiagnosticCode,
} from "@paperclipai/shared";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { logger } from "../middleware/logger.js";

export const RUN_PLATFORM_DIAGNOSTIC_EVENT_TYPE = "platform.diagnostic";
export const RUN_PLATFORM_DIAGNOSTIC_SOURCE_PREFIX = "platform-diagnostic:";
export const RUNTIME_DIAGNOSTICS_CAPABILITY_ENV = "PAPERCLIP_RUNTIME_DIAGNOSTICS_CAPABILITY";
const STACK_HOST_HEADER = "x-paperclip-cloud-tenant-host";
const STACK_DIAGNOSTICS_PATH = "/v1/customer-success/stack/diagnostics";
const MAX_SCAN_TEXT_BYTES = 256 * 1024;
const DIAGNOSTIC_REPORT_TIMEOUT_MS = 5_000;

function collectTextFragments(value: unknown, out: string[], remaining: { bytes: number }): void {
  if (remaining.bytes <= 0 || value == null) return;
  if (typeof value === "string") {
    const slice = value.length > remaining.bytes ? value.slice(0, remaining.bytes) : value;
    remaining.bytes -= slice.length;
    out.push(slice);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextFragments(item, out, remaining);
      if (remaining.bytes <= 0) break;
    }
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of [
      "aggregatedOutput",
      "output",
      "stderr",
      "stdout",
      "text",
      "delta",
      "message",
      "error",
      "detail",
      "reason",
    ]) {
      if (key in record) collectTextFragments(record[key], out, remaining);
    }
    for (const nestedKey of ["prpEvent", "payload", "item", "result", "update", "providerFailure"]) {
      if (nestedKey in record && typeof record[nestedKey] === "object" && record[nestedKey] !== null) {
        collectTextFragments(record[nestedKey], out, remaining);
      }
    }
  }
}

/**
 * Inspect a single persisted run event for closed-vocabulary platform diagnostics.
 * Returns sorted unique codes; returns empty quickly for streaming deltas that
 * do not carry known markers.
 */
export function extractRunPlatformDiagnosticsFromEvent(
  eventType: string,
  message: string | null | undefined,
  payload: Record<string, unknown> | null | undefined,
): RunPlatformDiagnosticCode[] {
  if (eventType === RUN_PLATFORM_DIAGNOSTIC_EVENT_TYPE) return [];
  const fragments: string[] = [];
  const budget = { bytes: MAX_SCAN_TEXT_BYTES };
  if (message) collectTextFragments(message, fragments, budget);
  if (payload) collectTextFragments(payload, fragments, budget);
  if (fragments.length === 0) return [];
  return detectRunPlatformDiagnostics(fragments.join("\n"));
}

export interface RecordRunPlatformDiagnosticsInput {
  companyId: string;
  runId: string;
  agentId: string;
  codes: readonly RunPlatformDiagnosticCode[];
  runStatus?: string | null;
  driverKind?: string | null;
  runtimeMode?: string | null;
  occurredAt?: Date;
}

/**
 * Persist deduplicated `platform.diagnostic` rows into `heartbeat_run_events`
 * (idempotent per `(runId, code)` via the existing unique `sourceEventId` index)
 * and, when running in Cloud with a diagnostics stack capability, emit a
 * bounded, PII-free summary to Paperclip Cloud.
 */
export async function recordRunPlatformDiagnostics(
  db: Db,
  input: RecordRunPlatformDiagnosticsInput,
  options: {
    env?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
    reportToCloud?: boolean;
  } = {},
): Promise<RunPlatformDiagnosticCode[]> {
  const uniqueCodes = [...new Set(input.codes)].filter(isRunPlatformDiagnosticCode).sort();
  if (uniqueCodes.length === 0) return [];

  const recorded: RunPlatformDiagnosticCode[] = [];
  for (const code of uniqueCodes) {
    // Stable per-code sequence so separate calls on the same run for different
    // codes never collide on the native (sourceInstanceId, sourceSeq) replay key.
    const sourceSeq = RUN_PLATFORM_DIAGNOSTIC_CODES.indexOf(code) + 1;
    if (sourceSeq <= 0) continue;
    try {
      const result = await appendHeartbeatRunEvent(db, {
        companyId: input.companyId,
        runId: input.runId,
        agentId: input.agentId,
        eventType: RUN_PLATFORM_DIAGNOSTIC_EVENT_TYPE,
        stream: "system",
        level: "warn",
        message: code,
        payload: {
          code,
          ...(input.driverKind ? { driverKind: input.driverKind } : {}),
          ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
        },
        nativeSource: {
          sourceInstanceId: `${input.runId}:platform-diagnostic`,
          sourceEventId: `${RUN_PLATFORM_DIAGNOSTIC_SOURCE_PREFIX}${code}`,
          sourceSeq,
          protocolSchemaVersion: 1,
          canonicalPayload: { code },
        },
      });
      if (result.disposition === "committed") recorded.push(code);
    } catch (err) {
      logger.warn({ err, runId: input.runId, code }, "failed to persist platform.diagnostic event");
    }
  }

  if (options.reportToCloud !== false && recorded.length > 0) {
    await sendRunPlatformDiagnosticsToCloud(
      {
        runId: input.runId,
        diagnosticCodes: recorded,
        runStatus: input.runStatus ?? "running",
        driverKind: input.driverKind ?? null,
        runtimeMode: input.runtimeMode ?? "native",
        occurredAt: (input.occurredAt ?? new Date()).toISOString(),
      },
      options,
    );
  }

  return recorded;
}

export interface CloudDiagnosticReportPayload {
  runId: string;
  diagnosticCodes: RunPlatformDiagnosticCode[];
  runStatus: string;
  driverKind: string | null;
  runtimeMode: string;
  occurredAt: string;
}

/**
 * Fire-and-forget PII-free report to Paperclip Cloud's stack-authenticated
 * diagnostics endpoint. Never throws; no-ops outside Cloud.
 */
export async function sendRunPlatformDiagnosticsToCloud(
  payload: CloudDiagnosticReportPayload,
  options: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const originRaw = env.PAPERCLIP_CLOUD_API_ORIGIN?.trim();
  const host = env.PAPERCLIP_PRIMARY_HOST?.trim();
  const capability = env[RUNTIME_DIAGNOSTICS_CAPABILITY_ENV]?.trim();
  if (!originRaw || !host || !capability || payload.diagnosticCodes.length === 0) return false;

  let origin: string;
  try {
    const parsed = new URL(originRaw);
    if (
      parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))
    ) {
      return false;
    }
    origin = parsed.origin;
  } catch {
    return false;
  }

  try {
    const response = await (options.fetcher ?? fetch)(`${origin}${STACK_DIAGNOSTICS_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        [STACK_HOST_HEADER]: host,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(DIAGNOSTIC_REPORT_TIMEOUT_MS),
    });
    return response.ok;
  } catch (err) {
    logger.warn({ err, runId: payload.runId }, "failed to send platform diagnostics to Cloud");
    return false;
  }
}

/**
 * Batch-load recorded platform diagnostic codes for a set of runs.
 * Used by customer-success `view: "summary"` and `runs.search`.
 */
export async function listRunPlatformDiagnostics(
  db: Db,
  runIds: readonly string[],
  companyId?: string,
): Promise<Map<string, RunPlatformDiagnosticCode[]>> {
  const byRun = new Map<string, RunPlatformDiagnosticCode[]>();
  if (runIds.length === 0) return byRun;

  const predicates = [
    inArray(heartbeatRunEvents.runId, [...runIds]),
    eq(heartbeatRunEvents.eventType, RUN_PLATFORM_DIAGNOSTIC_EVENT_TYPE),
  ];
  if (companyId) predicates.push(eq(heartbeatRunEvents.companyId, companyId));

  const rows = await db
    .select({
      runId: heartbeatRunEvents.runId,
      code: sql<string | null>`${heartbeatRunEvents.payload}->>'code'`,
    })
    .from(heartbeatRunEvents)
    .where(and(...predicates));

  const sets = new Map<string, Set<RunPlatformDiagnosticCode>>();
  for (const row of rows) {
    if (!isRunPlatformDiagnosticCode(row.code)) continue;
    let set = sets.get(row.runId);
    if (!set) {
      set = new Set();
      sets.set(row.runId, set);
    }
    set.add(row.code);
  }
  for (const [runId, set] of sets) {
    byRun.set(runId, [...set].sort());
  }
  return byRun;
}

/**
 * Finalize diagnostic recording when a run reaches a terminal state (including
 * `succeeded`), catching errors from `heartbeat_runs` columns and ensuring Cloud
 * receives the run's terminal `runStatus`, `driverKind`, and `runtimeMode`.
 */
export async function reportFinalizedRunDiagnostics(
  db: Db,
  run: {
    id: string;
    companyId: string;
    agentId: string;
    status: string;
    error?: string | null;
    stderrExcerpt?: string | null;
    driverKind?: string | null;
    runtimeMode?: string | null;
    finishedAt?: Date | null;
  },
  options: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch } = {},
): Promise<RunPlatformDiagnosticCode[]> {
  try {
    const needsReload =
      run.error === undefined ||
      run.stderrExcerpt === undefined ||
      run.driverKind === undefined ||
      run.runtimeMode === undefined;

    let errorText: string | null = run.error ?? null;
    let stderrText: string | null = run.stderrExcerpt ?? null;
    let driverKind: string | null = run.driverKind ?? null;
    let runtimeMode: string | null = run.runtimeMode ?? null;

    if (needsReload) {
      const [row] = await db
        .select({
          error: heartbeatRuns.error,
          stderrExcerpt: heartbeatRuns.stderrExcerpt,
          driverKind: heartbeatRuns.driverKind,
          runtimeMode: heartbeatRuns.runtimeMode,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)))
        .limit(1);
      if (row) {
        if (run.error === undefined) errorText = row.error;
        if (run.stderrExcerpt === undefined) stderrText = row.stderrExcerpt;
        if (run.driverKind === undefined) driverKind = row.driverKind;
        if (run.runtimeMode === undefined) runtimeMode = row.runtimeMode;
      }
    }

    const detected = detectRunPlatformDiagnostics([errorText ?? "", stderrText ?? ""].join("\n"));
    const existing = (await listRunPlatformDiagnostics(db, [run.id], run.companyId)).get(run.id) ?? [];
    const combined = [...new Set([...existing, ...detected])].sort();
    if (combined.length === 0) return [];

    // Persist any newly detected codes (e.g. from run.error / legacy stderrExcerpt).
    if (detected.some((code) => !existing.includes(code))) {
      await recordRunPlatformDiagnostics(
        db,
        {
          companyId: run.companyId,
          runId: run.id,
          agentId: run.agentId,
          codes: detected,
          runStatus: run.status,
          driverKind,
          runtimeMode,
          occurredAt: run.finishedAt ?? new Date(),
        },
        { ...options, reportToCloud: false },
      );
    }

    await sendRunPlatformDiagnosticsToCloud(
      {
        runId: run.id,
        diagnosticCodes: combined,
        runStatus: run.status,
        driverKind,
        runtimeMode: runtimeMode ?? "legacy",
        occurredAt: (run.finishedAt ?? new Date()).toISOString(),
      },
      options,
    );
    return combined;
  } catch (err) {
    logger.warn({ err, runId: run.id }, "failed to finalize run platform diagnostics");
    return [];
  }
}
