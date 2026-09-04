import type { PaperclipQuestion, PaperclipQuestionResponse, PaperclipQuestionSet, TranscriptEntry } from "@paperclipai/adapter-utils";
import type { UIAdapterModule } from "../types";
import { parseCodexStdoutLine, buildPaperclipRunnerConfig } from "@paperclipai/adapter-codex-local/ui";
import { CodexLocalConfigFields } from "../codex-local/config-fields";

type JsonRecord = Record<string, unknown>;

interface PaperclipRunnerParserState {
  assistantDeltaItemIds: Set<string>;
  reasoningDeltaItemIds: Set<string>;
  resultSummaries: Set<string>;
  toolOutputItemIds: Set<string>;
  itemChannels: Map<string, "progress" | "final" | "summary" | "detail" | "unknown">;
  structuredFinalItemIds: Set<string>;
  runtimeRequests: Map<string, Extract<TranscriptEntry, { kind: "runtime_request" }>>;
}

function itemChannel(payload: JsonRecord): "progress" | "final" | "summary" | "detail" | "unknown" {
  const channel = text(payload.channel);
  return channel === "progress" || channel === "final" || channel === "summary" || channel === "detail"
    ? channel
    : "unknown";
}

function structuredResultSummary(value: string): string | null {
  if (!value.trimStart().startsWith("{")) return null;
  try {
    const parsed = record(JSON.parse(value));
    return text(parsed.schema) === "paperclip.run_result.v1" && text(parsed.summary)
      ? text(parsed.summary)
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function itemText(item: JsonRecord, payload: JsonRecord): string {
  const direct = text(item.text, text(payload.text));
  if (direct) return direct;
  const summary = Array.isArray(item.summary) ? item.summary : [];
  return summary
    .map((part) => text(record(part).text, text(part)))
    .filter(Boolean)
    .join("\n");
}

function normalizedItemType(item: JsonRecord, payload: JsonRecord): string {
  return text(item.type, text(payload.kind)).replaceAll("_", "").toLowerCase();
}

function itemId(event: JsonRecord, item: JsonRecord): string {
  return text(event.itemId, text(item.id, "paperclip-runner-item"));
}

function toolFailure(item: JsonRecord): boolean {
  const status = text(item.status).toLowerCase();
  const exitCode = item.exitCode ?? item.exit_code;
  return item.isError === true
    || item.is_error === true
    || item.success === false
    || (typeof exitCode === "number" && exitCode !== 0)
    || ["failed", "error", "errored", "cancelled"].includes(status);
}

function commandEntries(
  event: JsonRecord,
  item: JsonRecord,
  phase: "started" | "completed",
  ts: string,
): TranscriptEntry[] {
  const id = itemId(event, item);
  const commandActions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const command = text(item.command, text(record(commandActions[0]).command));
  if (phase === "started") {
    return [{ kind: "tool_call", ts, name: "command", toolUseId: id, input: { command } }];
  }
  const output = text(item.aggregatedOutput, text(item.aggregated_output));
  const exitCode = item.exitCode ?? item.exit_code;
  const detail = [
    typeof exitCode === "number" ? `exit_code: ${exitCode}` : "",
    output,
  ].filter(Boolean).join("\n");
  return [{
    kind: "tool_result",
    ts,
    toolUseId: id,
    toolName: "command",
    content: detail || text(item.status, "command completed"),
    isError: toolFailure(item),
  }];
}

function diffEntries(change: JsonRecord, ts: string): TranscriptEntry[] {
  const path = text(change.path);
  const kind = text(record(change.kind).type, text(change.kind, "update"));
  const raw = text(change.diff);
  const entries: TranscriptEntry[] = [];
  if (path) entries.push({ kind: "diff", ts, changeType: "file_header", text: path });
  for (const line of raw.split("\n")) {
    if (!line && raw.length === 0) continue;
    entries.push({
      kind: "diff",
      ts,
      changeType: kind === "add" ? "add" : kind === "delete" ? "remove" : "context",
      text: line,
    });
  }
  return entries;
}

function fileChangeEntries(
  event: JsonRecord,
  item: JsonRecord,
  phase: "started" | "completed",
  ts: string,
): TranscriptEntry[] {
  const id = itemId(event, item);
  const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
  const paths = changes.map((change) => text(change.path)).filter(Boolean);
  if (phase === "started") {
    return [{
      kind: "tool_call",
      ts,
      name: "file_change",
      toolUseId: id,
      input: { path: paths[0] ?? "", paths },
    }];
  }
  return [
    ...changes.flatMap((change) => diffEntries(change, ts)),
    {
      kind: "tool_result" as const,
      ts,
      toolUseId: id,
      toolName: "file_change",
      content: paths.length > 0 ? paths.join("\n") : "file change completed",
      isError: toolFailure(item),
    },
  ];
}

function dynamicToolEntries(
  event: JsonRecord,
  item: JsonRecord,
  phase: "started" | "completed",
  ts: string,
): TranscriptEntry[] {
  const id = itemId(event, item);
  const name = text(item.tool, text(item.name, "Paperclip tool"));
  if (phase === "started") {
    return [{ kind: "tool_call", ts, name, toolUseId: id, input: item.arguments ?? item.input ?? {} }];
  }
  return [{
    kind: "tool_result",
    ts,
    toolUseId: id,
    toolName: name,
    content: stringify(item.contentItems ?? item.result ?? item.output) || `${name} completed`,
    isError: toolFailure(item),
  }];
}

function genericToolEntries(
  event: JsonRecord,
  item: JsonRecord,
  phase: "started" | "completed",
  ts: string,
): TranscriptEntry[] {
  const id = itemId(event, item);
  const name = text(item.name, text(item.tool, "Tool"));
  if (phase === "started") {
    return [{ kind: "tool_call", ts, name, toolUseId: id, input: item.input ?? item.arguments ?? {} }];
  }
  return [{
    kind: "tool_result",
    ts,
    toolUseId: text(item.tool_use_id, id),
    toolName: name,
    content: stringify(item.content ?? item.result ?? item.output ?? item.error) || `${name} completed`,
    isError: toolFailure(item),
  }];
}

function parseItemEvent(
  event: JsonRecord,
  payload: JsonRecord,
  phase: "started" | "completed",
  ts: string,
  state: PaperclipRunnerParserState,
): TranscriptEntry[] {
  const item = record(payload.item);
  const type = normalizedItemType(item, payload);
  const id = itemId(event, item);
  const channel = itemChannel(payload);
  if (phase === "started") state.itemChannels.set(id, channel);
  const resolvedChannel = channel === "unknown" ? state.itemChannels.get(id) ?? "unknown" : channel;
  if (type === "agentmessage") {
    const value = itemText(item, payload);
    if (phase === "completed") state.itemChannels.delete(id);
    if (!value || state.assistantDeltaItemIds.has(id)) return [];
    if (resolvedChannel === "final") {
      const summary = structuredResultSummary(value);
      if (summary) {
        state.resultSummaries.add(summary);
        return [{ kind: "assistant", ts, text: summary, channel: "final", itemId: id }];
      }
    }
    return [{ kind: "assistant", ts, text: value, channel: resolvedChannel === "final" ? "final" : resolvedChannel === "progress" ? "progress" : "unknown", itemId: id }];
  }
  if (type === "reasoning") {
    const value = itemText(item, payload);
    if (phase === "completed") state.itemChannels.delete(id);
    return [{
      kind: "thinking",
      ts,
      text: value && !state.reasoningDeltaItemIds.has(id) ? value : "",
      lifecycle: phase,
      channel: resolvedChannel === "detail" ? "detail" : resolvedChannel === "summary" ? "summary" : "unknown",
      itemId: id,
    }];
  }
  if (type === "commandexecution") {
    const entries = commandEntries(event, item, phase, ts);
    if (phase === "completed" && state.toolOutputItemIds.has(id)) {
      const result = entries[0];
      if (result?.kind === "tool_result") result.content = "";
    }
    return entries;
  }
  if (type === "filechange") return fileChangeEntries(event, item, phase, ts);
  if (type === "dynamictoolcall") return dynamicToolEntries(event, item, phase, ts);
  if (type === "tooluse" || type === "toolresult" || type === "mcptoolcall") {
    return genericToolEntries(event, item, phase, ts);
  }
  if (type === "usage") return [];
  if (type === "usermessage") return [];
  const detail = itemText(item, payload);
  return detail ? [{ kind: "system", ts, text: detail }] : [];
}

function parseDeltaEvent(
  event: JsonRecord,
  payload: JsonRecord,
  ts: string,
  state: PaperclipRunnerParserState,
): TranscriptEntry[] {
  const kind = text(payload.kind).replaceAll("_", "").toLowerCase();
  const value = text(payload.text);
  const id = text(event.itemId, `${kind || "item"}-delta`);
  const explicitChannel = itemChannel(payload);
  const channel = explicitChannel === "unknown" ? state.itemChannels.get(id) ?? "unknown" : explicitChannel;
  if (!value) return [];
  if (kind === "agentmessage") {
    state.assistantDeltaItemIds.add(id);
    if (channel === "final" && (state.structuredFinalItemIds.has(id) || value.trimStart().startsWith("{"))) {
      state.structuredFinalItemIds.add(id);
      return [];
    }
    return [{ kind: "assistant", ts, text: value, delta: true, channel: channel === "final" ? "final" : channel === "progress" ? "progress" : "unknown", itemId: id }];
  }
  if (kind === "reasoning") {
    state.reasoningDeltaItemIds.add(id);
    return [{ kind: "thinking", ts, text: value, delta: true, channel: channel === "detail" ? "detail" : channel === "summary" ? "summary" : "unknown", itemId: id }];
  }
  if (kind === "commandexecution") {
    state.toolOutputItemIds.add(id);
    return [{
      kind: "tool_result",
      ts,
      toolUseId: id,
      toolName: "command",
      content: value,
      isError: false,
      delta: true,
    }];
  }
  if (kind === "filechange" || kind === "diff") {
    return value.split("\n").map((line) => ({
      kind: "diff" as const,
      ts,
      changeType: line.startsWith("+") ? "add" as const : line.startsWith("-") ? "remove" as const : "context" as const,
      text: /^[+-]/.test(line) ? line.slice(1) : line,
    }));
  }
  if (kind === "plan") return [{ kind: "system", ts, text: value }];
  return [{ kind: "system", ts, text: value }];
}

function usageEntry(payload: JsonRecord, ts: string): TranscriptEntry {
  const usage = Object.keys(record(payload.usage)).length > 0 ? record(payload.usage) : payload;
  const reported = Object.keys(record(usage.total)).length > 0
    ? record(usage.total)
    : Object.keys(record(usage.runDelta)).length > 0
      ? record(usage.runDelta)
      : usage;
  return {
    kind: "result",
    ts,
    text: "",
    inputTokens: number(reported.inputTokens ?? reported.input_tokens),
    outputTokens: number(reported.outputTokens ?? reported.output_tokens),
    cachedTokens: number(reported.cachedInputTokens ?? reported.cached_input_tokens ?? reported.cacheReadTokens),
    costUsd: number(usage.costUsd ?? usage.cost_usd),
    subtype: "paperclip.usage",
    isError: false,
    errors: [],
  };
}

const SAFE_WORKSPACE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function workspaceChangeEntry(payload: JsonRecord, ts: string): TranscriptEntry {
  const totals = record(payload.totals);
  const files = (Array.isArray(payload.files) ? payload.files : [])
    .map(record)
    .filter((file) => SAFE_WORKSPACE_PATH.test(text(file.path)))
    .slice(0, 2000)
    .map((file) => {
      const rawOperation = text(file.operation);
      const operation: "create" | "modify" | "delete" | "rename" | "mode_change" = rawOperation === "create" || rawOperation === "delete" || rawOperation === "rename" || rawOperation === "mode_change"
        ? rawOperation
        : "modify";
      const previousPath = nullableText(file.previousPath);
      return {
        path: text(file.path),
        operation,
        previousPath: previousPath && SAFE_WORKSPACE_PATH.test(previousPath) ? previousPath : null,
        additions: nullableNumber(file.additions),
        deletions: nullableNumber(file.deletions),
        binary: file.binary === true,
        diff: nullableText(file.diff),
      };
    });
  return {
    kind: "workspace_change",
    ts,
    changeSetId: text(payload.changeSetId, "workspace-change"),
    revision: Math.max(1, number(payload.revision)),
    source: payload.source === "runner_verified" ? "runner_verified" : "harness_reported",
    complete: payload.complete === true,
    files,
    totals: {
      files: Math.max(files.length, number(totals.files)),
      additions: nullableNumber(totals.additions),
      deletions: nullableNumber(totals.deletions),
    },
    patchArtifactRef: nullableText(payload.patchArtifactRef),
  };
}

function workspaceFileReferenceEntry(payload: JsonRecord, ts: string): TranscriptEntry | null {
  const path = text(payload.path);
  if (!SAFE_WORKSPACE_PATH.test(path)) return null;
  const rawPresentation = text(payload.presentation);
  const presentation = rawPresentation === "document" || rawPresentation === "code" || rawPresentation === "image"
    ? rawPresentation
    : "generic";
  return {
    kind: "workspace_file_reference",
    ts,
    referenceId: text(payload.referenceId, `workspace-file:${path}`),
    source: payload.source === "runner_verified" ? "runner_verified" : "harness_reported",
    path,
    displayName: text(payload.displayName, path.split("/").at(-1) ?? path),
    mediaType: nullableText(payload.mediaType),
    presentation,
    line: nullableNumber(payload.line),
    preview: nullableText(payload.preview),
    previewTruncated: payload.previewTruncated === true,
    contentDigest: nullableText(payload.contentDigest),
  };
}

function runtimeRequestEntry(
  eventType: string,
  payload: JsonRecord,
  event: JsonRecord,
  ts: string,
  state: PaperclipRunnerParserState,
): TranscriptEntry | null {
  const request = record(payload.request ?? payload);
  const requestId = text(request.requestId, text(payload.requestId));
  if (!requestId) return null;
  const previous = state.runtimeRequests.get(requestId);
  const suffix = eventType.split(".").at(-1);
  const resolvedAction = nullableText(request.action) ?? nullableText(payload.action) ?? previous?.resolvedAction ?? null;
  const rawStatus = text(request.status, suffix);
  const lifecycleStatus = rawStatus === "resolved" || rawStatus === "expired" || rawStatus === "cancelled"
    ? rawStatus
    : "pending";
  const status = lifecycleStatus === "resolved" && (resolvedAction === "cancel" || resolvedAction === "decline")
    ? "cancelled"
    : lifecycleStatus;
  const rawKind = text(request.requestKind, previous?.requestKind ?? undefined);
  const requestKind = rawKind === "runtime"
    ? "runtime"
    : rawKind === "command_approval"
    || rawKind === "file_approval"
    || rawKind === "permission_approval"
    || rawKind === "user_input"
    || rawKind === "elicitation"
    ? rawKind
    : null;
  const rawType = text(request.type, previous?.requestType);
  const requestType = requestKind === "user_input" || requestKind === "elicitation"
    || rawType === "input" || rawType.includes("input") || rawType.includes("elicitation")
    ? "input"
    : "permission";
  const explicitChoices = (Array.isArray(request.choices) ? request.choices : [])
    .map(record)
    .map((choice) => ({ key: text(choice.key), label: text(choice.label) }))
    .filter((choice) => choice.key && choice.label)
    .slice(0, 32);
  const actionLabels: Record<string, string> = {
    accept: "Allow once",
    accept_for_session: "Allow for session",
    decline: "Deny",
    cancel: "Cancel",
  };
  const actions = (Array.isArray(request.actions) ? request.actions : [])
    .filter((action): action is string => typeof action === "string" && action in actionLabels)
    .slice(0, 4)
    .map((key) => ({ key, label: actionLabels[key] }));
  const defaultChoices = requestType === "permission"
    ? [
        { key: "accept", label: actionLabels.accept },
        { key: "accept_for_session", label: actionLabels.accept_for_session },
        { key: "decline", label: actionLabels.decline },
        { key: "cancel", label: actionLabels.cancel },
      ]
    : [];
  const choices = explicitChoices.length > 0
    ? explicitChoices
    : actions.length > 0
      ? actions
      : previous?.choices.length
        ? previous.choices
        : defaultChoices;
  const details = record(request.details);
  const fields = (Array.isArray(details.fields) ? details.fields : previous?.fields ?? [])
    .map(record)
    .map((field, index) => ({
      name: text(field.name, `answer_${index + 1}`).slice(0, 160),
      label: text(field.label, text(field.name, `Answer ${index + 1}`)).slice(0, 240),
      placeholder: nullableText(field.placeholder)?.slice(0, 500) ?? null,
    }))
    .filter((field) => field.name && field.label)
    .slice(0, 16);
  const questionSet = parseQuestionSet(request.input) ?? previous?.questionSet ?? null;
  const response = parseQuestionResponse(request.response ?? payload.response)
    ?? previous?.response
    ?? null;
  const entry: Extract<TranscriptEntry, { kind: "runtime_request" }> = {
    kind: "runtime_request",
    ts,
    requestId,
    requestKind,
    turnId: nullableText(request.turnId) ?? nullableText(payload.turnId) ?? nullableText(event.turnId) ?? previous?.turnId ?? null,
    requestType,
    status,
    prompt: text(request.prompt, previous?.prompt ?? "Runtime approval requested"),
    choices,
    fields,
    questionSet,
    resolvedAction,
    response,
  };
  state.runtimeRequests.set(requestId, entry);
  return entry;
}

function parseQuestionResponse(value: unknown): PaperclipQuestionResponse | null {
  const response = record(value);
  if (response.schema !== "paperclip.question_response.v1") return null;
  const rawAnswers = record(response.answers);
  const answers: PaperclipQuestionResponse["answers"] = {};
  for (const [questionId, rawAnswer] of Object.entries(rawAnswers).slice(0, 64)) {
    const answer = record(rawAnswer);
    const selectedOptionIds = (Array.isArray(answer.selectedOptionIds) ? answer.selectedOptionIds : [])
      .filter((optionId): optionId is string => typeof optionId === "string")
      .slice(0, 128)
      .map((optionId) => optionId.slice(0, 160));
    const textAnswer = nullableText(answer.text)?.slice(0, 12_000);
    const customText = nullableText(answer.customText)?.slice(0, 12_000);
    answers[questionId.slice(0, 160)] = {
      ...(selectedOptionIds.length > 0 ? { selectedOptionIds } : {}),
      ...(textAnswer != null ? { text: textAnswer } : {}),
      ...(customText != null ? { customText } : {}),
    };
  }
  return { schema: "paperclip.question_response.v1", answers };
}

function parseQuestionSet(value: unknown): PaperclipQuestionSet | null {
  const input = record(value);
  if (!Array.isArray(input.questions) || input.questions.length === 0) return null;
  // Early v2 events passed through a broad JWT redactor that replaced the
  // dotted schema discriminator while leaving the bounded question set
  // intact. Recover those already-persisted requests on replay; reject other
  // explicit schema families so this remains a narrow migration path.
  if (input.schema !== undefined
    && input.schema !== "paperclip.question_set.v1"
    && input.schema !== "***REDACTED***") return null;
  const questions = input.questions.map(record).slice(0, 64).map((question, questionIndex): PaperclipQuestion => {
    const answerMode: PaperclipQuestion["answerMode"] = question.answerMode === "single_select" || question.answerMode === "multi_select" ? question.answerMode : "text";
    const options = (Array.isArray(question.options) ? question.options : []).map(record).slice(0, 128).map((option, optionIndex) => ({
      id: text(option.id, `option-${optionIndex + 1}`).slice(0, 160),
      label: text(option.label, `Option ${optionIndex + 1}`).slice(0, 1_000),
      ...(nullableText(option.description) ? { description: text(option.description).slice(0, 4_000) } : {}),
    }));
    const customAnswer = record(question.customAnswer);
    const validation = record(question.textValidation);
    const inputType: NonNullable<PaperclipQuestion["textValidation"]>["inputType"] =
      validation.inputType === "number" || validation.inputType === "integer" || validation.inputType === "text"
        ? validation.inputType
        : undefined;
    const parsedQuestion: PaperclipQuestion = {
      id: text(question.id, `question-${questionIndex + 1}`).slice(0, 160),
      ...(nullableText(question.header) ? { header: text(question.header).slice(0, 1_000) } : {}),
      prompt: text(question.prompt, `Question ${questionIndex + 1}`).slice(0, 4_000),
      ...(nullableText(question.helpText) ? { helpText: text(question.helpText).slice(0, 4_000) } : {}),
      required: question.required === true,
      answerMode,
      ...(answerMode !== "text" ? { options } : {}),
      ...(customAnswer.enabled === true ? { customAnswer: {
        enabled: true as const,
        ...(nullableText(customAnswer.label) ? { label: text(customAnswer.label).slice(0, 1_000) } : {}),
        ...(nullableText(customAnswer.placeholder) ? { placeholder: text(customAnswer.placeholder).slice(0, 1_000) } : {}),
      } } : {}),
      ...(Object.keys(validation).length > 0 ? { textValidation: {
        ...(typeof validation.minLength === "number" ? { minLength: validation.minLength } : {}),
        ...(typeof validation.maxLength === "number" ? { maxLength: validation.maxLength } : {}),
        ...(typeof validation.pattern === "string" ? { pattern: validation.pattern.slice(0, 1_000) } : {}),
        ...(inputType ? { inputType } : {}),
        ...(typeof validation.minimum === "number" ? { minimum: validation.minimum } : {}),
        ...(typeof validation.maximum === "number" ? { maximum: validation.maximum } : {}),
      } } : {}),
    };
    return parsedQuestion;
  });
  return {
    schema: "paperclip.question_set.v1",
    ...(nullableText(input.title) ? { title: text(input.title).slice(0, 1_000) } : {}),
    ...(nullableText(input.description) ? { description: text(input.description).slice(0, 4_000) } : {}),
    ...(nullableText(input.submitLabel) ? { submitLabel: text(input.submitLabel).slice(0, 200) } : {}),
    questions,
  };
}

function runResultEntry(payload: JsonRecord, ts: string): Extract<TranscriptEntry, { kind: "run_result" }> {
  const completion = record(payload.completionClaim);
  const blocker = record(payload.blocker);
  const rawDisposition = text(payload.reportedWorkDisposition);
  const disposition = rawDisposition === "blocked" || rawDisposition === "needs_review" || rawDisposition === "yielded"
    ? rawDisposition
    : "done";
  return {
    kind: "run_result",
    ts,
    disposition,
    summary: text(payload.summary, "Run completed"),
    objectiveSatisfied: typeof completion.objectiveSatisfied === "boolean" ? completion.objectiveSatisfied : null,
    verification: (Array.isArray(payload.verification) ? payload.verification : []).map(record).slice(0, 64).map((item) => ({
      commandOrCheck: text(item.commandOrCheck, "Verification"),
      status: item.status === "passed" || item.status === "failed" ? item.status : "not_run",
      detail: nullableText(item.detail) ?? undefined,
      artifactRef: nullableText(item.artifactRef) ?? undefined,
    })),
    remainingWork: (Array.isArray(completion.remainingWork) ? completion.remainingWork : []).map(record).slice(0, 64).map((item) => ({
      description: text(item.description, "Remaining work"),
      blocksCompletion: item.blocksCompletion === true,
    })),
    blocker: Object.keys(blocker).length > 0 ? {
      reasonCode: text(blocker.reasonCode, "blocked"),
      unblockAction: text(blocker.unblockAction, "Resolve the blocker to continue."),
      scope: blocker.scope === "task_wide" ? "task_wide" : "current_track",
    } : null,
    artifacts: (Array.isArray(payload.artifacts) ? payload.artifacts : []).map(record).slice(0, 64).map((item) => ({
      kind: text(item.kind, "artifact"),
      ref: text(item.ref),
      title: nullableText(item.title) ?? undefined,
    })).filter((item) => item.ref.length > 0),
  };
}

function runTerminalEntry(payload: JsonRecord, ts: string): Extract<TranscriptEntry, { kind: "run_terminal" }> {
  const rawTurnState = text(payload.turnTerminalState);
  const turnState = rawTurnState === "failed" || rawTurnState === "interrupted" || rawTurnState === "cancelled"
    ? rawTurnState
    : "completed";
  const rawRunState = text(payload.runTerminalState);
  const runState = rawRunState === "failed" || rawRunState === "cancelled" ? rawRunState : "succeeded";
  const rawDisposition = text(payload.reportedWorkDisposition);
  const disposition = rawDisposition === "blocked" || rawDisposition === "needs_review" || rawDisposition === "yielded"
    ? rawDisposition
    : "done";
  const stopReason = record(payload.stopReason);
  return {
    kind: "run_terminal",
    ts,
    turnState,
    runState,
    disposition,
    stopReason: nullableText(stopReason.message) ?? nullableText(stopReason.code) ?? undefined,
  };
}

function semanticToolEntries(eventType: string, payload: JsonRecord, ts: string): TranscriptEntry[] {
  const semantic = record(payload.semantic_tool ?? payload.semanticTool);
  const callId = text(semantic.callId, "semantic-tool");
  const operationId = text(semantic.operationId, "Paperclip operation");
  const content = record(semantic.content);
  const references = (Array.isArray(content.references) ? content.references : []).map(record);
  const input = {
    reference: references.map((reference) => `${text(reference.kind)}:${text(reference.id)}`).filter((value) => value !== ":").join(", "),
  };
  if (eventType.endsWith("input")) {
    return [{ kind: "tool_call", ts, name: operationId, toolUseId: callId, input }];
  }
  const outcome = text(semantic.outcome, "succeeded");
  const code = text(semantic.code, outcome);
  const receipt = text(semantic.operationReceiptId);
  return [{
    kind: "tool_result",
    ts,
    toolUseId: callId,
    toolName: operationId,
    content: [code, receipt ? `receipt: ${receipt}` : ""].filter(Boolean).join("\n"),
    isError: outcome === "denied" || outcome === "conflict" || outcome === "unavailable" || outcome === "failed",
  }];
}

function parsePrpEvent(
  event: JsonRecord,
  ts: string,
  state: PaperclipRunnerParserState,
): TranscriptEntry[] {
  const eventType = text(event.eventType);
  const payload = record(event.payload);
  const family = eventType.startsWith("plan.") ? "plan"
    : eventType.startsWith("tool.execution.") ? "tool_execution"
      : eventType.startsWith("research.") ? "research"
        : eventType.startsWith("delegation.") ? "delegation"
          : eventType.startsWith("model.") ? "model_identity"
            : eventType.startsWith("context.") ? "context"
              : eventType.startsWith("artifact.") ? "artifact"
                : eventType.startsWith("review.") ? "review"
                  : eventType.startsWith("hook.") ? "hook"
                    : eventType.startsWith("memory.") ? "memory"
                      : eventType.startsWith("safety.") ? "safety"
                        : eventType.startsWith("terminal.") ? "terminal"
                          : eventType.startsWith("wait.") ? "wait"
                            : eventType.startsWith("provider.notice.") ? "provider_notice" : null;
  if (family !== null) {
    const rawStatus = text(payload.status);
    const status = (family === "plan" && payload.complete === false) || rawStatus === "running" || rawStatus === "pending" || eventType.endsWith("started") || eventType.endsWith("progressed") ? "running"
      : rawStatus === "failed" || rawStatus === "denied" ? "failed"
        : rawStatus === "interrupted" || rawStatus === "cancelled" ? "interrupted"
          : (family === "plan" && payload.complete === true) || eventType.endsWith("completed") || rawStatus === "completed" ? "completed" : "informational";
    const title = ({ plan: "Plan", tool_execution: "Tool execution", research: "Research", delegation: "Delegation", model_identity: "Model", context: "Context", artifact: "Artifact", review: "Review mode", hook: "Hook", memory: "Memory citation", safety: "Safety review", terminal: "Terminal input", wait: "Intentional wait", provider_notice: "Provider notice" } as const)[family];
    const summary = family === "model_identity"
      ? text(payload.summary, text(payload.effectiveModel, text(payload.requestedModel, text(payload.provider, eventType))))
      : text(payload.summary, text(payload.name, text(payload.query, eventType)));
    return [{ kind: "provider_activity", ts, family, eventType, status, title, summary, payload }];
  }
  if (eventType === "workspace.change.updated" || eventType === "workspace.diff.recorded") {
    return [workspaceChangeEntry(payload, ts)];
  }
  if (eventType === "workspace.file.referenced") {
    const entry = workspaceFileReferenceEntry(payload, ts);
    return entry ? [entry] : [{ kind: "system", ts, text: "Runner: Ignored an unsafe workspace file reference" }];
  }
  if (eventType.startsWith("runtime_request.")) {
    const entry = runtimeRequestEntry(eventType, payload, event, ts, state);
    return entry ? [entry] : [];
  }
  if (
    eventType === "semantic_tool.input"
    || eventType === "semantic_tool.result"
    || eventType === "mcp_app.tool_input"
    || eventType === "mcp_app.tool_result"
  ) {
    return semanticToolEntries(eventType, payload, ts);
  }
  if (eventType === "session.started" || eventType === "session.resumed") {
    const context = record(payload.context);
    const model = text(context.model, text(record(payload.model).name, "Paperclip runner"));
    const sessionId = text(payload.providerSessionId, text(payload.driverSessionId, text(event.normalizedSessionId)));
    return [{ kind: "system", ts, text: `Paperclip session ${eventType === "session.resumed" ? "resumed" : "started"} · ${model}${sessionId ? ` · ${sessionId}` : ""}` }];
  }
  if (eventType === "turn.started") return [{ kind: "system", ts, text: "Turn started" }];
  if (eventType === "turn.completed") return [{ kind: "system", ts, text: "Turn completed" }];
  if (eventType === "turn.failed") return [{ kind: "stderr", ts, text: text(record(payload.error).message, "Turn failed") }];
  if (eventType === "item.started" || eventType === "item.completed") {
    if (payload.kind === "usage") return [usageEntry(payload, ts)];
    return parseItemEvent(event, payload, eventType === "item.started" ? "started" : "completed", ts, state);
  }
  if (eventType === "item.failed") {
    const item = record(payload.item);
    const error = record(payload.error);
    return [{ kind: "stderr", ts, text: text(error.message, text(item.error, "Runner item failed")) }];
  }
  if (eventType === "item.delta") return parseDeltaEvent(event, payload, ts, state);
  if (eventType === "usage.reported") return [usageEntry(payload, ts)];
  if (eventType === "run.result.proposed" || eventType === "run.result.accepted") {
    const result = eventType === "run.result.accepted" ? record(payload.result) : payload;
    const summary = text(result.summary);
    if (!summary || state.resultSummaries.has(summary)) return [];
    state.resultSummaries.add(summary);
    // The semantic summary is governance state, not provider-authored prose.
    // Stored task projection can use it as a terminal fallback after seeing
    // the complete run, but the streaming parser must not race a later
    // explicit final item and materialize a duplicate reply.
    return [runResultEntry(result, ts)];
  }
  if (eventType === "run.terminal") return [runTerminalEntry(payload, ts)];
  if (eventType === "harness.diagnostic" || eventType === "runner.diagnostic" || eventType === "session.failed" || eventType === "mcp_app.failed") {
    return [{ kind: "system", ts, text: `Runner: ${text(payload.message, text(payload.code, eventType))}` }];
  }
  return [];
}

function createParserState(): PaperclipRunnerParserState {
  return {
    assistantDeltaItemIds: new Set(),
    reasoningDeltaItemIds: new Set(),
    resultSummaries: new Set(),
    toolOutputItemIds: new Set(),
    itemChannels: new Map(),
    structuredFinalItemIds: new Set(),
    runtimeRequests: new Map(),
  };
}

function parsePaperclipRunnerLine(line: string, ts: string, state: PaperclipRunnerParserState): TranscriptEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return parseCodexStdoutLine(line, ts);
  }
  const envelope = record(parsed);
  if (envelope.type !== "paperclip.prp.event") return parseCodexStdoutLine(line, ts);
  const event = record(envelope.event);
  return Object.keys(event).length > 0 ? parsePrpEvent(event, ts, state) : [];
}

export function parsePaperclipRunnerStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parsePaperclipRunnerLine(line, ts, createParserState());
}

export const paperclipRunnerUIAdapter: UIAdapterModule = {
  type: "paperclip_runner",
  label: "Paperclip Runner",
  parseStdoutLine: parsePaperclipRunnerStdoutLine,
  createStdoutParser: () => {
    let state = createParserState();
    return {
      parseLine: (line, ts) => parsePaperclipRunnerLine(line, ts, state),
      reset: () => { state = createParserState(); },
    };
  },
  ConfigFields: CodexLocalConfigFields,
  buildAdapterConfig: buildPaperclipRunnerConfig,
};
