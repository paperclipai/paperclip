/**
 * heartbeat-types.ts
 *
 * Shared types, constants, and pure utility functions used across
 * heartbeat modules. No database dependencies.
 */

import { appendWithCap, MAX_EXCERPT_BYTES, asNumber, parseObject } from "../adapters/utils.js";
import type { BillingType } from "@ironworksai/shared";
import type { AdapterExecutionResult, UsageSummary } from "../adapters/index.js";
import type { AdapterSessionCodec } from "../adapters/index.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
export const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
export const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 10;
export const DEFERRED_WAKE_CONTEXT_KEY = "_ironworksWakeContext";
export const DETACHED_PROCESS_ERROR_CODE = "process_detached";
export const REPO_ONLY_CWD_SENTINEL = "/__ironworks_repo_only__";
export const MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
export const HEARTBEAT_TASK_KEY = "__heartbeat__";
export const MAX_TOOL_OUTPUT_CHARS = 2000;

export const COMPLETION_MARKERS = [
  "Task complete",
  "Issue resolved",
  "No further action needed",
] as const;

export const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

// In-flight agent start locks (module-level singleton)
export const startLocksByAgent = new Map<string, Promise<void>>();

// ── Types ──────────────────────────────────────────────────────────────────

export type ContextTier = "minimal" | "standard" | "full";

export type TaskTemplateType =
  | "answer_question"
  | "write_code"
  | "write_report"
  | "review_document"
  | "routine_check";

export const PROMPT_TEMPLATES: Record<
  TaskTemplateType,
  { maxContext: number; includeMemories: number; includeDocuments: number }
> = {
  answer_question: { maxContext: 2000, includeMemories: 3, includeDocuments: 2 },
  write_code: { maxContext: 4000, includeMemories: 5, includeDocuments: 3 },
  write_report: { maxContext: 8000, includeMemories: 10, includeDocuments: 5 },
  review_document: { maxContext: 4000, includeMemories: 5, includeDocuments: 5 },
  routine_check: { maxContext: 500, includeMemories: 0, includeDocuments: 0 },
} as const;

export interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}

export type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type SessionCompactionDecision = {
  rotate: boolean;
  reason: string | null;
  handoffMarkdown: string | null;
  previousRunId: string | null;
};

export interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

export type ProjectWorkspaceCandidate = {
  id: string;
};

// ── Pure utility functions ─────────────────────────────────────────────────

export function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

export function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

export function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeLedgerBillingType(value: unknown): BillingType {
  const raw = readNonEmptyString(value);
  switch (raw) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

export function resolveLedgerBiller(result: AdapterExecutionResult): string {
  return readNonEmptyString(result.biller) ?? readNonEmptyString(result.provider) ?? "unknown";
}

export function normalizeBilledCostCents(
  costUsd: number | null | undefined,
  billingType: BillingType,
): number {
  if (billingType === "subscription_included") return 0;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(costUsd * 100));
}

export function normalizeUsageTotals(usage: UsageSummary | null | undefined): UsageTotals | null {
  if (!usage) return null;
  return {
    inputTokens: Math.max(0, Math.floor(asNumber(usage.inputTokens, 0))),
    cachedInputTokens: Math.max(0, Math.floor(asNumber(usage.cachedInputTokens, 0))),
    outputTokens: Math.max(0, Math.floor(asNumber(usage.outputTokens, 0))),
  };
}

export function readRawUsageTotals(usageJson: unknown): UsageTotals | null {
  const parsed = parseObject(usageJson);
  if (Object.keys(parsed).length === 0) return null;

  const inputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawInputTokens, asNumber(parsed.inputTokens, 0))),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawCachedInputTokens, asNumber(parsed.cachedInputTokens, 0))),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawOutputTokens, asNumber(parsed.outputTokens, 0))),
  );

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return { inputTokens, cachedInputTokens, outputTokens };
}

