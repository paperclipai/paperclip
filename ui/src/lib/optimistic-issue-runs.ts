import type { RunForIssue } from "../api/activity";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";

export interface InterruptRunSource {
  id: string;
  agentId: string;
  adapterType: string;
  startedAt: Date | string | null;
  createdAt: Date | string;
  invocationSource: string;
  usageJson?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
}

function toTimestamp(value: Date | string | null | undefined) {
  if (!value) return 0;
  return new Date(value).getTime();
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function upsertInterruptedRun(
  runs: RunForIssue[] | undefined,
  run: InterruptRunSource,
  finishedAt: string,
): RunForIssue[] {
  const nextRun: RunForIssue = {
    runId: run.id,
    status: "cancelled",
    agentId: run.agentId,
    adapterType: run.adapterType,
    startedAt: toIsoString(run.startedAt),
    finishedAt,
    createdAt: toIsoString(run.createdAt) ?? finishedAt,
    invocationSource: run.invocationSource,
    usageJson: run.usageJson ?? null,
    resultJson: run.resultJson ?? null,
  };

  const current = runs ?? [];
  const existingIndex = current.findIndex((entry) => entry.runId === run.id);
  if (existingIndex === -1) {
    return [...current, nextRun].sort((a, b) => {
      const diff = toTimestamp(a.startedAt ?? a.createdAt) - toTimestamp(b.startedAt ?? b.createdAt);
      if (diff !== 0) return diff;
      return a.runId.localeCompare(b.runId);
    });
  }

  const updated = [...current];
  updated[existingIndex] = {
    ...updated[existingIndex],
    ...nextRun,
    usageJson: updated[existingIndex]?.usageJson ?? nextRun.usageJson,
    resultJson: updated[existingIndex]?.resultJson ?? nextRun.resultJson,
  };
  return updated;
}

export function removeLiveRunById(
  runs: LiveRunForIssue[] | undefined,
  runId: string,
) {
  if (!runs) return runs;
  const nextRuns = runs.filter((run) => run.id !== runId);
  return nextRuns.length === runs.length ? runs : nextRuns;
}
