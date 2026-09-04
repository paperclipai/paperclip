import { silenceAgeMs, silenceStartedAt } from "../domain/silence.js";
import { evaluateSuppression } from "../domain/suppression.js";
import { isTerminalIssueStatus, shouldFoldTerminalSource } from "../domain/terminal.js";
import type { createFoldSourceResolvedRun } from "./fold-source-resolved-run.js";
import type { WatchdogRunReader } from "./ports.js";
import type { RunSnapshot, ScanSilentActiveRunsResult, SourceIssueSnapshot } from "./types.js";

export type ScanSilentActiveRunsDeps = {
  reader: WatchdogRunReader;
  foldSourceResolvedRun: ReturnType<typeof createFoldSourceResolvedRun>;
  suspicionThresholdMs: number;
};

export type ScanSilentActiveRunsOptions = {
  now?: Date;
  companyId?: string;
  issueCreatedAtGte?: Date | null;
};

function readRunContextIssueId(contextSnapshot: unknown): string | null {
  const context = contextSnapshot && typeof contextSnapshot === "object"
    ? (contextSnapshot as Record<string, unknown>)
    : {};
  const issueId = context.issueId ?? context.taskId;
  return typeof issueId === "string" && issueId.length > 0 ? issueId : null;
}

type InspectOutcome =
  | { kind: "skipped" }
  | { kind: "existing"; evaluationIssueId: string }
  | { kind: "folded"; evaluationIssueId: string | null };

export function createScanSilentActiveRuns(deps: ScanSilentActiveRunsDeps) {
  async function resolveSourceIssue(run: RunSnapshot): Promise<SourceIssueSnapshot | null> {
    const issueId = readRunContextIssueId(run.contextSnapshot);
    if (!issueId) return null;
    return deps.reader.findSourceIssue(run.companyId, issueId);
  }

  async function inspectSilentActiveRun(input: {
    run: RunSnapshot;
    now: Date;
    dismissedFalsePositive: boolean;
  }): Promise<InspectOutcome> {
    const runningAgent = await deps.reader.findRunningAgent(input.run.companyId, input.run.agentId);
    if (!runningAgent || runningAgent.companyId !== input.run.companyId) return { kind: "skipped" };

    const sourceIssue = await resolveSourceIssue(input.run);
    const existing = await deps.reader.findOpenStaleRunEvaluation(input.run.companyId, input.run.id);

    if (evaluateSuppression({ recoveryOriginSource: sourceIssue?.isRecoveryOriginKind === true }).suppressed) {
      return { kind: "skipped" };
    }

    const silenceStartedAtValue = silenceStartedAt(input.run);
    if (sourceIssue) {
      const terminalEvidence = isTerminalIssueStatus(sourceIssue.status)
        ? await deps.reader.findLatestSameRunTerminalEvidence(input.run.companyId, {
            runId: input.run.id,
            sourceIssueId: sourceIssue.id,
            sourceIssueStatus: sourceIssue.status,
            evidenceAfter: silenceStartedAtValue,
          })
        : null;
      if (shouldFoldTerminalSource({
        sourceIssueStatus: sourceIssue.status,
        hasSameRunTerminalEvidence: terminalEvidence !== null,
      })) {
        const foldOutcome = await deps.foldSourceResolvedRun({
          run: input.run,
          runningAgentAdapterType: runningAgent.adapterType,
          sourceIssue,
          evidence: terminalEvidence!,
          existingEvaluation: existing,
          silenceStartedAt: silenceStartedAtValue,
          silenceAgeMs: silenceAgeMs(input.run, input.now),
          now: input.now,
        });
        return foldOutcome.kind === "folded"
          ? { kind: "folded", evaluationIssueId: foldOutcome.evaluationIssueId }
          : { kind: "skipped" };
      }
    }

    // Blocked source work can be intentionally quiet. The issue state already carries
    // the durable waiting signal, so the scan has nothing to do.
    if (evaluateSuppression({ blockedSource: sourceIssue?.status === "blocked" }).suppressed) {
      return { kind: "skipped" };
    }

    if (evaluateSuppression({ dismissedFalsePositive: input.dismissedFalsePositive }).suppressed) {
      return { kind: "skipped" };
    }

    return existing ? { kind: "existing", evaluationIssueId: existing.id } : { kind: "skipped" };
  }

  return async function scanSilentActiveRuns(opts?: ScanSilentActiveRunsOptions): Promise<ScanSilentActiveRunsResult> {
    const now = opts?.now ?? new Date();
    const suspicionBefore = new Date(now.getTime() - deps.suspicionThresholdMs);
    const candidates = await deps.reader.findCandidateSilentRuns({
      companyId: opts?.companyId,
      suspicionBefore,
      issueCreatedAtGte: opts?.issueCreatedAtGte,
    });

    const result: ScanSilentActiveRunsResult = {
      scanned: candidates.length,
      created: 0,
      existing: 0,
      escalated: 0,
      folded: 0,
      snoozed: 0,
      skipped: 0,
      evaluationIssueIds: [],
    };

    for (const run of candidates) {
      const decisionState = await deps.reader.findLatestDecision(run.companyId, run.id, now);
      if (evaluateSuppression({ snoozedOrContinued: Boolean(decisionState.quietUntilDecision) }).suppressed) {
        result.snoozed += 1;
        continue;
      }
      const outcome = await inspectSilentActiveRun({
        run,
        now,
        dismissedFalsePositive: decisionState.dismissedFalsePositive,
      });
      if (outcome.kind === "existing") result.existing += 1;
      else if (outcome.kind === "folded") result.folded += 1;
      else result.skipped += 1;
      if ("evaluationIssueId" in outcome && outcome.evaluationIssueId) {
        result.evaluationIssueIds.push(outcome.evaluationIssueId);
      }
    }

    return result;
  };
}
