import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

/**
 * The runner journals each command in a single PRP frame of about 510 KiB, and
 * the whole wake prompt travels in one turn command. A long task can collect
 * hundreds of messages and completed-action receipts, so the inline history
 * gets a fixed budget. The complete envelope stays on the run and can be read
 * in pages with get_task_context (view=full).
 */
export const CONTINUATION_PROMPT_MESSAGES_MAX_BYTES = 96_000;
export const CONTINUATION_PROMPT_ACTIONS_MAX_BYTES = 64_000;
/** A single long message keeps its start and its latest direction. */
export const CONTINUATION_PROMPT_MESSAGE_BODY_MAX_CHARS = 16_000;

type Message = ExecutionContinuationEnvelope["messages"][number];
type CompletedAction = NonNullable<ExecutionContinuationEnvelope["completedActions"]>[number];

export type ContinuationPromptOmissions = NonNullable<ExecutionContinuationEnvelope["coverage"]["omitted"]>;

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
// One element in a JSON array costs its own bytes plus a separator.
const elementBytes = (value: unknown) => bytes(value) + 1;

function clipBody(message: Message): Message {
  if (message.body.length <= CONTINUATION_PROMPT_MESSAGE_BODY_MAX_CHARS) return message;
  const head = Math.floor(CONTINUATION_PROMPT_MESSAGE_BODY_MAX_CHARS * 0.7);
  const tail = CONTINUATION_PROMPT_MESSAGE_BODY_MAX_CHARS - head;
  return {
    ...message,
    body: `${message.body.slice(0, head)}\n[content omitted; read the full message with get_task_history]\n${message.body.slice(-tail)}`,
    bodyTruncated: true,
  };
}

function boundMessages(continuation: ExecutionContinuationEnvelope) {
  const all = continuation.messages;
  const required = new Set<string>(continuation.originCommentIds);
  if (continuation.objectiveSource?.kind === "comment") required.add(continuation.objectiveSource.id);
  const last = all.at(-1);
  if (last) required.add(last.id);
  // The objective source keeps its exact body: the prompt omits the separate
  // objective field when this message is displayed.
  const prepared = all.map((message) =>
    message.id === continuation.objectiveSource?.id ? message : clipBody(message));
  const keep = new Set<number>();
  let used = 1;
  prepared.forEach((message, index) => {
    if (!required.has(message.id)) return;
    keep.add(index);
    used += elementBytes(message);
  });
  for (let index = prepared.length - 1; index >= 0; index -= 1) {
    if (keep.has(index)) continue;
    const size = elementBytes(prepared[index]);
    if (used + size > CONTINUATION_PROMPT_MESSAGES_MAX_BYTES) break;
    keep.add(index);
    used += size;
  }
  const messages = prepared.filter((_message, index) => keep.has(index));
  return {
    messages,
    omitted: all.length - messages.length,
    clipped: messages.filter((message) => message.bodyTruncated === true).length,
    oldestIncludedMessageId: messages[0]?.id ?? null,
  };
}

function boundActions(actions: CompletedAction[]) {
  const kept: CompletedAction[] = [];
  let used = 1;
  let resultsOmitted = 0;
  let dropped = 0;
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index]!;
    const full = elementBytes(action);
    if (used + full <= CONTINUATION_PROMPT_ACTIONS_MAX_BYTES) {
      kept.push(action);
      used += full;
      continue;
    }
    const compact: CompletedAction = {
      runId: action.runId, receiptId: action.receiptId, operationId: action.operationId,
      result: { resultOmitted: true },
    };
    const size = elementBytes(compact);
    if (used + size <= CONTINUATION_PROMPT_ACTIONS_MAX_BYTES) {
      kept.push(compact);
      used += size;
      resultsOmitted += 1;
      continue;
    }
    dropped = index + 1;
    break;
  }
  return { completedActions: kept.reverse(), resultsOmitted, dropped };
}

/** Return the continuation that fits the prompt budget, with an exact omission record. */
export function boundExecutionContinuationForPrompt(
  continuation: ExecutionContinuationEnvelope,
): ExecutionContinuationEnvelope {
  const actions = continuation.completedActions ?? [];
  const messagesFit = bytes(continuation.messages) <= CONTINUATION_PROMPT_MESSAGES_MAX_BYTES
    && continuation.messages.every((message) => message.body.length <= CONTINUATION_PROMPT_MESSAGE_BODY_MAX_CHARS
      || message.id === continuation.objectiveSource?.id);
  const actionsFit = bytes(actions) <= CONTINUATION_PROMPT_ACTIONS_MAX_BYTES;
  if (messagesFit && actionsFit) return continuation;
  const messages = messagesFit
    ? { messages: continuation.messages, omitted: 0, clipped: 0, oldestIncludedMessageId: continuation.messages[0]?.id ?? null }
    : boundMessages(continuation);
  const boundedActions = actionsFit
    ? { completedActions: actions, resultsOmitted: 0, dropped: 0 }
    : boundActions(actions);
  return {
    ...continuation,
    messages: messages.messages,
    ...(continuation.completedActions ? { completedActions: boundedActions.completedActions } : {}),
    coverage: {
      ...continuation.coverage,
      omitted: {
        messages: messages.omitted,
        clippedMessages: messages.clipped,
        oldestIncludedMessageId: messages.oldestIncludedMessageId,
        completedActions: boundedActions.dropped,
        completedActionResults: boundedActions.resultsOmitted,
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
  ].filter((part): part is string => part !== null);
  return `This history is bounded to fit one turn: ${parts.join(", ")} are omitted here. `
    + "Earlier messages can be read with get_task_history (limit up to 200). The complete continuation, including every completed action and its recorded result, "
    + "is the executionContinuation field of get_task_context with view=full; read it in pages until nextOffset is null. "
    + "Legacy adapters can read the issue comments through the Paperclip API. Retrieve only what the current request needs. "
    + "An omitted action or result is still completed: do not repeat it.";
}
