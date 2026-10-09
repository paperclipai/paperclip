import { createHash } from "node:crypto";

export const COPILOT_ACP_EVENT_METHOD = "github.com/copilot/sessionEvent" as const;

/** Explicit subscription: do not request reasoning, prompts, hooks, or raw tools twice. */
export const COPILOT_ACP_EVENT_TYPES = Object.freeze([
  "session.idle", "session.background_tasks_changed", "session.completion_receipt",
  "session.plan_changed", "session.workspace_file_changed", "session.binary_asset",
  "subagent.started", "subagent.configured", "subagent.completed", "subagent.failed",
  "assistant.usage", "session.usage_info", "session.usage_checkpoint",
  "session.compaction_start", "session.compaction_complete", "pending_messages.modified",
  "session.context_changed", "session.permissions_changed", "session.mode_changed",
  "user_input.requested", "exit_plan_mode.requested", "elicitation.requested",
] as const);

export const COPILOT_ACP_CLIENT_CAPABILITIES = Object.freeze({
  _meta: Object.freeze({
    "github.com/copilot": Object.freeze({ events: COPILOT_ACP_EVENT_TYPES }),
  }),
});

export interface CopilotSessionEvent {
  kind: "activity" | "usage" | "artifact_reference" | "capability_gap";
  sourceMethod: typeof COPILOT_ACP_EVENT_METHOD;
  sourceType: string;
  sessionId: string;
  /** The pinned passthrough does not identify the originating prompt. */
  turnId: null;
  agentId?: string;
  timestamp?: string;
  data: Record<string, unknown>;
}

const eventTypes = new Set<string>(COPILOT_ACP_EVENT_TYPES);
const MAX_EVENT_BYTES = 40 * 1024;
const MAX_TEXT_LENGTH = 4096;

/**
 * Provider notices remain evidence, never authority to read a path, respond to
 * native requests, change permissions, or finalize a turn. Raw passthrough has
 * neither delivery guarantees nor an event ID and is not an accounting ledger.
 */