export function deriveNormalizedUsageDelta(
  current: UsageTotals | null,
  previous: UsageTotals | null,
): UsageTotals | null {
  if (!current) return null;
  if (!previous) return { ...current };

  const inputTokens =
    current.inputTokens >= previous.inputTokens
      ? current.inputTokens - previous.inputTokens
      : current.inputTokens;
  const cachedInputTokens =
    current.cachedInputTokens >= previous.cachedInputTokens
      ? current.cachedInputTokens - previous.cachedInputTokens
      : current.cachedInputTokens;
  const outputTokens =
    current.outputTokens >= previous.outputTokens
      ? current.outputTokens - previous.outputTokens
      : current.outputTokens;

  return {
    inputTokens: Math.max(0, inputTokens),
    cachedInputTokens: Math.max(0, cachedInputTokens),
    outputTokens: Math.max(0, outputTokens),
  };
}

export function formatCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
}

export function formatRuntimeWorkspaceWarningLog(warning: string) {
  return {
    stream: "stdout" as const,
    chunk: `[ironworks] ${warning}\n`,
  };
}

export function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

export function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

export function classifyContextTier(contextSnapshot: Record<string, unknown>): ContextTier {
  const wakeReason =
    typeof contextSnapshot.wakeReason === "string" ? contextSnapshot.wakeReason : null;
  const source =
    typeof contextSnapshot.wakeSource === "string" ? contextSnapshot.wakeSource : null;
  const issueId =
    typeof contextSnapshot.issueId === "string" ? contextSnapshot.issueId : null;
  const commentId =
    typeof contextSnapshot.wakeCommentId === "string" ? contextSnapshot.wakeCommentId : null;
  const approvalId =
    typeof contextSnapshot.approvalId === "string" ? contextSnapshot.approvalId : null;

  if (approvalId || wakeReason === "approval_approved" || wakeReason === "approval_rejected") {
    return "full";
  }
  const issueIds = Array.isArray(contextSnapshot.issueIds) ? contextSnapshot.issueIds : null;
  if (issueIds && issueIds.length > 1) {
    return "full";
  }

  if (commentId || wakeReason === "comment" || wakeReason === "assignment") {
    return "standard";
  }
  if (issueId && source !== "timer") {
    return "standard";
  }

  return "minimal";
}

export function classifyTaskType(issueTitle: string, labelNames: string[]): TaskTemplateType {
  const titleLower = issueTitle.toLowerCase();
  const allText = [titleLower, ...labelNames.map((l) => l.toLowerCase())].join(" ");

  if (
    /\b(bug|fix|implement|refactor|test|code|build|deploy|ci|pr|pull request|feature)\b/.test(allText)
  ) {
    return "write_code";
  }
  if (
    /\b(report|analysis|analyse|analyze|research|audit|review weekly|weekly|summary|findings)\b/.test(
      allText,
    )
  ) {
    return "write_report";
  }
  if (/\b(review|feedback|approve|assess|evaluate)\b/.test(allText)) {
    return "review_document";
  }
  if (/\b(question|answer|how|what|why|explain|clarify)\b/.test(allText)) {
    return "answer_question";
  }
  return "routine_check";
}

export function isTrackedLocalChildProcessAdapter(adapterType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}

export function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

export function isSameTaskScope(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

export function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
) {
  const existing = parseObject(existingRaw);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const commentId = deriveCommentId(incoming, null);
  if (commentId) {
    merged.commentId = commentId;
    merged.wakeCommentId = commentId;
  }
  return merged;
}

export function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  payload: Record<string, unknown> | null;
}) {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const issueIdFromPayload = readNonEmptyString(payload?.["issueId"]);
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentId = deriveCommentId(contextSnapshot, payload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueIdFromPayload) {
    contextSnapshot.issueId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskId"]) && issueIdFromPayload) {
    contextSnapshot.taskId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["commentId"]) && commentIdFromPayload) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["wakeCommentId"]) && wakeCommentId) {
    contextSnapshot.wakeCommentId = wakeCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (!readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) && triggerDetail) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }

  return {
    contextSnapshot,
    issueIdFromPayload,
    commentIdFromPayload,
    taskKey,
    wakeCommentId,
  };
}

export function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

export function deriveTaskKeyWithHeartbeatFallback(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  const explicit = deriveTaskKey(contextSnapshot, payload);
  if (explicit) return explicit;

  const wakeSource = readNonEmptyString(contextSnapshot?.wakeSource);
  if (wakeSource === "timer") return HEARTBEAT_TASK_KEY;

  return null;
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return true;
  return false;
}

export function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return "forceFreshSession was requested";

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";
  return null;
}

