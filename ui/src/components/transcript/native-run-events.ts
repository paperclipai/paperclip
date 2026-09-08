import type { HeartbeatRunEvent } from "@paperclipai/shared";
import type { TranscriptEntry } from "@/adapters";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizedItem(payload: Record<string, unknown>): Record<string, unknown> {
  return record(payload.item) ?? payload;
}

function normalizedItemKind(payload: Record<string, unknown>): string {
  const item = normalizedItem(payload);
  return (text(payload.kind) ?? text(item.kind) ?? text(item.type) ?? "")
    .replaceAll("_", "")
    .toLowerCase();
}

function isAssistantItemKind(kind: string): boolean {
  return kind === "agentmessage" || kind === "assistantmessage";
}

function normalizedItemId(
  envelope: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | null {
  const item = normalizedItem(payload);
  return text(envelope.itemId) ?? text(payload.itemId) ?? text(item.id);
}

function normalizedItemText(payload: Record<string, unknown>): string | null {
  const item = normalizedItem(payload);
  return text(payload.text) ?? text(item.text);
}

function assistantChannel(
  payload: Record<string, unknown>,
  fallback: "progress" | "final" | "unknown" = "unknown",
): "progress" | "final" | "unknown" {
  const item = normalizedItem(payload);
  const value = text(payload.channel) ?? text(item.channel);
  if (value === "progress" || value === "final" || value === "unknown") return value;
  return fallback;
}

function reasoningChannel(
  payload: Record<string, unknown>,
  fallback: "summary" | "detail" | "unknown" = "unknown",
): "summary" | "detail" | "unknown" {
  const item = normalizedItem(payload);
  const value = text(payload.channel) ?? text(item.channel);
  if (value === "summary" || value === "detail" || value === "unknown") return value;
  return fallback;
}

interface ItemIdentity {
  kind: string;
  assistantChannel: "progress" | "final" | "unknown";
  reasoningChannel: "summary" | "detail" | "unknown";
}

function resolveItemIdentity(
  payload: Record<string, unknown>,
  previous?: ItemIdentity,
): ItemIdentity {
  return {
    kind: normalizedItemKind(payload) || previous?.kind || "",
    assistantChannel: assistantChannel(payload, previous?.assistantChannel),
    reasoningChannel: reasoningChannel(payload, previous?.reasoningChannel),
  };
}

function isItemIdentityEvent(eventType: string): boolean {
  return eventType === "item.started"
    || eventType === "item.delta"
    || eventType === "item.completed";
}

const TOOL_EXECUTION_SCHEMA = "paperclip.tool.execution.v1";
const RUN_RESULT_SCHEMA = "paperclip.run_result.v1";
const RUN_TERMINAL_SCHEMA = "paperclip.prp.terminal.v1";

function canonicalQuestionSet(
  value: unknown,
): Extract<TranscriptEntry, { kind: "runtime_request" }>["questionSet"] {
  const candidate = record(value);
  if (
    !candidate
    || candidate.schema !== "paperclip.question_set.v1"
    || !Array.isArray(candidate.questions)
    || candidate.questions.length === 0
  ) return null;
  const valid = candidate.questions.every((rawQuestion) => {
    const question = record(rawQuestion);
    return Boolean(
      question
      && text(question.id)
      && text(question.prompt)
      && typeof question.required === "boolean"
      && (
        question.answerMode === "single_select"
        || question.answerMode === "multi_select"
        || question.answerMode === "text"
      ),
    );
  });
  return valid
    ? structuredClone(candidate) as unknown as NonNullable<
        Extract<TranscriptEntry, { kind: "runtime_request" }>["questionSet"]
      >
    : null;
}

function canonicalQuestionResponse(
  value: unknown,
): Extract<TranscriptEntry, { kind: "runtime_request" }>["response"] {
  const candidate = record(value);
  return candidate
    && candidate.schema === "paperclip.question_response.v1"
    && record(candidate.answers)
    ? structuredClone(candidate) as unknown as NonNullable<
        Extract<TranscriptEntry, { kind: "runtime_request" }>["response"]
      >
    : null;
}

function verificationStatus(value: unknown): "passed" | "failed" | "not_run" {
  return value === "passed" || value === "failed" ? value : "not_run";
}

function runtimeRequestEntry(input: {
  eventType: string;
  envelope: Record<string, unknown>;
  payload: Record<string, unknown>;
  ts: string;
  previous?: Extract<TranscriptEntry, { kind: "runtime_request" }>;
}): Extract<TranscriptEntry, { kind: "runtime_request" }> | null {
  const request = record(input.payload.request) ?? input.payload;
  const requestId = text(request.requestId) ?? text(input.payload.requestId);
  if (!requestId) return null;
  const suffix = input.eventType.split(".").at(-1);
  const rawStatus = text(request.status) ?? suffix;
  const resolvedAction = text(request.action)
    ?? text(input.payload.action)
    ?? input.previous?.resolvedAction
    ?? null;
  const lifecycleStatus = rawStatus === "resolved"
    || rawStatus === "expired"
    || rawStatus === "cancelled"
    ? rawStatus
    : "pending";
  const status = lifecycleStatus === "resolved"
    && (resolvedAction === "cancel" || resolvedAction === "decline")
    ? "cancelled"
    : lifecycleStatus;
  const rawKind = text(request.requestKind) ?? input.previous?.requestKind ?? null;
  const requestKind = rawKind === "runtime"
    || rawKind === "command_approval"
    || rawKind === "file_approval"
    || rawKind === "permission_approval"
    || rawKind === "user_input"
    || rawKind === "elicitation"
    ? rawKind
    : null;
  const rawType = text(request.type) ?? input.previous?.requestType ?? "permission";
  const requestType = requestKind === "user_input"
    || requestKind === "elicitation"
    || rawType === "input"
    || rawType.includes("input")
    || rawType.includes("elicitation")
    ? "input"
    : "permission";
  const choices = (Array.isArray(request.choices) ? request.choices : [])
    .map(record)
    .flatMap((choice) => {
      const key = text(choice?.key);
      const label = text(choice?.label);
      return key && label ? [{ key, label }] : [];
    })
    .slice(0, 32);
  const details = record(request.details);
  const fields = (Array.isArray(details?.fields) ? details.fields : [])
    .map(record)
    .flatMap((field, index) => {
      const name = text(field?.name) ?? `answer_${index + 1}`;
      const label = text(field?.label) ?? text(field?.name) ?? `Answer ${index + 1}`;
      return name && label
        ? [{ name: name.slice(0, 160), label: label.slice(0, 240), placeholder: text(field?.placeholder)?.slice(0, 500) ?? null }]
        : [];
    })
    .slice(0, 16);
  return {
    kind: "runtime_request",
    ts: input.ts,
    requestId,
    requestKind,
    turnId: text(request.turnId)
      ?? text(input.payload.turnId)
      ?? text(input.envelope.turnId)
      ?? input.previous?.turnId
      ?? null,
    requestType,
    status,
    prompt: text(request.prompt)
      ?? input.previous?.prompt
      ?? "Runtime approval requested",
    choices: choices.length > 0 ? choices : input.previous?.choices ?? [],
    fields: fields.length > 0 ? fields : input.previous?.fields ?? [],
    questionSet: canonicalQuestionSet(request.input)
      ?? input.previous?.questionSet
      ?? null,
    resolvedAction,
    response: canonicalQuestionResponse(request.response ?? input.payload.response)
      ?? input.previous?.response
      ?? null,
  };
}

function runResultEntry(
  payload: Record<string, unknown>,
  ts: string,
): Extract<TranscriptEntry, { kind: "run_result" }> {
  const completion = record(payload.completionClaim) ?? {};
  const blocker = record(payload.blocker);
  const rawDisposition = text(payload.reportedWorkDisposition);
  const disposition = rawDisposition === "blocked"
    || rawDisposition === "needs_review"
    || rawDisposition === "yielded"
    ? rawDisposition
    : "done";
  return {
    kind: "run_result",
    ts,
    disposition,
    summary: text(payload.summary) ?? "Run completed",
    objectiveSatisfied: typeof completion.objectiveSatisfied === "boolean"
      ? completion.objectiveSatisfied
      : null,
    verification: (Array.isArray(payload.verification) ? payload.verification : [])
      .map(record)
      .flatMap((item) => item ? [{
        commandOrCheck: text(item.commandOrCheck) ?? "Verification",
        status: verificationStatus(item.status),
        ...(text(item.detail) ? { detail: text(item.detail)! } : {}),
        ...(text(item.artifactRef) ? { artifactRef: text(item.artifactRef)! } : {}),
      }] : [])
      .slice(0, 64),
    remainingWork: (Array.isArray(completion.remainingWork) ? completion.remainingWork : [])
      .map(record)
      .flatMap((item) => item && text(item.description) ? [{
        description: text(item.description)!,
        blocksCompletion: item.blocksCompletion === true,
      }] : [])
      .slice(0, 64),
    blocker: blocker ? {
      reasonCode: text(blocker.reasonCode) ?? "blocked",
      unblockAction: text(blocker.unblockAction) ?? "Resolve the blocker to continue.",
      scope: blocker.scope === "task_wide" ? "task_wide" : "current_track",
    } : null,
    artifacts: (Array.isArray(payload.artifacts) ? payload.artifacts : [])
      .map(record)
      .flatMap((item) => item && text(item.ref) ? [{
        kind: text(item.kind) ?? "artifact",
        ref: text(item.ref)!,
        ...(text(item.title) ? { title: text(item.title)! } : {}),
      }] : [])
      .slice(0, 64),
  };
}

function runTerminalEntry(
  payload: Record<string, unknown>,
  ts: string,
): Extract<TranscriptEntry, { kind: "run_terminal" }> | null {
  if (payload.schema !== RUN_TERMINAL_SCHEMA) return null;
  const rawTurnState = text(payload.turnTerminalState);
  const rawRunState = text(payload.runTerminalState);
  const rawDisposition = text(payload.reportedWorkDisposition);
  if (
    !rawTurnState
    || !["completed", "failed", "interrupted", "cancelled"].includes(rawTurnState)
    || !rawRunState
    || !["succeeded", "failed", "cancelled"].includes(rawRunState)
    || !rawDisposition
    || !["done", "blocked", "needs_review", "yielded"].includes(rawDisposition)
  ) return null;
  const stopReason = record(payload.stopReason);
  return {
    kind: "run_terminal",
    ts,
    turnState: rawTurnState as Extract<TranscriptEntry, { kind: "run_terminal" }>["turnState"],
    runState: rawRunState as Extract<TranscriptEntry, { kind: "run_terminal" }>["runState"],
    disposition: rawDisposition as Extract<TranscriptEntry, { kind: "run_terminal" }>["disposition"],
    ...(text(stopReason?.message) || text(stopReason?.code)
      ? { stopReason: text(stopReason?.message) ?? text(stopReason?.code)! }
      : {}),
  };
}

const PROVIDER_ACTIVITY_PRESENTATIONS = {
  "plan.updated": {
    schema: "paperclip.plan.updated.v1",
    idKey: "planId",
    name: "plan",
    summaryKeys: ["explanation"],
  },
  "research.started": {
    schema: "paperclip.research.v1",
    idKey: "researchId",
    name: "research",
    summaryKeys: ["query", "pattern", "url"],
  },
  "research.progressed": {
    schema: "paperclip.research.v1",
    idKey: "researchId",
    name: "research",
    summaryKeys: ["query", "pattern", "url"],
  },
  "research.completed": {
    schema: "paperclip.research.v1",
    idKey: "researchId",
    name: "research",
    summaryKeys: ["query", "pattern", "url"],
  },
  "delegation.started": {
    schema: "paperclip.delegation.v1",
    idKey: "delegationId",
    name: "delegation",
    summaryKeys: ["action"],
  },
  "delegation.updated": {
    schema: "paperclip.delegation.v1",
    idKey: "delegationId",
    name: "delegation",
    summaryKeys: ["action"],
  },
  "delegation.completed": {
    schema: "paperclip.delegation.v1",
    idKey: "delegationId",
    name: "delegation",
    summaryKeys: ["action"],
  },
  "model.route.changed": {
    schema: "paperclip.model.route_changed.v1",
    idKey: "routeId",
    name: "model",
    summaryKeys: ["reason", "effectiveModel"],
  },
  "model.verification.updated": {
    schema: "paperclip.model.verification.v1",
    idKey: "verificationId",
    name: "model",
    summaryKeys: ["summary"],
  },
  "context.compacted": {
    schema: "paperclip.context.compacted.v1",
    idKey: "compactionId",
    name: "context",
    summaryKeys: ["reason"],
  },
  "artifact.viewed": {
    schema: "paperclip.artifact.viewed.v1",
    idKey: "artifactId",
    name: "artifact",
    summaryKeys: ["title", "reference"],
  },
  "artifact.generated": {
    schema: "paperclip.artifact.generated.v1",
    idKey: "artifactId",
    name: "artifact",
    summaryKeys: ["failure", "reference"],
  },
  "review.mode.changed": {
    schema: "paperclip.review.mode_changed.v1",
    idKey: "reviewId",
    name: "review",
    summaryKeys: ["scope", "state"],
  },
  "hook.started": {
    schema: "paperclip.hook.v1",
    idKey: "hookId",
    name: "hook",
    summaryKeys: ["summary", "event"],
  },
  "hook.completed": {
    schema: "paperclip.hook.v1",
    idKey: "hookId",
    name: "hook",
    summaryKeys: ["summary", "event"],
  },
  "memory.citation.referenced": {
    schema: "paperclip.memory.citation.v1",
    idKey: "citationId",
    name: "memory",
    summaryKeys: ["label"],
  },
  "safety.review.started": {
    schema: "paperclip.safety.review.v1",
    idKey: "reviewId",
    name: "safety",
    summaryKeys: ["summary", "decision"],
  },
  "safety.review.completed": {
    schema: "paperclip.safety.review.v1",
    idKey: "reviewId",
    name: "safety",
    summaryKeys: ["summary", "decision"],
  },
  "terminal.input.sent": {
    schema: "paperclip.terminal.input_sent.v1",
    idKey: "executionId",
    name: "terminal",
    summaryKeys: ["inputClass"],
  },
  "wait.started": {
    schema: "paperclip.wait.v1",
    idKey: "waitId",
    name: "wait",
    summaryKeys: ["reason"],
  },
  "wait.completed": {
    schema: "paperclip.wait.v1",
    idKey: "waitId",
    name: "wait",
    summaryKeys: ["reason"],
  },
  "provider.notice.recorded": {
    schema: "paperclip.provider.notice.v1",
    idKey: "noticeId",
    name: "Provider notice",
    summaryKeys: ["summary"],
  },
} as const;

type ProviderActivityEventType = keyof typeof PROVIDER_ACTIVITY_PRESENTATIONS;

const NONTERMINAL_PROVIDER_ACTIVITY_STATUSES = new Set([
  "running",
  "pending",
  "in_progress",
  "waiting",
]);

const TERMINAL_PROVIDER_ACTIVITY_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "closed",
  "denied",
]);

