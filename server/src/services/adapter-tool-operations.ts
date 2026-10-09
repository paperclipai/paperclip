import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { logger } from "../middleware/logger.js";
import type { workspaceOperationService } from "./workspace-operations.js";

type WorkspaceOperationsService = ReturnType<typeof workspaceOperationService>;

/**
 * The terminal outcome of a provider tool call, normalized across the adapter
 * runtime-event shapes that report one (ACP tool-call updates, OpenCode JSONL
 * tool parts, start-only adapters like kimi). `running` means the call was
 * observed starting but has not settled; it stays that way when the provider
 * dies before any terminal update, which is exactly the mid-execution case the
 * recovery gate must be able to see.
 */
export type ObservedToolCallStatus = "running" | "succeeded" | "failed" | "skipped";

export interface ObservedToolCall {
  /** Provider-assigned identity for this call, when the event carries one. */
  toolCallId: string | null;
  /** Tool name or invocation title ("Terminal", "Edit src/a.ts", …). */
  name: string | null;
  status: ObservedToolCallStatus;
}

const TOOL_CALL_EVENT_PATTERN = /(^|\.)tool_call$/;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPayloadObject(event: AdapterRuntimeEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function normalizeObservedStatus(raw: unknown): ObservedToolCallStatus {
  switch (readNonEmptyString(raw)?.toLowerCase()) {
    case "completed":
    case "succeeded":
      return "succeeded";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "skipped";
    // "pending", "in_progress", "running", and any unknown status keep the call open.
    default:
      return "running";
  }
}

/**
 * Map an adapter runtime event to an observed provider tool call, or `null`
 * when the event is not a tool-call report. Recognizes the `.tool_call` family
 * of runtime event types (acpx tool-call updates, kimi tool calls, OpenCode
 * tool parts) and deliberately ignores tool-result events: a result confirms a
 * call finished but never starts one.
 */
export function observedToolCallFromRuntimeEvent(
  event: Pick<AdapterRuntimeEvent, "eventType" | "payload">,
): ObservedToolCall | null {
  const eventType = readNonEmptyString(event.eventType);
  if (!eventType || !TOOL_CALL_EVENT_PATTERN.test(eventType.toLowerCase())) return null;
  const payload = readPayloadObject(event as AdapterRuntimeEvent);
  const toolCallId =
    readNonEmptyString(payload.toolCallId) ??
    readNonEmptyString(payload.callId) ??
    readNonEmptyString(payload.callID) ??
    readNonEmptyString(payload.id) ??
    readNonEmptyString(payload.toolUseId);
  const name =
    readNonEmptyString(payload.name) ??
    readNonEmptyString(payload.tool) ??
    readNonEmptyString(payload.toolName) ??
    readNonEmptyString(payload.tool_name) ??
    readNonEmptyString(payload.title);
  if (!toolCallId && !name) return null;
  return {
    toolCallId,
    name,
    status: normalizeObservedStatus(payload.status),
  };
}

export interface AdapterToolOperationSink {
  (event: Pick<AdapterRuntimeEvent, "eventType" | "payload">): Promise<void>;
}

/**
 * Sink that turns adapter tool-call runtime events into `workspace_operations`
 * rows for the executing run. One call with a tool-call id opens exactly one
 * row and settles it on the first terminal update; calls without an id (the
 * start-only shapes) each record their own row. Failures are logged and
 * swallowed — instrumentation must never break the run it observes.
 *
 * Rows left `running` are intentional: they represent a tool call the server
 * saw begin but never saw finish, so "any recorded operation" stays a reliable
 * signal that the provider may have written to the workspace.
 */
export function createAdapterToolOperationSink(input: {
  workspaceOperations: WorkspaceOperationsService;
  companyId: string;
  heartbeatRunId: string;
  issueId: string | null;
  executionWorkspaceId: string | null | (() => string | null);
  phase?: "provider_tool_execution";
}): AdapterToolOperationSink {
  /** toolCallId -> operation id, while the row is still `running`. */
  const openOperationIds = new Map<string, string>();
  /** Tool-call ids whose row already reached a terminal status. */
  const settledToolCallIds = new Set<string>();
  const resolveExecutionWorkspaceId = () =>
    typeof input.executionWorkspaceId === "function"
      ? input.executionWorkspaceId()
      : input.executionWorkspaceId;
  const baseInput = () => ({
    companyId: input.companyId,
    heartbeatRunId: input.heartbeatRunId,
    issueId: input.issueId,
    executionWorkspaceId: resolveExecutionWorkspaceId(),
    phase: input.phase ?? ("provider_tool_execution" as const),
  });

  return async (event) => {
    const tool = observedToolCallFromRuntimeEvent(event);
    if (!tool) return;
    try {
      if (!tool.toolCallId) {
        // Start-only shapes (e.g. kimi's id-less assistant tool_calls) cannot be
        // deduplicated or settled later; record each observed call as-is.
        await input.workspaceOperations.recordObservedOperation({
          ...baseInput(),
          observedStatus: tool.status,
          metadata: { toolName: tool.name, source: "adapter_runtime_event" },
        });
        return;
      }
      const openId = openOperationIds.get(tool.toolCallId);
      if (settledToolCallIds.has(tool.toolCallId)) {
        // Every later update for a settled call is a duplicate; the recorded
        // terminal state wins.
        return;
      }
      if (tool.status === "running") {
        if (openId) return;
        const id = await input.workspaceOperations.recordObservedOperation({
          ...baseInput(),
          observedStatus: "running",
          metadata: {
            toolName: tool.name,
            toolCallId: tool.toolCallId,
            source: "adapter_runtime_event",
          },
        });
        openOperationIds.set(tool.toolCallId, id);
        return;
      }
      if (openId) {
        await input.workspaceOperations.settleObservedOperation({
          companyId: input.companyId,
          id: openId,
          status: tool.status,
        });
        openOperationIds.delete(tool.toolCallId);
      } else {
        // Terminal update for a call whose start was never observed (late event,
        // provider restart). Record the observed outcome directly.
        await input.workspaceOperations.recordObservedOperation({
          ...baseInput(),
          observedStatus: tool.status,
          metadata: {
            toolName: tool.name,
            toolCallId: tool.toolCallId,
            source: "adapter_runtime_event",
          },
        });
      }
      settledToolCallIds.add(tool.toolCallId);
    } catch (error) {
      logger.warn(
        { err: error, runId: input.heartbeatRunId, toolCallId: tool.toolCallId },
        "failed to record observed provider tool operation; continuing without it",
      );
    }
  };
}
