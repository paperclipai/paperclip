import {
  classifySilenceLevel,
  evaluateSuppression,
  isTerminalIssueStatus,
  shouldFoldTerminalSource,
  silenceAgeMs,
  silenceStartedAt,
} from "../domain/policy.js";
import { WatchdogDecisionApplicationError } from "./types.js";
import type { RunProcessController, WatchdogRunReader, WatchdogWriter } from "./ports.js";
import type {
  RunOutputSilenceSummary,
  RunSnapshot,
  ScanSilentActiveRunsResult,
  SourceIssueSnapshot,
  EvaluationIssueSnapshot,
  FoldOutcome,
  TerminalEvidence,
  WatchdogDecisionActor,
  WatchdogDecisionRecord,
} from "./types.js";

export type BuildRunOutputSilenceDeps = {
  reader: WatchdogRunReader;
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
};

export type BuildRunOutputSilenceRunInput = Pick<
  RunSnapshot,
  "id" | "companyId" | "status" | "lastOutputAt" | "lastOutputSeq" | "lastOutputStream" | "processStartedAt" | "startedAt" | "createdAt"
>;

export function createBuildRunOutputSilence(deps: BuildRunOutputSilenceDeps) {
  return async function buildRunOutputSilence(
    run: BuildRunOutputSilenceRunInput,
    now: Date,
  ): Promise<RunOutputSilenceSummary> {
    const [decisionState, evaluation] = await Promise.all([
      deps.reader.findLatestDecision(run.companyId, run.id, now),
      deps.reader.findOpenStaleRunEvaluation(run.companyId, run.id),
    ]);
    const { dismissedFalsePositive, quietUntilDecision } = decisionState;
    const isRunningRun = run.status === "running";
    const silenceAgeMsValue = isRunningRun ? silenceAgeMs(run, now) : null;
    const level = classifySilenceLevel({
      isRunningRun,
      silenceAgeMs: silenceAgeMsValue,
      dismissedFalsePositive,
      snoozed: Boolean(quietUntilDecision),
      suspicionThresholdMs: deps.suspicionThresholdMs,
      criticalThresholdMs: deps.criticalThresholdMs,
    });

    return {
      lastOutputAt: run.lastOutputAt ?? null,
      lastOutputSeq: run.lastOutputSeq ?? 0,
      lastOutputStream: run.lastOutputStream === "stdout" || run.lastOutputStream === "stderr"
        ? run.lastOutputStream
        : null,
      silenceStartedAt: silenceStartedAt(run),
      silenceAgeMs: silenceAgeMsValue,
      level,
      suspicionThresholdMs: deps.suspicionThresholdMs,
      criticalThresholdMs: deps.criticalThresholdMs,
      snoozedUntil: dismissedFalsePositive ? null : quietUntilDecision?.snoozedUntil ?? null,
      evaluationIssueId: evaluation?.id ?? null,
      evaluationIssueIdentifier: evaluation?.identifier ?? null,
      evaluationIssueAssigneeAgentId: evaluation?.assigneeAgentId ?? null,
    };
  };
}

export type FoldSourceResolvedRunDeps = {
  writer: WatchdogWriter;
  processController: RunProcessController;
};

export type FoldSourceResolvedRunUseCaseInput = {
  run: RunSnapshot;
  runningAgentAdapterType: string;
  sourceIssue: SourceIssueSnapshot;
  evidence: TerminalEvidence;
  existingEvaluation: EvaluationIssueSnapshot | null;
  silenceStartedAt: Date | null;
  silenceAgeMs: number | null;
  now: Date;
};

export function createFoldSourceResolvedRun(deps: FoldSourceResolvedRunDeps) {
  return async function foldSourceResolvedRun(input: FoldSourceResolvedRunUseCaseInput): Promise<FoldOutcome> {
    const cleanup = await deps.processController.cleanupRunProcess({
      runId: input.run.id,
      adapterType: input.runningAgentAdapterType,
      fallbackPid: input.run.processPid,
      fallbackProcessGroupId: input.run.processGroupId,
    });

    return deps.writer.foldSourceResolvedRun(input.run.companyId, {
      run: input.run,
      sourceIssue: input.sourceIssue,
      evidence: input.evidence,
      existingEvaluation: input.existingEvaluation,
      silenceStartedAt: input.silenceStartedAt,
      silenceAgeMs: input.silenceAgeMs,
      cleanup,
      now: input.now,
    });
  };
}

const STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND = "stale_active_run_evaluation";

