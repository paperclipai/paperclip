import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { asNumber, asString, buildPaperclipEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { createHash } from "node:crypto";
import { parseOpenClawResponse } from "./parse.js";

export type OpenClawTransport = "sse" | "webhook";
export type SessionKeyStrategy = "fixed" | "issue" | "run";
export type OpenClawEndpointKind = "open_responses" | "hook_wake" | "hook_agent" | "generic";

export type WakePayload = {
  runId: string;
  agentId: string;
  companyId: string;
  taskId: string | null;
  issueId: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  approvalId: string | null;
  approvalStatus: string | null;
  issueIds: string[];
};

export type OpenClawExecutionState = {
  method: string;
  timeoutSec: number;
  headers: Record<string, string>;
  payloadTemplate: Record<string, unknown>;
  wakePayload: WakePayload;
  sessionKey: string;
  paperclipEnv: Record<string, string>;
  wakeText: string;
};

const SENSITIVE_LOG_KEY_PATTERN =
  /(^|[_-])(auth|authorization|token|secret|password|api[_-]?key|private[_-]?key)([_-]|$)|^x-openclaw-(auth|token)$/i;

export function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function toAuthorizationHeaderValue(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (!trimmed) return trimmed;
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

export function resolvePaperclipApiUrlOverride(value: unknown): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const normalized = asString(value, "fixed").trim().toLowerCase();
  if (normalized === "issue" || normalized === "run") return normalized;
  return "fixed";
}

export function resolveSessionKey(input: {
  strategy: SessionKeyStrategy;
  configuredSessionKey: string | null;
  runId: string;
  issueId: string | null;
}): string {
  const fallback = input.configuredSessionKey ?? "paperclip";
  if (input.strategy === "run") return `paperclip:run:${input.runId}`;
  if (input.strategy === "issue" && input.issueId) return `paperclip:issue:${input.issueId}`;
  return fallback;
}

function normalizeUrlPath(pathname: string): string {
  const trimmed = pathname.trim().toLowerCase();
  if (!trimmed) return "/";
  return trimmed.endsWith("/") && trimmed !== "/" ? trimmed.slice(0, -1) : trimmed;
}

function isWakePath(pathname: string): boolean {
  const normalized = normalizeUrlPath(pathname);
  return normalized === "/hooks/wake" || normalized.endsWith("/hooks/wake");
}

function isHookAgentPath(pathname: string): boolean {
  const normalized = normalizeUrlPath(pathname);
  return normalized === "/hooks/agent" || normalized.endsWith("/hooks/agent");
}

function isHookPath(pathname: string): boolean {
  const normalized = normalizeUrlPath(pathname);
  return (
    normalized === "/hooks" ||
    normalized.startsWith("/hooks/") ||
    normalized.endsWith("/hooks") ||
    normalized.includes("/hooks/")
  );
}

export function isHookEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isHookPath(parsed.pathname);
  } catch {
    return false;
  }
}

export function isWakeCompatibilityEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isWakePath(parsed.pathname);
  } catch {
    return false;
  }
}

export function isHookAgentEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isHookAgentPath(parsed.pathname);
  } catch {
    return false;
  }
}

export function isOpenResponsesEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = normalizeUrlPath(parsed.pathname);
    return path === "/v1/responses" || path.endsWith("/v1/responses");
  } catch {
    return false;
  }
}

export function resolveEndpointKind(url: string): OpenClawEndpointKind {
  if (isOpenResponsesEndpoint(url)) return "open_responses";
  if (isWakeCompatibilityEndpoint(url)) return "hook_wake";
  if (isHookAgentEndpoint(url)) return "hook_agent";
  return "generic";
}

