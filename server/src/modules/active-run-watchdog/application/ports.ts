import type {
  EvaluationIssueSnapshot,
  FoldOutcome,
  FoldSourceResolvedRunInput,
  RecordDecisionInput,
  RunProcessCleanupOutcome,
  RunProcessMetadata,
  RunSnapshot,
  SourceIssueSnapshot,
  TerminalEvidence,
  WatchdogDecisionRecord,
} from "./types.js";

export type FindCandidateSilentRunsInput = {
  companyId?: string;
  suspicionBefore: Date;
  issueCreatedAtGte?: Date | null;
};

export type FindLatestDecisionResult = {
  quietUntilDecision: { decision: "snooze" | "continue"; snoozedUntil: Date } | null;
  dismissedFalsePositive: boolean;
};

export type FindLatestSameRunTerminalEvidenceInput = {
  runId: string;
  sourceIssueId: string;
  sourceIssueStatus: string;
  evidenceAfter: Date | null;
};

export type RunningAgentSnapshot = {
  id: string;
  companyId: string;
  adapterType: string;
};

/**
 * Reads active-run watchdog state. Every method takes the company scope of
 * the caller, except `findCandidateSilentRuns`: the periodic recovery scan
 * runs system-wide, so its scope is optional. Every candidate that method
 * returns carries its own authoritative `companyId`, and every later read
 * or write must use that value, never a value from the caller.
 *
 * `findRunningAgent` and `findEvaluationIssueById` are not two of the ports
 * the design review named; each is a narrow, company-scoped addition that
 * carries a read the recovery service already performed before the
 * extraction. `findRunningAgent` guards against a run whose `agentId`
 * foreign key does not match the run's own company. `findEvaluationIssueById`
 * loads a caller-named evaluation issue by its own id, in any status, which
 * `findOpenStaleRunEvaluation`'s open-only, run-bound query cannot do.
 */
export interface WatchdogRunReader {
  findCandidateSilentRuns(input: FindCandidateSilentRunsInput): Promise<RunSnapshot[]>;
  findRunForCompany(companyId: string, runId: string): Promise<RunSnapshot | null>;
  findLatestDecision(companyId: string, runId: string, now: Date): Promise<FindLatestDecisionResult>;
  findOpenStaleRunEvaluation(companyId: string, runId: string): Promise<EvaluationIssueSnapshot | null>;
  findLatestSameRunTerminalEvidence(
    companyId: string,
    input: FindLatestSameRunTerminalEvidenceInput,
  ): Promise<TerminalEvidence | null>;
  findSourceIssue(companyId: string, issueId: string): Promise<SourceIssueSnapshot | null>;
  findRunningAgent(companyId: string, agentId: string): Promise<RunningAgentSnapshot | null>;
  findEvaluationIssueById(companyId: string, issueId: string): Promise<EvaluationIssueSnapshot | null>;
}

/**
 * Writes active-run watchdog state. `foldSourceResolvedRun` is one
 * semantic operation: it owns the `running` compare-and-set, the cleared
 * source-issue execution fields, evaluation closure and comment, recovery
 * action resolution, decision, run event, activity record, and agent-status
 * update inside one transaction.
 */
export interface WatchdogWriter {
  recordDecision(companyId: string, input: RecordDecisionInput): Promise<WatchdogDecisionRecord>;
  foldSourceResolvedRun(companyId: string, input: FoldSourceResolvedRunInput): Promise<FoldOutcome>;
}

/** Controls the local operating-system process backing a run. */
export interface RunProcessController {
  cleanupRunProcess(input: RunProcessMetadata): Promise<RunProcessCleanupOutcome>;
}
