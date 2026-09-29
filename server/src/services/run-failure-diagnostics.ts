import type { heartbeatRuns } from "@paperclipai/db";
import { redactDiagnosticText } from "@paperclipai/adapter-utils/command-redaction";
import { redactEnvForLogs } from "@paperclipai/adapter-utils/server-utils";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactSensitiveText } from "../redaction.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Context = Record<string, string | number | boolean>;

export interface RunFailureReportOptions {
  /** The caught exception, before callers flatten it to a message. */
  error?: unknown;
  /** Structured adapter error metadata; only known diagnostic keys are read. */
  adapterErrorMeta?: unknown;
  phase?: "setup" | "execute";
  /** Runtime-only values to redact; never included in the captured event. */
  secretValues?: readonly string[];
}

export interface RunFailureException {
  name?: string;
  message?: string;
  stack?: string;
  code?: string;
  status?: number;
  requestId?: string;
}

export interface RunFailureDiagnostics {
  execution: Context;
  adapter: Context;
  provider: Context;
  exceptions: RunFailureException[];
  truncatedFields: string[];
}

function read(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function scalars(value: unknown, fields: readonly string[]): Context {
  const result: Context = {};
  for (const field of fields) {
    const entry = read(value, field);
    if (
      typeof entry === "string" || typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) result[field] = entry;
  }
  return result;
}

/** Include declared secret bindings even when their environment key is opaque. */
export function collectRunFailureSecretValues(env: unknown, secretKeys: Iterable<string> = []): string[] {
  if (!env || typeof env !== "object") return [];
  const strings = Object.fromEntries(Object.entries(env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ));
  const masked = redactEnvForLogs(strings);
  const declared = new Set(secretKeys);
  return [...new Set(Object.entries(strings)
    .filter(([key, value]) => value.length > 0 && (declared.has(key) || masked[key] !== value))
    .map(([, value]) => value))].sort((a, b) => b.length - a.length);
}

/** Snapshot only diagnostics. Never walk a request, response, config or prompt. */
export function collectRunFailureDiagnostics(run: Run, options: RunFailureReportOptions): RunFailureDiagnostics {
  const execution = scalars(run, [
    "runtimeMode", "executionStage", "nativePhase", "driverKind", "driverVersion",
  ]);
  if (options.phase) execution.failurePhase = options.phase;
  if (run.startedAt && run.finishedAt) {
    const durationMs = run.finishedAt.getTime() - run.startedAt.getTime();
    if (Number.isFinite(durationMs) && durationMs >= 0) execution.durationMs = durationMs;
  }
  const result = run.resultJson;
  Object.assign(execution, scalars(result, [
    "mode", "stopReason", "timeoutFired", "timeoutSource", "timeoutConfigured",
    "effectiveTimeoutSec", "errorFamily",
  ]));
  const adapter = scalars(options.adapterErrorMeta, [
    "category", "phase", "errorName", "acpCode", "causeMessage", "retryable",
    "stackPreview", "status", "statusCode", "requestId",
  ]);
  const provider = scalars(read(result, "terminalSessionFailure"), ["category", "title", "details"]);
  const truncatedFields: string[] = [];
  const providerTruncation = read(read(result, "terminalSessionFailure"), "truncatedFields");
  if (Array.isArray(providerTruncation)) {
    for (const field of ["title", "details"]) {
      if (providerTruncation.includes(field)) truncatedFields.push(`provider.${field}`);
    }
  }
  const exceptions: RunFailureException[] = [];
  const seen = new Set<unknown>();
  let error = options.error;
  while (error !== undefined && error !== null && exceptions.length < 4) {
    if (seen.has(error)) {
      truncatedFields.push("exceptions.cycle");
      break;
    }
    seen.add(error);
    if (typeof error === "string") {
      exceptions.push({ message: error });
      error = undefined;
      break;
    }
    if (typeof error !== "object") break;
    const entry: RunFailureException = {};
    for (const field of ["name", "message", "stack", "code"] as const) {
      const value = read(error, field);
      if (typeof value === "string") entry[field] = value;
      else if (field === "code" && typeof value === "number" && Number.isFinite(value)) entry.code = String(value);
    }
    const status = read(error, "status") ?? read(error, "statusCode");
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) entry.status = status;
    const requestId = read(error, "requestId") ?? read(error, "request_id");
    if (typeof requestId === "string") entry.requestId = requestId;
    if (Object.keys(entry).length > 0) exceptions.push(entry);
    else break;
    error = read(error, "cause");
  }
  if (error !== undefined && error !== null && exceptions.length === 4) truncatedFields.push("exceptions.depth");
  return { execution, adapter, provider, exceptions, truncatedFields };
}

/** Redact complete values before cutting, including credentials across a cut. */
export function sanitizeRunFailureText(input: string, limit: number): string {
  const normalized = input
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/[\ud800-\udfff]/gu, "\ufffd");
  const clean = redactSensitiveText(redactDiagnosticText(redactCurrentUserText(normalized)));
  if (clean.length <= limit) return clean;
  const suffix = "\n[truncated]";
  let end = limit - suffix.length;
  if ((clean.codePointAt(end - 1) ?? 0) > 0xffff) end--;
  return clean.slice(0, end) + suffix;
}

/** Called after the run's registered secret values have also been removed. */
export function sanitizeRunFailureDiagnostics(raw: RunFailureDiagnostics): RunFailureDiagnostics {
  const truncatedFields = [...raw.truncatedFields];
  const text = (value: string, path: string, limit: number) => {
    const sanitized = sanitizeRunFailureText(value, limit);
    if (sanitized.endsWith("\n[truncated]")) truncatedFields.push(path);
    return sanitized;
  };
  const context = (value: Context, prefix: string, limits: Record<string, number> = {}): Context =>
    Object.fromEntries(Object.entries(value).map(([key, value]) => [key,
      typeof value === "string" ? text(value, `${prefix}.${key}`, limits[key] ?? 200) : value,
    ]));
  return {
    execution: context(raw.execution, "execution"),
    adapter: context(raw.adapter, "adapter", { causeMessage: 2048, stackPreview: 8192 }),
    provider: context(raw.provider, "provider", { title: 4096, details: 12288 }),
    exceptions: raw.exceptions.map((entry, i) => context(entry as Context, `exceptions.${i}`, { message: 2048, stack: 8192 })),
    truncatedFields: [...new Set(truncatedFields)],
  };
}