export function deriveHookAgentUrlFromResponses(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = normalizeUrlPath(parsed.pathname);
    if (path === "/v1/responses") {
      parsed.pathname = "/hooks/agent";
      return parsed.toString();
    }
    if (path.endsWith("/v1/responses")) {
      parsed.pathname = `${path.slice(0, -"/v1/responses".length)}/hooks/agent`;
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export function toStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return out;
}

function isSensitiveLogKey(key: string): boolean {
  return SENSITIVE_LOG_KEY_PATTERN.test(key.trim());
}

function sha256Prefix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function redactSecretForLog(value: string): string {
  return `[redacted len=${value.length} sha256=${sha256Prefix(value)}]`;
}

function truncateForLog(value: string, maxChars = 320): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

export function redactForLog(value: unknown, keyPath: string[] = [], depth = 0): unknown {
  const currentKey = keyPath[keyPath.length - 1] ?? "";
  if (typeof value === "string") {
    if (isSensitiveLogKey(currentKey)) return redactSecretForLog(value);
    return truncateForLog(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 6) return "[array-truncated]";
    const out = value.slice(0, 20).map((entry, index) => redactForLog(entry, [...keyPath, `${index}`], depth + 1));
    if (value.length > 20) out.push(`[+${value.length - 20} more items]`);
    return out;
  }
  if (typeof value === "object") {
    if (depth >= 6) return "[object-truncated]";
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, 80)) {
      out[key] = redactForLog(entry, [...keyPath, key], depth + 1);
    }
    if (entries.length > 80) {
      out.__truncated__ = `+${entries.length - 80} keys`;
    }
    return out;
  }
  return String(value);
}

export function stringifyForLog(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function buildWakePayload(ctx: AdapterExecutionContext): WakePayload {
  const { runId, agent, context } = ctx;
  return {
    runId,
    agentId: agent.id,
    companyId: agent.companyId,
    taskId: nonEmpty(context.taskId) ?? nonEmpty(context.issueId),
    issueId: nonEmpty(context.issueId),
    wakeReason: nonEmpty(context.wakeReason),
    wakeCommentId: nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId),
    approvalId: nonEmpty(context.approvalId),
    approvalStatus: nonEmpty(context.approvalStatus),
    issueIds: Array.isArray(context.issueIds)
      ? context.issueIds.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [],
  };
}

export function buildPaperclipEnvForWake(ctx: AdapterExecutionContext, wakePayload: WakePayload): Record<string, string> {
  const paperclipApiUrlOverride = resolvePaperclipApiUrlOverride(ctx.config.paperclipApiUrl);
  const paperclipEnv: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent),
    PAPERCLIP_RUN_ID: ctx.runId,
  };

  if (paperclipApiUrlOverride) {
    paperclipEnv.PAPERCLIP_API_URL = paperclipApiUrlOverride;
  }
  if (wakePayload.taskId) paperclipEnv.PAPERCLIP_TASK_ID = wakePayload.taskId;
  if (wakePayload.wakeReason) paperclipEnv.PAPERCLIP_WAKE_REASON = wakePayload.wakeReason;
  if (wakePayload.wakeCommentId) paperclipEnv.PAPERCLIP_WAKE_COMMENT_ID = wakePayload.wakeCommentId;
  if (wakePayload.approvalId) paperclipEnv.PAPERCLIP_APPROVAL_ID = wakePayload.approvalId;
  if (wakePayload.approvalStatus) paperclipEnv.PAPERCLIP_APPROVAL_STATUS = wakePayload.approvalStatus;
  if (wakePayload.issueIds.length > 0) {
    paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = wakePayload.issueIds.join(",");
  }

  return paperclipEnv;
}