export function normalizeCopilotSessionEvent(
  notification: unknown,
  binding: { sessionId: string; turnId: string },
): CopilotSessionEvent | null {
  const envelope = record(notification);
  if (envelope.method !== COPILOT_ACP_EVENT_METHOD || !binding.sessionId || !binding.turnId) return null;
  const params = record(envelope.params);
  if (params.sessionId !== binding.sessionId || typeof params.type !== "string" || !eventTypes.has(params.type)) return null;
  // This runs after JSON framing, but remains safe against fabricated test/port values.
  try { if (Buffer.byteLength(JSON.stringify(params)) > MAX_EVENT_BYTES) return null; } catch { return null; }
  const result: CopilotSessionEvent = {
    kind: "activity", sourceMethod: COPILOT_ACP_EVENT_METHOD, sourceType: params.type,
    sessionId: binding.sessionId, turnId: null, data: {},
  };
  if (validText(params.agentId, 256)) result.agentId = params.agentId;
  if (validText(params.timestamp, 128) && Number.isFinite(Date.parse(params.timestamp))) result.timestamp = params.timestamp;
  if (params.dataOmitted !== undefined) {
    result.kind = "capability_gap";
    result.data = { reason: "provider_omitted_event_data", omission: params.dataOmitted === "too-large" ? "too-large" : "unserializable" };
    return result;
  }
  const data = record(params.data);
  switch (params.type) {
    case "session.workspace_file_changed": {
      if (!safeRelativePath(data.path) || !["create", "update"].includes(String(data.operation))) return null;
      result.kind = "artifact_reference";
      result.data = { path: data.path, operation: data.operation, locationKind: "provider_session_workspace", requiresArtifactResolution: true };
      break;
    }
    case "session.binary_asset": {
      if (!validText(data.assetId, 128) || !/^sha256:[a-f0-9]{64}$/.test(data.assetId)
        || !validText(data.mimeType, 256) || !["image", "resource"].includes(String(data.type))
        || !integer(data.byteLength) || typeof data.data !== "string"
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.data)) return null;
      const bytes = Buffer.from(data.data, "base64");
      if (bytes.length !== data.byteLength || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== data.assetId) return null;
      result.kind = "artifact_reference";
      result.data = { assetId: data.assetId, assetType: data.type, mimeType: data.mimeType, byteLength: data.byteLength, requiresArtifactResolution: true };
      copyText(data, result.data, ["description"]);
      break;
    }
    case "assistant.usage":
      result.kind = "usage";
      copyText(data, result.data, ["model", "reasoningEffort", "initiator", "interactionType", "apiCallId", "parentToolCallId", "transport", "apiEndpoint", "finishReason"]);
      copyNumbers(data, result.data, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "duration", "maxPromptTokens", "maxOutputTokens", "acceptedPredictionTokens", "rejectedPredictionTokens", "availableToolCount", "numToolCalls", "toolTokenCount", "cacheTtlSeconds", "timeToFirstTokenMs", "interTokenLatencyMs", "outputTtftMs", "thinkingDroppedBlocks"]);
      copyBooleans(data, result.data, ["isByok", "isAuto", "cacheDetailsReported", "contentFilterTriggered"]);
      if (nonnegativeNumber(data.cost)) result.data.modelMultiplier = data.cost; // Not USD.
      if (nonnegativeNumber(record(data.copilotUsage).totalNanoAiu)) result.data.totalNanoAiu = record(data.copilotUsage).totalNanoAiu;
      result.data.accounting = "supplemental_provider_notice";
      break;
    case "session.usage_info":
      result.kind = "usage";
      copyNumbers(data, result.data, ["tokenLimit", "currentTokens", "messagesLength", "systemTokens", "conversationTokens", "toolDefinitionsTokens"]);
      copyBooleans(data, result.data, ["isInitial"]);
      break;
    case "session.usage_checkpoint":
      result.kind = "usage";
      if (nonnegativeNumber(data.totalNanoAiu)) result.data.totalNanoAiu = data.totalNanoAiu;
      result.data.accounting = "session_cumulative_nano_ai_units";
      break;
    case "subagent.started": case "subagent.configured": case "subagent.completed": case "subagent.failed":
      copyText(data, result.data, ["toolCallId", "agentName", "agentDisplayName", "agentDescription", "model", "parentId", "agentType", "executionMode", "reasoningEffort", "contextTier", "firstDispatchedModel", "configuredModelPreference", "explicitModelOverride", "modelOverrideReason", "modelSelectionSource", "taskModelSource", "factoryRunId", "error"]);
      copyNumbers(data, result.data, ["totalToolCalls", "totalTokens", "durationMs"]);
      copyBooleans(data, result.data, ["cancelled", "resumable", "multiTurn", "explicitModelMatchesPreference", "configuredModelMatchesActual"]);
      break;
    case "session.completion_receipt":
      copyNumbers(data, result.data, ["schemaVersion", "attempt", "successfulToolCount", "failedToolCount"]);
      copyText(data, result.data, ["sourceEventId", "stopReason"]);
      result.data.eventRange = {};
      copyText(record(data.eventRange), result.data.eventRange as Record<string, unknown>, ["startEventId", "endEventId"]);
      result.data.authoritativeTurnCompletion = false;
      break;
    case "session.idle":
      copyBooleans(data, result.data, ["aborted"]);
      copyText(data, result.data, ["mode"]);
      result.data.authoritativeTurnCompletion = false;
      break;
    case "session.plan_changed":
      copyText(data, result.data, ["operation"]);
      result.data.planContentAvailable = false;
      break;
    case "user_input.requested": case "exit_plan_mode.requested": case "elicitation.requested":
      // ACP 1.0.88's passthrough is notification-only; it cannot acknowledge these
      // native callback requests. Never pretend that a UI answer was delivered.
      result.kind = "capability_gap";
      result.data = { reason: "native_request_has_no_qualified_acp_responder" };
      copyText(data, result.data, ["requestId", "toolCallId"]);
      break;
    case "session.mode_changed": copyText(data, result.data, ["previousMode", "newMode"]); break;
    case "session.permissions_changed":
      copyText(data, result.data, ["previousMode", "mode", "assistedApprovalModel"]);
      result.data.policyChangeAllowed = false;
      break;
    case "session.compaction_start": case "session.compaction_complete":
      copyText(data, result.data, ["trigger", "model", "behaviorModelId", "error"]);
      copyNumbers(data, result.data, ["checkpointNumber", "compactionTokensUsed", "conversationTokens", "currentTokens", "messagesRemoved", "postCompactionTokens", "preCompactionMessagesLength", "preCompactionTokens", "systemTokens", "tokenLimit", "tokensRemoved", "toolDefinitionsTokens", "statusCode"]);
      copyBooleans(data, result.data, ["success"]);
      break;
    case "session.context_changed":
      // cwd is a report, not authority to rebind the admitted workspace.
      copyText(data, result.data, ["cwd", "branch", "baseCommit", "headCommit", "hostType"]);
      result.data.workspaceRebindAllowed = false;
      break;
    default:
      // Empty lifecycle notices are useful; private native payloads are not copied.
      result.data = { refreshAvailable: false };
  }
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function validText(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function nonnegativeNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function safeRelativePath(value: unknown): value is string {
  return validText(value) && !/[\\\u0000-\u001f]/.test(value) && !/^(?:\/|[A-Za-z]:|[A-Za-z][A-Za-z0-9+.-]*:)/.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function copyText(source: Record<string, unknown>, target: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) if (validText(source[field])) target[field] = source[field];
}
function copyNumbers(source: Record<string, unknown>, target: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) if (nonnegativeNumber(source[field])) target[field] = source[field];
}
function copyBooleans(source: Record<string, unknown>, target: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) if (typeof source[field] === "boolean") target[field] = source[field];
}
