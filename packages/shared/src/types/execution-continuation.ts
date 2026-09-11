/** Server-authored context. Each message retains its author and trust boundary. */
export interface ExecutionContinuationEnvelope {
  version: 1;
  companyId: string;
  issueId: string;
  trigger: {
    reason: string;
    interactionId: string | null;
    sourceRunId: string | null;
  };
  originCommentIds: string[];
  objective: string;
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
  }>;
  interactionOutcomes: Array<{
    id: string;
    kind: string;
    status: string;
    result: unknown;
  }>;
  /** The number of older interaction outcomes the item cap dropped. */
  interactionOutcomesOmittedCount?: number;
  /** Only valid when resuming the provider session associated with this run. */
  resumeDelta?: {
    baseRunId: string;
    messages: ExecutionContinuationEnvelope["messages"];
    /** The number of older delta messages the item cap dropped from `messages`. */
    omittedMessageCount?: number;
  };
  recoveryOutcomes?: Array<{ recoveryActionId: string; decision: unknown }>;
  /** The number of older recovery outcomes the item cap dropped. */
  recoveryOutcomesOmittedCount?: number;
  completedWork: string | null;
  /** Completed mutations are context, never instructions to replay them. */
  completedActions?: Array<{
    runId: string;
    receiptId: string;
    operationId: string;
    result: unknown;
  }>;
  /** The number of older completed actions the item cap dropped. A dropped action is still durable; do not repeat it. */
  completedActionsOmittedCount?: number;
  unresolvedInteractionIds: string[];
  /** The number of older unresolved interactions the item cap dropped. */
  unresolvedInteractionIdsOmittedCount?: number;
  coverage: {
    kind: "full_task_history" | "task_history_delta";
    baseRunId?: string;
    throughCommentId: string | null;
    summaryThroughCommentId: null;
    /** The number of older messages the item cap dropped from `messages`. */
    omittedMessageCount?: number;
  };
}