function providerActivityPresentation(
  event: HeartbeatRunEvent,
  payload: Record<string, unknown>,
): { id: string; name: string; summary: string; terminal: boolean; failed: boolean } | null {
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_ACTIVITY_PRESENTATIONS, event.eventType)) {
    return null;
  }
  const presentation = PROVIDER_ACTIVITY_PRESENTATIONS[
    event.eventType as ProviderActivityEventType
  ];
  if (!presentation || payload.schema !== presentation.schema) return null;
  const identity = text(payload[presentation.idKey]);
  if (!identity) return null;
  const summary = presentation.summaryKeys
    .map((key) => text(payload[key]))
    .find((value): value is string => value !== null)
    ?? event.eventType;
  const status = text(payload.status);
  const failed = status === "failed" || status === "denied" || payload.severity === "error";
  const terminal = failed
    ? true
    : NONTERMINAL_PROVIDER_ACTIVITY_STATUSES.has(status ?? "")
      ? false
      : TERMINAL_PROVIDER_ACTIVITY_STATUSES.has(status ?? "")
      || event.eventType.endsWith(".completed")
      || event.eventType.endsWith(".failed")
      || (!event.eventType.endsWith(".started") && !event.eventType.endsWith(".progressed"));
  return {
    id: `${event.eventType.split(".")[0]}:${identity}`,
    name: presentation.name,
    summary,
    terminal,
    failed,
  };
}

