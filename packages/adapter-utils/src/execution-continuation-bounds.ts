import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

/**
 * The runner journals each command in a single PRP frame of about 510 KiB, and
 * the whole wake prompt travels in one turn command. A long task can collect
 * hundreds of messages, completed-action receipts and answers, so each rendered
 * history section gets a hard byte budget. The complete envelope stays on the
 * run and can be read in pages with get_task_context (view=full). Only the
 * native runner path applies this bound; local ACP turns have no PRP frame.
 */
export const CONTINUATION_PROMPT_MESSAGES_MAX_BYTES = 96_000;
export const CONTINUATION_PROMPT_ACTIONS_MAX_BYTES = 64_000;
export const CONTINUATION_PROMPT_INTERACTIONS_MAX_BYTES = 32_000;
export const CONTINUATION_PROMPT_HUMAN_RESPONSES_MAX_BYTES = 64_000;
/** A single long message keeps its start and its latest direction. */
export const CONTINUATION_PROMPT_MESSAGE_BODY_MAX_CHARS = 16_000;
/** A required message that still does not fit keeps a short excerpt. */
const REQUIRED_MESSAGE_MIN_BODY_CHARS = 2_000;

type Message = ExecutionContinuationEnvelope["messages"][number];
type CompletedAction = NonNullable<ExecutionContinuationEnvelope["completedActions"]>[number];
type InteractionOutcome = ExecutionContinuationEnvelope["interactionOutcomes"][number];
type HumanResponse = NonNullable<ExecutionContinuationEnvelope["humanResponses"]>[number];

export type ContinuationPromptOmissions = NonNullable<ExecutionContinuationEnvelope["coverage"]["omitted"]>;

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
// One element in a JSON array costs its own bytes plus a separator.
const elementBytes = (value: unknown) => bytes(value) + 1;

function clipBody(message: Message, maxChars: number): Message {
  if (message.body.length <= maxChars) return message;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return {
    ...message,
    body: `${message.body.slice(0, head)}\n[content omitted; read the full message with get_task_history]\n${message.body.slice(-tail)}`,
    bodyTruncated: true,
  };
}

function boundMessages(continuation: ExecutionContinuationEnvelope) {
  const all = continuation.messages;
  const objectiveId = continuation.objectiveSource?.kind === "comment" ? continuation.objectiveSource.id : null;
  // Required messages in priority order: the current objective, the newest
  // message, then the origin messages from newest to oldest.
  const requiredIds = [...new Set([
    ...(objectiveId ? [objectiveId] : []),
    ...(all.length ? [all.at(-1)!.id] : []),
    ...[...continuation.originCommentIds].reverse(),
  ])];
  const indexById = new Map(all.map((message, index) => [message.id, index]));
  const kept = new Map<number, Message>();
  let used = 1;
  const tryKeep = (index: number, candidates: Message[]) => {
    for (const candidate of candidates) {
      const size = elementBytes(candidate);
      if (used + size > CONTINUATION_PROMPT_MESSAGES_MAX_BYTES) continue;
      kept.set(index, candidate);
      used += size;
      return true;
    }
    return false;
  };
  for (const id of requiredIds) {
    const index = indexById.get(id);
    if (index === undefined || kept.has(index)) continue;
    const message = all[index]!;
    // The objective keeps its exact body when it fits: the prompt omits the
    // separate objective field while this message is displayed.
    tryKeep(index, [
      ...(id === objectiveId ? [message] : []),
      clipBody(message, CONTINUATION_PROMPT_MESSAGE_BODY_MAX_CHARS),
      clipBody(message, REQUIRED_MESSAGE_MIN_BODY_CHARS),
    ]);
  }
  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (kept.has(index)) continue;
    if (!tryKeep(index, [clipBody(all[index]!, CONTINUATION_PROMPT_MESSAGE_BODY_MAX_CHARS)])) break;
  }
  const messages = [...kept.entries()].sort(([a], [b]) => a - b).map(([, message]) => message);
  return {
    messages,
    omitted: all.length - messages.length,
    clipped: messages.filter((message) => message.bodyTruncated === true).length,
    oldestIncludedMessageId: messages[0]?.id ?? null,
  };
}

/**
 * Keep the newest entries whole, then older entries as compact references,
 * and drop the oldest only when even the references exceed the budget.
 */
function boundNewestFirst<T>(items: T[], maxBytes: number, compact: (item: T) => T) {
  const kept: T[] = [];
  let used = 1;
  let compacted = 0;
  let dropped = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const full = elementBytes(item);
    if (used + full <= maxBytes) {
      kept.push(item);
      used += full;
      continue;
    }
    const reference = compact(item);
    const size = elementBytes(reference);
    if (used + size <= maxBytes) {
      kept.push(reference);
      used += size;
      compacted += 1;
      continue;
    }
    dropped = index + 1;
    break;
  }
  return { items: kept.reverse(), compacted, dropped };
}

