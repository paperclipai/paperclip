import { createHash } from "node:crypto";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactEventPayload, redactSensitiveText } from "../redaction.js";

const MAX_DIAGNOSTIC_EXCERPT = 6_000;
const MAX_STRUCTURED_EVIDENCE = 8_000;
const GENERIC_TRANSPORT_FAILURE_RE = /^(?:adapter_failed|process exited(?: with code)?\s*\d*|broker transport exited|transport exited)$/i;
const FAILURE_SIGNAL_RE =
  /\b(?:eagain|enoent|eacces|eperm|enospc|error|exception|failed|failure|resource temporarily unavailable|quota|rate limit|timed? out|connection reset|refused)\b/i;

export type RecoveryEvidenceRun = {
  id: string;
  status: string;
  errorCode?: string | null;
  error?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  stderrExcerpt?: string | null;
  stdoutExcerpt?: string | null;
  resultJson?: Record<string, unknown> | null;
  driverKind?: string | null;
  driverVersion?: string | null;
  logRef?: string | null;
  logSha256?: string | null;
  createdAt?: Date | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
};

function cleanDiagnosticText(value: string | null | undefined) {
  if (!value) return null;
  const withoutAnsi = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const redacted = redactCurrentUserText(redactSensitiveText(withoutAnsi))
    .replaceAll("\u0000", "")
    .trim();
  if (!redacted) return null;
  return redacted.slice(-MAX_DIAGNOSTIC_EXCERPT);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`);
  return `{${entries.join(",")}}`;
}

function normalizeFailureSignature(value: string) {
  return value
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/gi, "<timestamp>")
    .replace(/\bpid[=: ]+\d+\b/gi, "pid=<pid>")
    .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/[^\s:'\"]+/gi, "<temp-path>")
    .replace(/\s+/g, " ")
    .trim();
}
function selectConcreteFailureSignal(input: {
  stderr: string | null;
  stdout: string | null;
  error: string | null;
  redactedResult: Record<string, unknown> | null;
}) {
  const selectLines = (value: string | null) => {
    if (!value) return [];
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const concrete = lines.filter((line) => FAILURE_SIGNAL_RE.test(line));
    return (concrete.length > 0 ? concrete : lines.slice(-1)).slice(-8);
  };
  const stableResultFields = input.redactedResult
    ? Object.fromEntries(
      ["code", "errorCode", "kind", "reason", "cause", "message", "stopReason"]
        .filter((key) => input.redactedResult?.[key] !== undefined)
        .map((key) => [key, input.redactedResult?.[key]]),
    )
    : null;
  const errorSignal = input.error && !GENERIC_TRANSPORT_FAILURE_RE.test(input.error)
    ? selectLines(input.error)
    : [];
  const lines = [
    ...selectLines(input.stderr),
    ...errorSignal,
    ...(errorSignal.length === 0 && !input.stderr ? selectLines(input.stdout) : []),
  ];
  return {
    signal: lines.length > 0 ? lines.join("\n") : null,
    stableResultFields:
      stableResultFields && Object.keys(stableResultFields).length > 0 ? stableResultFields : null,
  };
}


export function buildRecoveryRunEvidence(
  run: RecoveryEvidenceRun,
  adapterType: string | null,
  sourceScope: string,
): { fingerprint: string; evidence: Record<string, unknown>; summary: string } {
  const stderr = cleanDiagnosticText(run.stderrExcerpt);
  const stdout = cleanDiagnosticText(run.stdoutExcerpt);
  const error = cleanDiagnosticText(run.error);
  const redactedResult = redactEventPayload(run.resultJson ?? null);
  const nonGenericError = error && !GENERIC_TRANSPORT_FAILURE_RE.test(error) ? error : null;
  const selected = selectConcreteFailureSignal({ stderr, stdout, error, redactedResult });
  const concreteSignature = [
    selected.signal,
    selected.stableResultFields ? stableJson(selected.stableResultFields) : null,
  ].filter((value): value is string => Boolean(value)).join("\n");
  const signature = normalizeFailureSignature(
    concreteSignature || error || run.errorCode || `terminal:${run.status}`,
  );
  const genericOnly = !selected.signal && !selected.stableResultFields &&
    (!error || GENERIC_TRANSPORT_FAILURE_RE.test(error));
  const fingerprintInput = stableJson({
    adapterType,
    driverKind: run.driverKind ?? null,
    driverVersion: run.driverVersion ?? null,
    errorCode: run.errorCode ?? null,
    exitCode: run.exitCode ?? null,
    signal: run.signal ?? null,
    signature,
    ...(genericOnly ? { sourceScope } : {}),
  });
  const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex");
  const summary = (stderr ?? nonGenericError ?? stdout ?? error ?? run.errorCode ?? `Run ${run.status}`)
    .slice(0, MAX_DIAGNOSTIC_EXCERPT);

  return {
    fingerprint,
    summary,
    evidence: {
      runId: run.id,
      terminalStatus: run.status,
      errorCode: run.errorCode ?? null,
      error: error ?? null,
      exitCode: run.exitCode ?? null,
      signal: run.signal ?? null,
      stderrExcerpt: stderr,
      stdoutExcerpt: stdout,
      structuredResult: redactedResult
        ? stableJson(redactedResult).slice(0, MAX_STRUCTURED_EVIDENCE)
        : null,
      driverKind: run.driverKind ?? null,
      driverVersion: run.driverVersion ?? null,
      adapterType,
      logRef: run.logRef ?? null,
      logSha256: run.logSha256 ?? null,
      createdAt: run.createdAt?.toISOString() ?? null,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      concreteFailureSignal: selected.signal,
      genericFailureScopedToSource: genericOnly,
      failureSignatureVersion: "recovery-engineer-v1",
    },
  };
}

export function buildBlockedIssueEvidence(input: {
  issueId: string;
  title: string;
  description: string | null;
  statusVersion: number;
  updatedAt: Date;
}) {
  const description = cleanDiagnosticText(input.description)?.slice(0, 4_000) ?? null;
  const signature = normalizeFailureSignature(
    `${input.title}\n${description ?? "unexplained blocked transition"}`,
  );
  const fingerprint = createHash("sha256")
    .update(stableJson({ kind: "unexplained_block", signature }))
    .digest("hex");
  return {
    fingerprint,
    summary: description ?? `Issue ${input.issueId} entered blocked without a durable gate`,
    evidence: {
      issueId: input.issueId,
      title: cleanDiagnosticText(input.title),
      description,
      statusVersion: input.statusVersion,
      updatedAt: input.updatedAt.toISOString(),
      failureSignatureVersion: "recovery-engineer-v1",
    } satisfies Record<string, unknown>,
  };
}