function timestamp(event: HeartbeatRunEvent, envelope: Record<string, unknown>): string {
  const emittedAt = text(envelope.emittedAt);
  if (emittedAt) return emittedAt;
  const createdAt = event.createdAt instanceof Date ? event.createdAt.toISOString() : String(event.createdAt);
  return Number.isNaN(Date.parse(createdAt)) ? new Date(0).toISOString() : createdAt;
}

interface NativeToolItemDetails {
  name: string | null;
  input?: unknown;
  result?: unknown;
  isError: boolean;
}

function nativeToolItemDetails(
  payload: Record<string, unknown>,
): {
  id: string | null;
  kind: "tooluse" | "toolresult";
  details: NativeToolItemDetails;
} | null {
  const item = normalizedItem(payload);
  const kind = (text(item.type) ?? "").replaceAll("_", "").toLowerCase();
  if (kind !== "tooluse" && kind !== "toolresult") return null;
  const id = kind === "toolresult"
    ? text(item.tool_use_id) ?? text(item.id)
    : text(item.id);
  return {
    id,
    kind,
    details: {
      name: text(item.name),
      ...(Object.prototype.hasOwnProperty.call(item, "input")
        ? { input: item.input }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(item, "result")
        ? { result: item.result }
        : {}),
      isError: item.isError === true || item.is_error === true,
    },
  };
}