const compactAction = (action: CompletedAction): CompletedAction => ({
  runId: action.runId, receiptId: action.receiptId, operationId: action.operationId,
  result: { resultOmitted: true },
});

/** Return the continuation that fits the prompt budget, with an exact omission record. */
export function boundExecutionContinuationForPrompt(
  continuation: ExecutionContinuationEnvelope,
): ExecutionContinuationEnvelope {
  // Compact native input can omit history entirely; there is nothing to bound.
  if (!Array.isArray(continuation.messages)) return continuation;
  const actions = continuation.completedActions ?? [];
  const outcomes = Array.isArray(continuation.interactionOutcomes) ? continuation.interactionOutcomes : [];
  const responses = continuation.humanResponses ?? [];
  // Long bodies are clipped only when the messages together exceed the budget.
  const messagesFit = bytes(continuation.messages) <= CONTINUATION_PROMPT_MESSAGES_MAX_BYTES;
  const actionsFit = bytes(actions) <= CONTINUATION_PROMPT_ACTIONS_MAX_BYTES;
  const outcomesFit = bytes(outcomes) <= CONTINUATION_PROMPT_INTERACTIONS_MAX_BYTES;
  const responsesFit = bytes(responses) <= CONTINUATION_PROMPT_HUMAN_RESPONSES_MAX_BYTES;
  if (messagesFit && actionsFit && outcomesFit && responsesFit) return continuation;
  const messages = messagesFit
    ? { messages: continuation.messages, omitted: 0, clipped: 0, oldestIncludedMessageId: continuation.messages[0]?.id ?? null }
    : boundMessages(continuation);
  const boundedActions = actionsFit
    ? { items: actions, compacted: 0, dropped: 0 }
    : boundNewestFirst(actions, CONTINUATION_PROMPT_ACTIONS_MAX_BYTES, compactAction);
  // An outcome that repeats a server-verified human answer points to it.
  const answered = new Set(responses.map((response) => response.id));
  const boundedOutcomes = outcomesFit
    ? { items: outcomes, compacted: 0, dropped: 0 }
    : boundNewestFirst(outcomes, CONTINUATION_PROMPT_INTERACTIONS_MAX_BYTES, (outcome: InteractionOutcome) => ({
      id: outcome.id, kind: outcome.kind, status: outcome.status,
      result: answered.has(outcome.id) ? { seeHumanResponse: outcome.id } : { resultOmitted: true },
    }));
  const boundedResponses = responsesFit
    ? { items: responses, compacted: 0, dropped: 0 }
    : boundNewestFirst(responses, CONTINUATION_PROMPT_HUMAN_RESPONSES_MAX_BYTES, (response: HumanResponse) => ({
      ...response, result: { resultOmitted: true },
    }));
  return {
    ...continuation,
    messages: messages.messages,
    ...(continuation.completedActions ? { completedActions: boundedActions.items } : {}),
    ...(Array.isArray(continuation.interactionOutcomes) ? { interactionOutcomes: boundedOutcomes.items } : {}),
    ...(continuation.humanResponses ? { humanResponses: boundedResponses.items } : {}),
    coverage: {
      ...continuation.coverage,
      omitted: {
        messages: messages.omitted,
        clippedMessages: messages.clipped,
        oldestIncludedMessageId: messages.oldestIncludedMessageId,
        completedActions: boundedActions.dropped,
        completedActionResults: boundedActions.compacted,
        interactionOutcomes: boundedOutcomes.dropped + boundedOutcomes.compacted,
        humanResponses: boundedResponses.dropped + boundedResponses.compacted,
      },
    },
  };
}

export function continuationPromptOmissionNote(omitted: ContinuationPromptOmissions): string {
  const parts = [
    omitted.messages > 0 ? `${omitted.messages} older messages` : null,
    omitted.clippedMessages > 0 ? `the middle of ${omitted.clippedMessages} long messages` : null,
    omitted.completedActions > 0 ? `${omitted.completedActions} older completed actions` : null,
    omitted.completedActionResults > 0 ? `the results of ${omitted.completedActionResults} completed actions` : null,
    (omitted.interactionOutcomes ?? 0) > 0 ? `the results of ${omitted.interactionOutcomes} older interactions` : null,
    (omitted.humanResponses ?? 0) > 0 ? `the contents of ${omitted.humanResponses} older human answers` : null,
  ].filter((part): part is string => part !== null);
  return `This history is bounded to fit one turn: ${parts.join(", ")} are omitted here. `
    + "Earlier messages can be read with get_task_history (limit up to 200). The complete continuation, including every completed action, interaction and human answer with its recorded result, "
    + "is the executionContinuation field of get_task_context with view=full; read it in pages until nextOffset is null. "
    + "Retrieve only what the current request needs. An omitted answer still applies to its own question; read it before acting on that question. "
    + "An omitted action or result is still completed: do not repeat it.";
}