export function buildWakeText(payload: WakePayload, paperclipEnv: Record<string, string>): string {
  const claimedApiKeyPath = "~/.openclaw/workspace/paperclip-claimed-api-key.json";
  const orderedKeys = [
    "PAPERCLIP_RUN_ID",
    "PAPERCLIP_AGENT_ID",
    "PAPERCLIP_COMPANY_ID",
    "PAPERCLIP_API_URL",
    "PAPERCLIP_TASK_ID",
    "PAPERCLIP_WAKE_REASON",
    "PAPERCLIP_WAKE_COMMENT_ID",
    "PAPERCLIP_APPROVAL_ID",
    "PAPERCLIP_APPROVAL_STATUS",
    "PAPERCLIP_LINKED_ISSUE_IDS",
  ];

  const envLines: string[] = [];
  for (const key of orderedKeys) {
    const value = paperclipEnv[key];
    if (!value) continue;
    envLines.push(`${key}=${value}`);
  }

  const issueIdHint = payload.taskId ?? payload.issueId ?? "";
  const apiBaseHint = paperclipEnv.PAPERCLIP_API_URL ?? "<set PAPERCLIP_API_URL>";

  const lines = [
    "Paperclip wake event for a cloud adapter.",
    "",
    "Run this procedure now. Do not guess undocumented endpoints and do not ask for additional heartbeat docs.",
    "",
    "Set these values in your run context:",
    ...envLines,
    `PAPERCLIP_API_KEY=<token from ${claimedApiKeyPath}>`,
    "",
    `Load PAPERCLIP_API_KEY from ${claimedApiKeyPath} (the token you saved after claim-api-key).`,
    "",
    `api_base=${apiBaseHint}`,
    `task_id=${payload.taskId ?? ""}`,
    `issue_id=${payload.issueId ?? ""}`,
    `wake_reason=${payload.wakeReason ?? ""}`,
    `wake_comment_id=${payload.wakeCommentId ?? ""}`,
    `approval_id=${payload.approvalId ?? ""}`,
    `approval_status=${payload.approvalStatus ?? ""}`,
    `linked_issue_ids=${payload.issueIds.join(",")}`,
    "",
    "HTTP rules:",
    "- Use Authorization: Bearer $PAPERCLIP_API_KEY on every API call.",
    "- Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every mutating API call.",
    "- Use only /api endpoints listed below.",
    "- Do NOT call guessed endpoints like /api/cloud-adapter/*, /api/cloud-adapters/*, /api/adapters/cloud/*, or /api/heartbeat.",
    "",
    "Workflow:",
    "1) GET /api/agents/me",
    `2) Determine issueId: PAPERCLIP_TASK_ID if present, otherwise issue_id (${issueIdHint}).`,
    "3) If issueId exists:",
    "   - POST /api/issues/{issueId}/checkout with {\"agentId\":\"$PAPERCLIP_AGENT_ID\",\"expectedStatuses\":[\"todo\",\"backlog\",\"blocked\"]}",
    "   - GET /api/issues/{issueId}",
    "   - GET /api/issues/{issueId}/comments",
    "   - Execute the issue instructions exactly.",
    "   - If instructions require a comment, POST /api/issues/{issueId}/comments with {\"body\":\"...\"}.",
    "   - PATCH /api/issues/{issueId} with {\"status\":\"done\",\"comment\":\"what changed and why\"}.",
    "4) If issueId does not exist:",
    "   - GET /api/companies/$PAPERCLIP_COMPANY_ID/issues?assigneeAgentId=$PAPERCLIP_AGENT_ID&status=todo,in_progress,blocked",
    "   - Pick in_progress first, then todo, then blocked, then execute step 3.",
    "",
    "Useful endpoints for issue work:",
    "- POST /api/issues/{issueId}/comments",
    "- PATCH /api/issues/{issueId}",
    "- POST /api/companies/{companyId}/issues (when asked to create a new issue)",
    "",
    "Complete the workflow in this run.",
  ];
  return lines.join("\n");
}

export function appendWakeText(baseText: string, wakeText: string): string {
  const trimmedBase = baseText.trim();
  return trimmedBase.length > 0 ? `${trimmedBase}\n\n${wakeText}` : wakeText;
}

function buildOpenResponsesWakeInputMessage(wakeText: string): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: wakeText,
      },
    ],
  };
}

export function appendWakeTextToOpenResponsesInput(input: unknown, wakeText: string): unknown {
  if (typeof input === "string") {
    return appendWakeText(input, wakeText);
  }

  if (Array.isArray(input)) {
    return [...input, buildOpenResponsesWakeInputMessage(wakeText)];
  }

  if (typeof input === "object" && input !== null) {
    const parsed = parseObject(input);
    const content = parsed.content;
    if (typeof content === "string") {
      return {
        ...parsed,
        content: appendWakeText(content, wakeText),
      };
    }
    if (Array.isArray(content)) {
      return {
        ...parsed,
        content: [
          ...content,
          {
            type: "input_text",
            text: wakeText,
          },
        ],
      };
    }
    return [parsed, buildOpenResponsesWakeInputMessage(wakeText)];
  }

  return wakeText;
}