export type RecordWatchdogDecisionDeps = {
  reader: WatchdogRunReader;
  writer: WatchdogWriter;
  continueRearmMs: number;
};

export type RecordWatchdogDecisionUseCaseInput = {
  companyId: string;
  runId: string;
  actor: WatchdogDecisionActor;
  decision: "snooze" | "continue" | "dismissed_false_positive";
  evaluationIssueId?: string | null;
  reason?: string | null;
  snoozedUntil?: Date | null;
  createdByRunId?: string | null;
  now?: Date;
};

export function createRecordWatchdogDecision(deps: RecordWatchdogDecisionDeps) {
  return async function recordWatchdogDecision(
    input: RecordWatchdogDecisionUseCaseInput,
  ): Promise<WatchdogDecisionRecord> {
    const run = await deps.reader.findRunForCompany(input.companyId, input.runId);
    if (!run) throw new WatchdogDecisionApplicationError("run_not_found", "Heartbeat run not found");

    const evaluationIssue = input.evaluationIssueId
      ? await deps.reader.findEvaluationIssueById(input.companyId, input.evaluationIssueId)
      : null;
    if (input.evaluationIssueId && !evaluationIssue) {
      throw new WatchdogDecisionApplicationError("evaluation_issue_not_found", "Evaluation issue not found");
    }
    if (input.actor.type === "agent" && !evaluationIssue) {
      throw new WatchdogDecisionApplicationError(
        "evaluation_issue_required",
        "Agent watchdog decisions require the target evaluation issue",
      );
    }

    const boardActor = input.actor.type === "board";
    const assignedRecoveryOwner =
      input.actor.type === "agent" &&
      Boolean(input.actor.agentId) &&
      evaluationIssue !== null &&
      evaluationIssue.originKind === STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND &&
      evaluationIssue.originId === run.id &&
      evaluationIssue.hiddenAt === null &&
      !["done", "cancelled"].includes(evaluationIssue.status) &&
      evaluationIssue.assigneeAgentId === input.actor.agentId;
    if (!boardActor && !assignedRecoveryOwner) {
      throw new WatchdogDecisionApplicationError(
        "not_authorized",
        "Only the board or the assigned recovery owner can record watchdog decisions",
      );
    }

    if (evaluationIssue && (
      evaluationIssue.originKind !== STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND ||
      evaluationIssue.originId !== run.id
    )) {
      throw new WatchdogDecisionApplicationError(
        "evaluation_issue_mismatch",
        "Watchdog decision evaluation issue is not bound to the target run",
      );
    }

    const createdByRunId = input.actor.type === "agent"
      ? input.actor.runId ?? input.createdByRunId ?? null
      : input.actor.type === "board"
        ? input.actor.runId ?? input.createdByRunId ?? null
        : null;
    if (createdByRunId) {
      const creatorRun = await deps.reader.findRunForCompany(input.companyId, createdByRunId);
      const sameAgent = input.actor.type !== "agent" || creatorRun?.agentId === input.actor.agentId;
      if (!creatorRun || !sameAgent) {
        throw new WatchdogDecisionApplicationError(
          "creator_run_invalid",
          "createdByRunId is not valid for this watchdog decision actor",
        );
      }
    }

    const decisionNow = input.now ?? new Date();
    const effectiveSnoozedUntil = input.decision === "snooze"
      ? input.snoozedUntil ?? null
      : input.decision === "continue"
        ? input.snoozedUntil && input.snoozedUntil > decisionNow
          ? input.snoozedUntil
          : new Date(decisionNow.getTime() + deps.continueRearmMs)
        : null;

    return deps.writer.recordDecision(input.companyId, {
      runId: run.id,
      actor: input.actor,
      evaluationIssueId: input.evaluationIssueId ?? null,
      decision: input.decision,
      snoozedUntil: effectiveSnoozedUntil,
      reason: input.reason ?? null,
      createdByAgentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
      createdByUserId: input.actor.type === "board" ? input.actor.userId ?? null : null,
      createdByRunId,
    });
  };
}

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

type InspectOutcome =
  | { kind: "skipped" }
  | { kind: "existing"; evaluationIssueId: string }
  | { kind: "folded"; evaluationIssueId: string | null };

export function createScanSilentActiveRuns(deps: ScanSilentActiveRunsDeps) {
  async function resolveSourceIssue(run: RunSnapshot): Promise<SourceIssueSnapshot | null> {
    if (!run.sourceIssueId) return null;
    return deps.reader.findSourceIssue(run.companyId, run.sourceIssueId);
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
