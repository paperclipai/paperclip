export const MAX_EXECUTION_CONTINUATION_JSON_BYTES = 80 * 1024;
export const MAX_EXECUTION_CONTINUATION_OBJECTIVE_CHARS = 12_000;

export type ContinuationMessageLike = {
  id: string;
  body: string;
  deleted: boolean;
};

export type ContinuationEnvelopeLike<TMessage extends ContinuationMessageLike> = {
  objective: string;
  messages: TMessage[];
  resumeDelta?: { baseRunId: string; messages: TMessage[] };
  coverage: {
    kind: string;
    throughCommentId: string | null;
    summaryThroughCommentId: null;
    omittedCount?: number;
    oldestRetainedCommentId?: string | null;
    omittedDeletedIds?: string[];
  };
  completedWork?: string | null;
  completedActions?: unknown[];
  interactionOutcomes?: unknown[];
  recoveryOutcomes?: unknown[];
  humanResponses?: unknown[];
  unresolvedInteractionIds?: string[];
};

const utf8 = new TextEncoder();

export function omitDeletedContinuationMessages<TMessage extends ContinuationMessageLike>(
  messages: TMessage[],
): { messages: TMessage[]; omittedDeletedIds: string[] } {
  const omittedDeletedIds: string[] = [];
  const kept: TMessage[] = [];
  for (const message of messages) {
    if (message.deleted) {
      omittedDeletedIds.push(message.id);
      continue;
    }
    kept.push(message);
  }
  return { messages: kept, omittedDeletedIds };
}

export function capExecutionContinuationObjective(objective: string): string {
  return objective.length <= MAX_EXECUTION_CONTINUATION_OBJECTIVE_CHARS
    ? objective
    : objective.slice(0, MAX_EXECUTION_CONTINUATION_OBJECTIVE_CHARS);
}

function continuationUtf8Bytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).byteLength;
}

function firstNonOriginIndex<TMessage extends ContinuationMessageLike>(
  list: TMessage[],
  originSet: Set<string>,
): number {
  return list.findIndex((message) => !originSet.has(message.id));
}

export function boundExecutionContinuationEnvelope<
  TMessage extends ContinuationMessageLike,
  TEnvelope extends ContinuationEnvelopeLike<TMessage>,
