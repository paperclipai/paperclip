import { classifySilenceLevel, silenceAgeMs, silenceStartedAt } from "../domain/silence.js";
import type { WatchdogRunReader } from "./ports.js";
import type { RunOutputSilenceSummary, RunSnapshot } from "./types.js";

export type BuildRunOutputSilenceDeps = {
  reader: WatchdogRunReader;
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
};

export function createBuildRunOutputSilence(deps: BuildRunOutputSilenceDeps) {
  return async function buildRunOutputSilence(run: RunSnapshot, now: Date): Promise<RunOutputSilenceSummary> {
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
