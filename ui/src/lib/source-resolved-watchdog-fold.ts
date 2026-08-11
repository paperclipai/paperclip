import type { HeartbeatRun } from "@paperclipai/shared";

export type SourceResolvedFoldCleanupOutcome =
  | "terminated"
  | "termination_sent_still_running"
  | "failed"
  | "not_running"
  | "no_process_metadata"
  | "skipped_non_local_adapter"
  | string;

export interface SourceResolvedFoldCleanup {
  attempted: boolean;
  outcome: SourceResolvedFoldCleanupOutcome;
  adapterType: string | null;
  pid: number | null;
  processGroupId: number | null;
  error: string | null;
}

export interface SourceResolvedWatchdogFold {
  sourceIssueId: string;
  sourceIssueIdentifier: string | null;
  sourceIssueStatus: string;
  sameRunEvidenceKind: string;
  sameRunEvidenceId: string;
  sameRunEvidenceAt: string;
  silenceStartedAt: string | null;
  silenceAgeMs: number | null;
  evaluationIssueId: string | null;
  evaluationIssueIdentifier: string | null;
  cleanup: SourceResolvedFoldCleanup;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function parseCleanup(value: unknown): SourceResolvedFoldCleanup {
  const record = asRecord(value);
  if (!record) {
    return {
      attempted: false,
      outcome: "no_process_metadata",
      adapterType: null,
      pid: null,
      processGroupId: null,
      error: null,
    };
  }
  return {
    attempted: asBoolean(record.attempted),
    outcome: asString(record.outcome) ?? "no_process_metadata",
    adapterType: asString(record.adapterType),
    pid: asFiniteNumber(record.pid),
    processGroupId: asFiniteNumber(record.processGroupId),
    error: asString(record.error),
  };
}

export function parseSourceResolvedWatchdogFold(value: unknown): SourceResolvedWatchdogFold | null {
  const record = asRecord(value);
  if (!record) return null;
  const sourceIssueId = asString(record.sourceIssueId);
  const sourceIssueStatus = asString(record.sourceIssueStatus);
  if (!sourceIssueId || !sourceIssueStatus) return null;
  const evidenceKind = asString(record.sameRunEvidenceKind);
  const evidenceId = asString(record.sameRunEvidenceId);
  const evidenceAt = asString(record.sameRunEvidenceAt);
  if (!evidenceKind || !evidenceId || !evidenceAt) return null;
  return {
    sourceIssueId,
    sourceIssueIdentifier: asString(record.sourceIssueIdentifier),
    sourceIssueStatus,
    sameRunEvidenceKind: evidenceKind,
    sameRunEvidenceId: evidenceId,
    sameRunEvidenceAt: evidenceAt,
    silenceStartedAt: asString(record.silenceStartedAt),
    silenceAgeMs: asFiniteNumber(record.silenceAgeMs),
    evaluationIssueId: asString(record.evaluationIssueId),
    evaluationIssueIdentifier: asString(record.evaluationIssueIdentifier),
    cleanup: parseCleanup(record.cleanup),
  };
}

export function readSourceResolvedWatchdogFold(
  resultJson: HeartbeatRun["resultJson"] | Record<string, unknown> | null | undefined,
): SourceResolvedWatchdogFold | null {
  const record = asRecord(resultJson);
  if (!record) return null;
  return parseSourceResolvedWatchdogFold(record.sourceResolvedWatchdogFold);
}

const CLEANUP_OUTCOME_LABELS: Record<string, string> = {
  terminated: "terminated",
  termination_sent_still_running: "termination sent (still running)",
  failed: "failed",
  not_running: "not running",
  no_process_metadata: "no process metadata",
  skipped_non_local_adapter: "skipped (non-local adapter)",
};

export function formatCleanupOutcome(outcome: string): string {
  return CLEANUP_OUTCOME_LABELS[outcome] ?? outcome.replace(/_/g, " ");
}

export function formatSilenceAgeMs(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "under 1 minute";
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours}h ${minutes}m`;
}

export function shortenEvidenceId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(0, 8);
}