>(
  envelope: TEnvelope,
  originCommentIds: string[],
  budgetBytes = MAX_EXECUTION_CONTINUATION_JSON_BYTES,
): TEnvelope & ContinuationEnvelopeLike<TMessage> {
  const originSet = new Set(originCommentIds);
  let messages = envelope.messages.slice();
  let resumeMessages = envelope.resumeDelta?.messages.slice() ?? null;
  let omittedCount = 0;
  let emptiedOriginBodies = false;
  let sidecarsTrimmed = false;
  let completedWork = envelope.completedWork ?? null;
  let completedActions = envelope.completedActions?.slice() ?? null;
  let interactionOutcomes = envelope.interactionOutcomes?.slice() ?? null;
  let recoveryOutcomes = envelope.recoveryOutcomes?.slice() ?? null;
  let humanResponses = envelope.humanResponses?.slice() ?? null;
  let unresolvedInteractionIds = envelope.unresolvedInteractionIds?.slice() ?? null;
  let omittedDeletedIds = envelope.coverage.omittedDeletedIds?.slice() ?? null;
  let objective = capExecutionContinuationObjective(envelope.objective);

  const wasTruncated = () =>
    omittedCount > 0 ||
    emptiedOriginBodies ||
    sidecarsTrimmed ||
    objective !== envelope.objective;

  const apply = (includeTruncationMeta: boolean): TEnvelope => {
    const truncated = includeTruncationMeta && wasTruncated();
    return {
      ...envelope,
      objective,
      messages,
      completedWork,
      ...(completedActions ? { completedActions } : {}),
      ...(interactionOutcomes ? { interactionOutcomes } : {}),
      ...(recoveryOutcomes ? { recoveryOutcomes } : {}),
      ...(humanResponses ? { humanResponses } : {}),
      ...(unresolvedInteractionIds ? { unresolvedInteractionIds } : {}),
      ...(envelope.resumeDelta && resumeMessages
        ? { resumeDelta: { ...envelope.resumeDelta, messages: resumeMessages } }
        : {}),
      coverage: {
        ...envelope.coverage,
        kind: truncated ? "truncated_task_history" : envelope.coverage.kind,
        throughCommentId: messages.at(-1)?.id ?? envelope.coverage.throughCommentId,
        ...(omittedDeletedIds && omittedDeletedIds.length > 0
          ? { omittedDeletedIds }
          : { omittedDeletedIds: undefined }),
        ...(truncated
          ? {
              omittedCount,
              oldestRetainedCommentId: messages[0]?.id ?? null,
            }
          : {}),
      },
    };
  };

  const overBudget = (includeTruncationMeta: boolean) =>
    continuationUtf8Bytes(apply(includeTruncationMeta)) > budgetBytes;

  const dropNonOriginFromHistory = (): boolean => {
    const dropIndex = firstNonOriginIndex(messages, originSet);
    if (dropIndex < 0) return false;
    const droppedId = messages[dropIndex]!.id;
    messages = messages.filter((_, index) => index !== dropIndex);
    if (resumeMessages) {
      resumeMessages = resumeMessages.filter((message) => message.id !== droppedId);
    }
    omittedCount += 1;
    return true;
  };

  const dropNonOriginFromDelta = (): boolean => {
    if (!resumeMessages) return false;
    const dropIndex = firstNonOriginIndex(resumeMessages, originSet);
    if (dropIndex < 0) return false;
    resumeMessages = resumeMessages.filter((_, index) => index !== dropIndex);
    omittedCount += 1;
    return true;
  };

  const emptyOldestOriginBody = (): boolean => {
    const bulkyIndex = messages.findIndex(
      (message) => originSet.has(message.id) && message.body.length > 0,
    );
    if (bulkyIndex < 0) return false;
    const originId = messages[bulkyIndex]!.id;
    messages = messages.map((message, index) =>
      index === bulkyIndex ? { ...message, body: "" } : message,
    );
    if (resumeMessages) {
      resumeMessages = resumeMessages.map((message) =>
        message.id === originId ? { ...message, body: "" } : message,
      );
    }
    emptiedOriginBodies = true;
    return true;
  };

  const trimSidecar = (): boolean => {
    if (typeof completedWork === "string" && completedWork.length > 0) {
      completedWork = null;
      sidecarsTrimmed = true;
      return true;
    }
    if (completedActions && completedActions.length > 0) {
      completedActions = [];
      sidecarsTrimmed = true;
      return true;
    }
    if (recoveryOutcomes && recoveryOutcomes.length > 0) {
      recoveryOutcomes = [];
      sidecarsTrimmed = true;
      return true;
    }
    if (humanResponses && humanResponses.length > 0) {
      humanResponses = [];
      sidecarsTrimmed = true;
      return true;
    }
    if (interactionOutcomes && interactionOutcomes.length > 0) {
      interactionOutcomes = [];
      sidecarsTrimmed = true;
      return true;
    }
    return false;
  };

  if (!overBudget(false)) {
    return apply(false);
  }

  // Subtracting standalone message JSON slightly under-saves (array commas),
  // which keeps the estimate conservative before the exact check below.
  let estimated = continuationUtf8Bytes(apply(true));
  while (estimated > budgetBytes) {
    const dropIndex = firstNonOriginIndex(messages, originSet);
    if (dropIndex < 0) break;
    const dropped = messages[dropIndex]!;
    estimated -= continuationUtf8Bytes(dropped);
    if (resumeMessages?.some((message) => message.id === dropped.id)) {
      estimated -= continuationUtf8Bytes(dropped);
    }
    dropNonOriginFromHistory();
  }

  while (overBudget(true)) {
    if (dropNonOriginFromHistory()) continue;
    if (dropNonOriginFromDelta()) continue;
    if (emptyOldestOriginBody()) continue;
    if (trimSidecar()) continue;
    break;
  }

  // Last resort: leftover ids/objective can still exceed the budget after
  // messages and sidecars are gone. Drop deleted-comment ids before pending
  // interaction ids — native replacement treats an empty pending list as
  // "no unanswered card" and can start a fresh run.
  while (overBudget(true)) {
    if (omittedDeletedIds && omittedDeletedIds.length > 0) {
      omittedDeletedIds = null;
      sidecarsTrimmed = true;
      continue;
    }
    if (unresolvedInteractionIds && unresolvedInteractionIds.length > 1) {
      unresolvedInteractionIds = unresolvedInteractionIds.slice(0, 1);
      sidecarsTrimmed = true;
      continue;
    }
    if (objective.length > 0) {
      objective = "";
      continue;
    }
    if (resumeMessages && resumeMessages.length > 0) {
      resumeMessages = [];
      omittedCount += 1;
      continue;
    }
    if (messages.length > 0) {
      messages = [];
      omittedCount += 1;
      continue;
    }
    if (unresolvedInteractionIds && unresolvedInteractionIds.length > 0) {
      unresolvedInteractionIds = [];
      sidecarsTrimmed = true;
      continue;
    }
    break;
  }

  return apply(wasTruncated());
}
