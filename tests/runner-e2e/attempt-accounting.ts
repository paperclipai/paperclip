import { createHash } from "node:crypto";
import { summarizeExecutionBilling } from "./billing.js";
import type { RunnerE2EAttemptReceipt, RunnerE2ECampaignAccounting, RunnerE2EResult } from "./types.js";

export function isSelectedCarryForward(input: {
  requestedCampaignId: string; result: RunnerE2EResult; relativeResultPath: string; selection: unknown;
}): boolean {
  const s = input.selection as Record<string, unknown> | null;
  if (!s || s.version !== 1 || typeof s.workflowRunId !== "string" || !/^[0-9]+$/.test(s.workflowRunId)
      || !Number.isSafeInteger(s.workflowRunAttempt) || Number(s.workflowRunAttempt) < 1
      || input.requestedCampaignId !== `gha-${s.workflowRunId}-${s.workflowRunAttempt}` || !Array.isArray(s.selections)) return false;
  const source = input.result.source;
  if (!source || !source.sha || !source.ref || !source.workflowRunUrl
      || source.sha !== s.sourceSha || source.ref !== s.sourceRef || source.workflowRunUrl !== s.workflowRunUrl) return false;
  if (input.relativeResultPath.split("/").some(part => !part || part === "." || part === "..")) return false;
  return s.selections.some(value => {
    if (!value || typeof value !== "object") return false;
    const selected = value as Record<string, unknown>;
    const attempt = selected.workflowAttempt;
    const campaign = `gha-${s.workflowRunId}-${attempt}`;
    const artifact = `runner-e2e-${s.workflowRunId}-${attempt}-${input.result.executionId}`;
    return selected.executionId === input.result.executionId && Number.isSafeInteger(attempt)
      && Number(attempt) >= 1 && Number(attempt) < Number(s.workflowRunAttempt)
      && selected.artifactName === artifact && input.result.accountingIdentity?.campaignId === campaign
      && input.relativeResultPath.startsWith(`${artifact}/${campaign}-${input.result.executionId}/`);
  });
}

function scope(result: RunnerE2EResult): string | undefined {
  return result.accountingIdentity?.campaignId ?? result.source?.workflowRunUrl ?? undefined;
}

export function retainedCampaignAttempts(
  selected: readonly RunnerE2EResult[],
  candidates: readonly RunnerE2EResult[],
): { attempts: RunnerE2EResult[]; excludedArtifacts: number } {
  const attempts = candidates.filter(candidate => selected.some(result =>
    result.executionId === candidate.executionId &&
    (scope(result) ? scope(result) === scope(candidate) : result === candidate),
  ));
  return { attempts, excludedArtifacts: candidates.length - attempts.length };
}

function receipt(result: RunnerE2EResult): RunnerE2EAttemptReceipt {
  const identity = [scope(result) ?? null, result.executionId,
    result.accountingIdentity?.attemptId ?? [result.attempt, result.startedAt]];
  return {
    id: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    executionId: result.executionId,
    attempt: result.attempt,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    ...(result.workerTiming ? { workerTiming: result.workerTiming } : {}),
    status: result.status,
    cleanup: result.cleanup,
    billing: summarizeExecutionBilling(result),
    ...(result.feedback ? { feedback: result.feedback } : {}),
    ...(result.tracing ? { tracing: result.tracing } : {}),
  };
}

export function buildCampaignAccounting(input: {
  results: readonly RunnerE2EResult[];
  attempts?: readonly RunnerE2EResult[];
  excludedArtifacts?: number;
}): RunnerE2ECampaignAccounting {
  const receipts = new Map<string, RunnerE2EAttemptReceipt>();
  for (const result of input.attempts ?? input.results) {
    if (result.attempt === 0) continue; // Missing result placeholders are not free attempts.
    const next = receipt(result);
    const previous = receipts.get(next.id);
    if (previous && previous.finishedAt === next.finishedAt &&
        JSON.stringify(previous.billing) !== JSON.stringify(next.billing)) {
      throw new Error(`Conflicting accounting receipts for ${result.executionId} attempt ${result.attempt}`);
    }
    if (previous && previous.finishedAt === next.finishedAt && previous.workerTiming && next.workerTiming &&
        JSON.stringify(previous.workerTiming) !== JSON.stringify(next.workerTiming)) {
      throw new Error(`Conflicting timing receipts for ${result.executionId} attempt ${result.attempt}`);
    }
    if (previous && previous.finishedAt === next.finishedAt && previous.workerTiming && !next.workerTiming) next.workerTiming = previous.workerTiming;
    if (!previous || Date.parse(next.finishedAt) >= Date.parse(previous.finishedAt)) receipts.set(next.id, next);
  }
  const attempts = [...receipts.values()].sort((a, b) =>
    a.executionId.localeCompare(b.executionId) || a.attempt - b.attempt || a.id.localeCompare(b.id));
  let missingAttempts = 0;
  for (const result of input.results) {
    const retained = attempts.filter(attempt => attempt.executionId === result.executionId);
    const latest = Math.max(result.attempt, ...retained.map(attempt => attempt.attempt), 1);
    missingAttempts += Math.max(0, latest - new Set(retained.map(attempt => attempt.attempt)).size);
  }
  return {
    version: 1,
    scope: input.attempts ? "retained_attempts" : "selected_results",
    attempts,
    missingAttempts,
    excludedArtifacts: input.excludedArtifacts ?? 0,
  };
}