export function isTextRequiredResponse(responseText: string): boolean {
  const parsed = parseOpenClawResponse(responseText);
  const parsedError = parsed && typeof parsed.error === "string" ? parsed.error : null;
  if (parsedError && parsedError.toLowerCase().includes("text required")) {
    return true;
  }
  return responseText.toLowerCase().includes("text required");
}

function extractResponseErrorMessage(responseText: string): string {
  const parsed = parseOpenClawResponse(responseText);
  if (!parsed) return responseText;

  const directError = parsed.error;
  if (typeof directError === "string") return directError;
  if (directError && typeof directError === "object") {
    const nestedMessage = (directError as Record<string, unknown>).message;
    if (typeof nestedMessage === "string") return nestedMessage;
  }

  const directMessage = parsed.message;
  if (typeof directMessage === "string") return directMessage;

  return responseText;
}

export function isWakeCompatibilityRetryableResponse(responseText: string): boolean {
  if (isTextRequiredResponse(responseText)) return true;

  const normalized = extractResponseErrorMessage(responseText).toLowerCase();
  const expectsStringInput =
    normalized.includes("invalid input") &&
    normalized.includes("expected string") &&
    normalized.includes("undefined");
  if (expectsStringInput) return true;

  const missingInputField =
    normalized.includes("input") &&
    (normalized.includes("required") || normalized.includes("missing"));
  if (missingInputField) return true;

  return false;
}

export async function sendJsonRequest(params: {
  url: string;
  method: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<Response> {
  return fetch(params.url, {
    method: params.method,
    headers: params.headers,
    body: JSON.stringify(params.payload),
    signal: params.signal,
  });
}

export async function readAndLogResponseText(params: {
  response: Response;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<string> {
  const responseText = await params.response.text();
  if (responseText.trim().length > 0) {
    await params.onLog(
      "stdout",
      `[openclaw] response (${params.response.status}) ${responseText.slice(0, 2000)}\n`,
    );
  } else {
    await params.onLog("stdout", `[openclaw] response (${params.response.status}) <empty>\n`);
  }
  return responseText;
}

export function buildExecutionState(ctx: AdapterExecutionContext): OpenClawExecutionState {
  const method = asString(ctx.config.method, "POST").trim().toUpperCase() || "POST";
  const timeoutSecRaw = asNumber(ctx.config.timeoutSec, 0);
  const timeoutSec = timeoutSecRaw > 0 ? Math.max(1, Math.floor(timeoutSecRaw)) : 0;
  const headersConfig = parseObject(ctx.config.headers) as Record<string, unknown>;
  const payloadTemplate = parseObject(ctx.config.payloadTemplate);
  const webhookAuthHeader = nonEmpty(ctx.config.webhookAuthHeader);
  const sessionKeyStrategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  for (const [key, value] of Object.entries(headersConfig)) {
    if (typeof value === "string" && value.trim().length > 0) {
      headers[key] = value;
    }
  }

  const openClawAuthHeader = nonEmpty(
    headers["x-openclaw-token"] ??
      headers["X-OpenClaw-Token"] ??
      headers["x-openclaw-auth"] ??
      headers["X-OpenClaw-Auth"],
  );
  if (openClawAuthHeader && !headers.authorization && !headers.Authorization) {
    headers.authorization = toAuthorizationHeaderValue(openClawAuthHeader);
  }
  if (webhookAuthHeader && !headers.authorization && !headers.Authorization) {
    headers.authorization = webhookAuthHeader;
  }

  const wakePayload = buildWakePayload(ctx);
  const sessionKey = resolveSessionKey({
    strategy: sessionKeyStrategy,
    configuredSessionKey: nonEmpty(ctx.config.sessionKey),
    runId: ctx.runId,
    issueId: wakePayload.issueId ?? wakePayload.taskId,
  });

  const paperclipEnv = buildPaperclipEnvForWake(ctx, wakePayload);
  const wakeText = buildWakeText(wakePayload, paperclipEnv);

  return {
    method,
    timeoutSec,
    headers,
    payloadTemplate,
    wakePayload,
    sessionKey,
    paperclipEnv,
    wakeText,
  };
}

export function buildWakeCompatibilityPayload(wakeText: string): Record<string, unknown> {
  return {
    text: wakeText,
    mode: "now",
  };
}
