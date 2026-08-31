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
  let hasAssistantMessage = false;
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
  const orderedEvents = [...events].sort((a, b) => a.seq - b.seq);
  const completedAgentMessageIds = new Set<string>();
  for (const event of orderedEvents) {
    if (event.eventType !== "item.completed") continue;
    const envelope = record(event.payload?.prpEvent);
    if (
      !envelope
      || envelope.schema !== "paperclip.prp.event.v1"
      || envelope.runId !== event.runId
      || envelope.eventType !== event.eventType
    ) continue;
    const payload = record(envelope?.payload);
    const itemId = text(payload?.itemId);
    if (payload?.kind === "agentMessage" && itemId && text(payload.text)) {
      completedAgentMessageIds.add(itemId);
    }
  }

  for (const event of orderedEvents) {
    const envelope = record(event.payload?.prpEvent);
    if (!envelope || envelope.schema !== "paperclip.prp.event.v1") continue;
    if (envelope.runId !== event.runId || envelope.eventType !== event.eventType) continue;
    const payload = record(envelope.payload);
    if (!payload) continue;
    const ts = timestamp(event, envelope);

    if (event.eventType === "item.delta" && payload.kind === "agentMessage") {
      const value = text(payload.text);
      const itemId = text(payload.itemId);
      if (!value || !itemId) continue;
      // Once the loss-resistant completion is present, prefer its full text.
      // Before that point the deltas still provide the live streaming view.
      if (completedAgentMessageIds.has(itemId)) continue;
      hasAssistantMessage = true;
      entries.push({ kind: "assistant", ts, text: value, delta: true });
      continue;
    }

    if (event.eventType === "item.completed" && payload.kind === "agentMessage") {
      const value = text(payload.text);
      if (!value) continue;
      hasAssistantMessage = true;
      entries.push({ kind: "assistant", ts, text: value });
      continue;
    }

    if (event.eventType === "tool.execution.started" || event.eventType === "tool.execution.completed") {
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

    if (event.eventType === "run.result.proposed" && !hasAssistantMessage) {
      const summary = text(payload.summary);
      if (summary) {
        hasAssistantMessage = true;
        entries.push({ kind: "assistant", ts, text: summary });
      }
      continue;
    }

    if (event.eventType === "provider.notice.recorded" && payload.severity === "error") {
      const summary = text(payload.summary);
      if (summary) entries.push({ kind: "stderr", ts, text: summary });
    }
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