function serializedNativeToolResult(item: NativeToolItemDetails): string {
  if (item.result === undefined) return "";
  try {
    return JSON.stringify(item.result) ?? "";
  } catch {
    return "Tool result could not be serialized";
  }
}

function toolPresentation(
  payload: Record<string, unknown>,
  item?: NativeToolItemDetails,
): { name: string; input: unknown } {
  const transport = text(payload.transport);
  const operation = text(payload.operation);
  const reportedName = text(payload.name) ?? item?.name ?? null;
  if (transport === "process") {
    return {
      name: "Bash",
      input: reportedName ? { command: reportedName } : { operation: operation ?? "execute" },
    };
  }
  return {
    name: reportedName ?? operation ?? "Tool",
    input: item?.input ?? {
      ...(operation ? { operation } : {}),
      ...(text(payload.namespace) ? { namespace: text(payload.namespace) } : {}),
      ...(text(payload.target) ? { target: text(payload.target) } : {}),
    },
  };
}

/**
 * Project persisted, provider-neutral PRP events into the legacy transcript
 * model already consumed by the task thread. Provider-native envelopes never
 * reach this boundary and unknown event kinds remain safely invisible.
 */
export function nativeRunEventsToTranscript(events: readonly HeartbeatRunEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const startedToolIds = new Set<string>();
  const completedToolIds = new Set<string>();
  let hasFinalAssistantMessage = false;
  let usageSummary: {
    ts: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
  } | null = null;
  let cumulativeUsageSummary: {
    ts: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
  } | null = null;
  let runResultFallback: { ts: string; text: string } | null = null;
  const seenSourceEventIds = new Set<string>();
  const orderedEvents = [...events]
    .sort((a, b) => a.seq - b.seq)
    .filter((event) => {
      const envelope = record(event.payload?.prpEvent);
      const sourceEventId = text(envelope?.sourceEventId);
      if (!sourceEventId) return true;
      if (seenSourceEventIds.has(sourceEventId)) return false;
      seenSourceEventIds.add(sourceEventId);
      return true;
    });
  const hasAcceptedResult = orderedEvents.some(
    (event) => event.eventType === "run.result.accepted",
  );
  const runtimeRequests = new Map<
    string,
    Extract<TranscriptEntry, { kind: "runtime_request" }>
  >();
  let hasRunResult = false;
  const completedAgentMessageIds = new Set<string>();
  const completedReasoningIds = new Set<string>();
  const completionItemIdentityById = new Map<string, ItemIdentity>();
  const nativeToolItemsById = new Map<string, NativeToolItemDetails>();
  for (const event of orderedEvents) {
    if (!isItemIdentityEvent(event.eventType)) continue;
    const envelope = record(event.payload?.prpEvent);
    if (
      !envelope
      || envelope.schema !== "paperclip.prp.event.v1"
      || envelope.schemaVersion !== 1
      || envelope.runId !== event.runId
      || envelope.eventType !== event.eventType
    ) continue;
    const payload = record(envelope?.payload);
    if (!payload) continue;
    const itemId = normalizedItemId(envelope, payload);
    if (!itemId) continue;
    const toolItem = nativeToolItemDetails(payload);
    if (toolItem) {
      const toolId = toolItem.id ?? itemId;
      const previous = nativeToolItemsById.get(toolId);
      nativeToolItemsById.set(toolId, {
        name: toolItem.details.name ?? previous?.name ?? null,
        ...(toolItem.details.input !== undefined
          ? { input: toolItem.details.input }
          : previous?.input !== undefined
            ? { input: previous.input }
            : {}),
        ...(toolItem.details.result !== undefined
          ? { result: toolItem.details.result }
          : previous?.result !== undefined
            ? { result: previous.result }
            : {}),
        isError: toolItem.details.isError || previous?.isError === true,
      });
    }
    const identity = resolveItemIdentity(
      payload,
      completionItemIdentityById.get(itemId),
    );
    if (identity.kind) completionItemIdentityById.set(itemId, identity);
    if (event.eventType !== "item.completed") continue;
    const kind = identity.kind;
    if (isAssistantItemKind(kind) && itemId && normalizedItemText(payload)) {
      completedAgentMessageIds.add(itemId);
    }
    if (kind === "reasoning" && itemId && normalizedItemText(payload)) {
      completedReasoningIds.add(itemId);
    }
  }

  const itemIdentityById = new Map<string, ItemIdentity>();
  for (const event of orderedEvents) {
    const envelope = record(event.payload?.prpEvent);
    if (
      !envelope
      || envelope.schema !== "paperclip.prp.event.v1"
      || envelope.schemaVersion !== 1
    ) continue;
    if (envelope.runId !== event.runId || envelope.eventType !== event.eventType) continue;
    const payload = record(envelope.payload);
    if (!payload) continue;
    const ts = timestamp(event, envelope);

    const itemId = normalizedItemId(envelope, payload);
    const itemIdentity = resolveItemIdentity(
      payload,
      itemId ? itemIdentityById.get(itemId) : undefined,
    );
    if (itemId && itemIdentity.kind && isItemIdentityEvent(event.eventType)) {
      itemIdentityById.set(itemId, itemIdentity);
    }
    const itemKind = itemIdentity.kind;

    if (event.eventType === "item.delta" && isAssistantItemKind(itemKind)) {
      const value = normalizedItemText(payload);
      if (!value || !itemId) continue;
      // Once the loss-resistant completion is present, prefer its full text.
      // Before that point the deltas still provide the live streaming view.
      if (completedAgentMessageIds.has(itemId)) continue;
      const channel = itemIdentity.assistantChannel;
      if (channel !== "progress") hasFinalAssistantMessage = true;
      entries.push({ kind: "assistant", ts, text: value, delta: true, channel, itemId });
      continue;
    }

    if (event.eventType === "item.completed" && isAssistantItemKind(itemKind)) {
      const value = normalizedItemText(payload);
      if (!value) continue;
      const channel = itemIdentity.assistantChannel;
      if (channel !== "progress") hasFinalAssistantMessage = true;
      entries.push({ kind: "assistant", ts, text: value, channel, ...(itemId ? { itemId } : {}) });
      continue;
    }

    if (event.eventType === "item.delta" && itemKind === "reasoning") {
      const value = normalizedItemText(payload);
      if (!value || !itemId || completedReasoningIds.has(itemId)) continue;
      entries.push({
        kind: "thinking",
        ts,
        text: value,
        delta: true,
        lifecycle: "started",
        channel: itemIdentity.reasoningChannel,
        itemId,
      });
      continue;
    }

    if (event.eventType === "item.completed" && itemKind === "reasoning") {
      const value = normalizedItemText(payload);
      if (!value) continue;
      entries.push({
        kind: "thinking",
        ts,
        text: value,
        lifecycle: "completed",
        channel: itemIdentity.reasoningChannel,
        ...(itemId ? { itemId } : {}),
      });
      continue;
    }

    // Some provider transports expose their complete dynamic-tool lifecycle
    // directly as item.started/item.completed events and do not emit the
    // parallel tool.execution.* activity stream. Project those canonical
    // tool items at their own stable item boundary so saved documents can be
    // embedded beside the write that created them instead of falling back to
    // the end of the run timeline.
    const nativeToolEvent = isItemIdentityEvent(event.eventType)
      ? nativeToolItemDetails(payload)
      : null;
    if (nativeToolEvent) {
      const toolId = nativeToolEvent.id ?? itemId;
      if (!toolId) continue;
      const nativeToolItem = nativeToolItemsById.get(toolId)
        ?? nativeToolEvent.details;
      const presentation = toolPresentation({}, nativeToolItem);
      if (!startedToolIds.has(toolId)) {
        startedToolIds.add(toolId);
        entries.push({
          kind: "tool_call",
          ts,
          name: presentation.name,
          input: presentation.input,
          toolUseId: toolId,
        });
      }
      if (
        event.eventType === "item.completed"
        && (nativeToolEvent.kind === "toolresult"
          || nativeToolEvent.details.result !== undefined)
        && !completedToolIds.has(toolId)
      ) {
        completedToolIds.add(toolId);
        entries.push({
          kind: "tool_result",
          ts,
          toolUseId: toolId,
          toolName: presentation.name,
          content: serializedNativeToolResult(nativeToolItem),
          isError: nativeToolItem.isError,
        });
      }
      continue;
    }

    const providerActivity = providerActivityPresentation(event, payload);
    if (providerActivity) {
      if (!startedToolIds.has(providerActivity.id)) {
        startedToolIds.add(providerActivity.id);
        entries.push({
          kind: "tool_call",
          ts,
          name: providerActivity.name,
          toolUseId: providerActivity.id,
          input: { eventType: event.eventType, summary: providerActivity.summary },
        });
      }
      if (providerActivity.terminal) {
        entries.push({
          kind: "tool_result",
          ts,
          toolUseId: providerActivity.id,
          toolName: providerActivity.name,
          content: providerActivity.summary,
          isError: providerActivity.failed,
        });
      }
      continue;
    }

    if (event.eventType === "tool.execution.started" || event.eventType === "tool.execution.completed") {
      if (payload.schema !== TOOL_EXECUTION_SCHEMA) continue;
      const executionId = text(payload.executionId);
      if (!executionId) continue;
      const nativeToolItem = nativeToolItemsById.get(executionId);
      const presentation = toolPresentation(payload, nativeToolItem);
      if (!startedToolIds.has(executionId)) {
        startedToolIds.add(executionId);
        entries.push({
          kind: "tool_call",
          ts,
          name: presentation.name,
          input: presentation.input,
          toolUseId: executionId,
        });
      }
      if (event.eventType === "tool.execution.completed" && !completedToolIds.has(executionId)) {
        completedToolIds.add(executionId);
        const output = text(payload.output);
        const content = output ?? (nativeToolItem
          ? serializedNativeToolResult(nativeToolItem)
          : "");
        entries.push({
          kind: "tool_result",
          ts,
          toolUseId: executionId,
          toolName: presentation.name,
          content,
          isError: payload.status === "failed" || nativeToolItem?.isError === true,
        });
      }
      continue;
    }

    if (event.eventType === "usage.reported") {
      // A provider may report only session-cumulative usage. Preserve the
      // latest snapshot as explicitly session-scoped usage instead of either
      // summing cumulative values or relabelling them as a per-run delta.
      if (payload.runDeltaAvailable !== true) {
        const cumulative = record(payload.cumulative);
        if (cumulative) {
          cumulativeUsageSummary = {
            ts,
            inputTokens: finiteNumber(cumulative.inputTokens),
            outputTokens: finiteNumber(cumulative.outputTokens),
            cachedTokens: finiteNumber(cumulative.cacheReadTokens),
            costUsd: finiteNumber(cumulative.providerCostUsd),
          };
        }
        continue;
      }
      const measurement = record(payload.runDelta);
      if (!measurement) continue;
      const next = {
        ts,
        inputTokens: finiteNumber(measurement.inputTokens),
        outputTokens: finiteNumber(measurement.outputTokens),
        cachedTokens: finiteNumber(measurement.cacheReadTokens),
        costUsd: finiteNumber(measurement.providerCostUsd),
      };
      // Provider cumulative values are session-scoped and can include earlier
      // runs. Fold only the event's run delta into this run's transcript.
      usageSummary = usageSummary
        ? {
            ts,
            inputTokens: usageSummary.inputTokens + next.inputTokens,
            outputTokens: usageSummary.outputTokens + next.outputTokens,
            cachedTokens: usageSummary.cachedTokens + next.cachedTokens,
            costUsd: usageSummary.costUsd + next.costUsd,
          }
        : next;
      continue;
    }

    if (event.eventType.startsWith("runtime_request.")) {
      const requestId = text((record(payload.request) ?? payload).requestId)
        ?? text(payload.requestId);
      const entry = runtimeRequestEntry({
        eventType: event.eventType,
        envelope,
        payload,
        ts,
        ...(requestId ? { previous: runtimeRequests.get(requestId) } : {}),
      });
      if (entry) {
        runtimeRequests.set(entry.requestId, entry);
        entries.push(entry);
      }
      continue;
    }

    if (event.eventType === "run.terminal") {
      const terminal = runTerminalEntry(payload, ts);
      if (terminal) entries.push(terminal);
      continue;
    }

    if (
      (event.eventType === "run.result.proposed" || event.eventType === "run.result.accepted")
    ) {
      if (event.eventType === "run.result.proposed" && hasAcceptedResult) continue;
      const result = event.eventType === "run.result.accepted" ? record(payload.result) : payload;
      if (!result || result.schema !== RUN_RESULT_SCHEMA) continue;
      if (!hasRunResult) {
        entries.push(runResultEntry(result, ts));
        hasRunResult = true;
      }
      const summary = text(result.summary);
      if (!hasFinalAssistantMessage && summary && !runResultFallback) {
        runResultFallback = { ts, text: summary };
      }
      continue;
    }

  }

  // A structured result can be proposed before its originating final item is
  // durably completed. Delay the fallback until every event has been examined
  // so the explicit assistant reply wins regardless of source ordering.
  if (!hasFinalAssistantMessage && runResultFallback) {
    entries.push({
      kind: "assistant",
      ts: runResultFallback.ts,
      text: runResultFallback.text,
      channel: "final",
    });
  }

  if (usageSummary) {
    entries.push({
      kind: "result",
      ...usageSummary,
      text: "",
      subtype: "paperclip_runner_usage",
      isError: false,
      errors: [],
    });
  } else if (cumulativeUsageSummary) {
    entries.push({
      kind: "result",
      ...cumulativeUsageSummary,
      text: "Provider-reported session-cumulative usage; a per-run delta was unavailable.",
      subtype: "paperclip_runner_session_usage",
      isError: false,
      errors: [],
    });
  }

  return entries;
}
