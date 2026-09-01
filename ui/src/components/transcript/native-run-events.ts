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

function toolPresentation(payload: Record<string, unknown>): { name: string; input: unknown } {
  const transport = text(payload.transport);
  const operation = text(payload.operation);
  const reportedName = text(payload.name);
  if (transport === "process") {
    return {
      name: "Bash",
      input: reportedName ? { command: reportedName } : { operation: operation ?? "execute" },
    };
  }
  return {
    name: reportedName ?? operation ?? "Tool",
    input: {
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
  const orderedEvents = [...events].sort((a, b) => a.seq - b.seq);
  const completedAgentMessageIds = new Set<string>();
  const completedReasoningIds = new Set<string>();
  const completionItemIdentityById = new Map<string, ItemIdentity>();
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
      entries.push({ kind: "assistant", ts, text: value, delta: true, channel });
      continue;
    }

    if (event.eventType === "item.completed" && isAssistantItemKind(itemKind)) {
      const value = normalizedItemText(payload);
      if (!value) continue;
      const channel = itemIdentity.assistantChannel;
      if (channel !== "progress") hasFinalAssistantMessage = true;
      entries.push({ kind: "assistant", ts, text: value, channel });
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
      });
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
      const presentation = toolPresentation(payload);
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
      if (event.eventType === "tool.execution.completed") {
        entries.push({
          kind: "tool_result",
          ts,
          toolUseId: executionId,
          toolName: presentation.name,
          content: text(payload.output) ?? "",
          isError: payload.status === "failed",
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

    if (
      (event.eventType === "run.result.proposed" || event.eventType === "run.result.accepted")
      && !hasFinalAssistantMessage
    ) {
      const result = event.eventType === "run.result.accepted" ? record(payload.result) : payload;
      if (!result || result.schema !== RUN_RESULT_SCHEMA) continue;
      const summary = text(result.summary);
      if (summary && !runResultFallback) runResultFallback = { ts, text: summary };
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
