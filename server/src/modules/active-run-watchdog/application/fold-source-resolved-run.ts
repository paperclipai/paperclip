import type { RunProcessController, WatchdogWriter } from "./ports.js";
import type {
  EvaluationIssueSnapshot,
  FoldOutcome,
  RunSnapshot,
  SourceIssueSnapshot,
  TerminalEvidence,
} from "./types.js";

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
