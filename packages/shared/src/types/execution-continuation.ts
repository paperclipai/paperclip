/** Server-authored context. Each message retains its author and trust boundary. */
export interface ExecutionContinuationEnvelope {
  version: 1;
  companyId: string;
  issueId: string;
  trigger: {
    reason: string;
    interactionId: string | null;
    sourceRunId: string | null;
    retriedReason?: string;
  };
  originCommentIds: string[];
  objective: string;
  objectiveSource?: {
    kind: "comment" | "description" | "title";
    id: string;
    revision: string | null;
  };
  messages: Array<{
    id: string;
    authorType: string;
    authorId: string | null;
    /** Run-authored Local CLI comments retain user attribution but are not human direction. */
    createdByRunId?: string | null;
    body: string;
    createdAt: string;
    updatedAt: string;
    deleted: boolean;
    sourceTrust: unknown;
    /** Set when the prompt shows only the start and end of a long body. */
    bodyTruncated?: boolean;
  }>;
  /** Only direct human resolutions, projected from server-owned resolver columns. */
  humanResponses?: Array<{
    id: string;
    kind: string;
    status: string;
    resolvedByUserId: string;
    resolvedAt: string;
    result: unknown;
  }>;
  interactionOutcomes: Array<{
    id: string;
    kind: string;
    status: string;
    result: unknown;
  }>;
  /** Only valid when resuming the provider session associated with this run. */
  resumeDelta?: {
    baseRunId: string;
    messages: ExecutionContinuationEnvelope["messages"];
  };
  recoveryOutcomes?: Array<{ recoveryActionId: string; decision: unknown }>;
  completedWork: string | null;
  /** Start a new turn from history; never replay prior tool calls automatically. */
  interruptedRunId?: string;
  /** Completed mutations are context, never instructions to replay them. */
  completedActions?: Array<{
    runId: string;
    receiptId: string;
    operationId: string;
    result: unknown;
  }>;
  /** Verified snapshots attached separately to the new workspace. Paths are
   * relative to the new working directory and include a provenance record. */
  recoveredFiles?: Array<{ operationId: string; sourceRunId: string; path: string }>;
  /** A fresh attempt starts from committed files. The previous attempt's local
   * directory is retained unmodified at this absolute path; changedFiles lists
   * its uncommitted paths (bounded) so the agent can recover that work. */
  priorWorkspace?: {
    sourceRunId: string;
    path: string;
    branchName: string | null;
    changedFilesKnown: boolean;
    changedFileCount: number;
    changedFiles: string[];
  };
  unresolvedInteractionIds: string[];
  coverage: {
    kind: "full_task_history" | "task_history_delta";
    baseRunId?: string;
    throughCommentId: string | null;
    summaryThroughCommentId: null;
    /** Set only on the prompt copy when the inline history was bounded to fit
     * one turn. The run keeps the complete envelope. */
    omitted?: {
      messages: number;
      clippedMessages: number;
      oldestIncludedMessageId: string | null;
      completedActions: number;
      completedActionResults: number;
      /** Interaction outcomes shown only as references or left out. */
      interactionOutcomes?: number;
      /** Older human answers shown without their result. */
      humanResponses?: number;
      /** Recovery decisions shown only as references or left out. */
      recoveryOutcomes?: number;
      /** 1 when the completed-work summary was shortened. */
      completedWork?: number;
    };
  };
}