export function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

export function parseIssueAssigneeAdapterOverrides(
  raw: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.adapterConfig);
  const adapterConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean" ? parsed.useProjectWorkspace : null;
  if (!adapterConfig && useProjectWorkspace === null) return null;
  return {
    adapterConfig,
    useProjectWorkspace,
  };
}

export function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } =
    input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams = hasExplicitParams
    ? explicitParams
    : hasExplicitSessionId
      ? explicitSessionId
        ? { sessionId: explicitSessionId }
        : null
      : previousParams;

  const serialized = normalizeSessionParams(
    codec.serialize(normalizeSessionParams(candidateParams) ?? null),
  );
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

/**
 * Compress a tool's raw output string to reduce context window consumption.
 */
export function compressToolOutput(toolName: string, output: string): string {
  if (!output || output.length === 0) return output;

  const lowerTool = toolName.toLowerCase();
  let compressed = output;

  if (lowerTool.includes("comment") || lowerTool.includes("issue_comment")) {
    try {
      const parsed = JSON.parse(output) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const stripped = items.map((item: unknown) => {
        if (typeof item !== "object" || item === null) return item;
        const r = item as Record<string, unknown>;
        return {
          author: r.author ?? r.authorName ?? r.user ?? r.login ?? null,
          body: r.body ?? r.content ?? r.text ?? null,
          createdAt: r.createdAt ?? r.created_at ?? r.timestamp ?? null,
        };
      });
      compressed = JSON.stringify(stripped);
    } catch {
      // Not JSON - leave as-is for truncation below
    }
  }

  if (lowerTool.includes("read_file") || lowerTool === "cat" || lowerTool.includes("file_read")) {
    compressed = compressed.slice(0, 1500);
    if (output.length > 1500) {
      compressed += "\n...[file truncated - showing first 1500 chars]";
    }
  }

  if (lowerTool.includes("http") || lowerTool.includes("api_call") || lowerTool.includes("fetch")) {
    try {
      const parsed = JSON.parse(output) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const flat: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
            flat[key] = val;
          }
        }
        compressed = JSON.stringify(flat);
      }
    } catch {
      // Not JSON
    }
  }

  if (compressed.length > MAX_TOOL_OUTPUT_CHARS) {
    compressed = compressed.slice(0, MAX_TOOL_OUTPUT_CHARS) + " [truncated]";
  }

  return compressed;
}

// ── buildExplicitResumeSessionOverride ────────────────────────────────────

type ResumeSessionRow = {
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastRunId: string | null;
};

export function buildExplicitResumeSessionOverride(input: {
  resumeFromRunId: string;
  resumeRunSessionIdBefore: string | null;
  resumeRunSessionIdAfter: string | null;
  taskSession: ResumeSessionRow | null;
  sessionCodec: AdapterSessionCodec;
}) {
  const desiredDisplayId = truncateDisplayId(
    input.resumeRunSessionIdAfter ?? input.resumeRunSessionIdBefore,
  );
  const taskSessionParams = normalizeSessionParams(
    input.sessionCodec.deserialize(input.taskSession?.sessionParamsJson ?? null),
  );
  const taskSessionDisplayId = truncateDisplayId(
    input.taskSession?.sessionDisplayId ??
      (input.sessionCodec.getDisplayId
        ? input.sessionCodec.getDisplayId(taskSessionParams)
        : null) ??
      readNonEmptyString(taskSessionParams?.sessionId),
  );
  const canReuseTaskSessionParams =
    input.taskSession != null &&
    (input.taskSession.lastRunId === input.resumeFromRunId ||
      (!!desiredDisplayId && taskSessionDisplayId === desiredDisplayId));
  const sessionParams = canReuseTaskSessionParams
    ? taskSessionParams
    : desiredDisplayId
      ? { sessionId: desiredDisplayId }
      : null;
  const sessionDisplayId =
    desiredDisplayId ?? (canReuseTaskSessionParams ? taskSessionDisplayId : null);

  if (!sessionDisplayId && !sessionParams) return null;
  return {
    sessionDisplayId,
    sessionParams,
  };
}

// ── Re-export asNumber / parseObject so modules can import from one place ──
export { asNumber, parseObject } from "../adapters/utils.js";
