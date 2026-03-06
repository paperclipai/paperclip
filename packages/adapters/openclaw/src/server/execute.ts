import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asNumber, asString, buildPaperclipEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { parseOpenClawResponse } from "./parse.js";

type SessionKeyStrategy = "fixed" | "issue" | "run";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toAuthorizationHeaderValue(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (!trimmed) return trimmed;
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function resolvePaperclipApiUrlOverride(value: unknown): string | null {
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

function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const normalized = asString(value, "fixed").trim().toLowerCase();
  if (normalized === "issue" || normalized === "run") return normalized;
  return "fixed";
}

function resolveSessionKey(input: {
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

function isWakeCompatibilityEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return path === "/hooks/wake" || path.endsWith("/hooks/wake");
  } catch {
    return false;
  }
}

function isOpenResponsesEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return path === "/v1/responses" || path.endsWith("/v1/responses");
  } catch {
    return false;
  }
}

function toStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return out;
}

type WakePayload = {
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

function buildWakeText(payload: WakePayload, paperclipEnv: Record<string, string>): string {
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

  const lines = [
    "Paperclip wake event for a cloud adapter.",
    "",
    "Set these values in your run context:",
    ...envLines,
    "",
    `task_id=${payload.taskId ?? ""}`,
    `issue_id=${payload.issueId ?? ""}`,
    `wake_reason=${payload.wakeReason ?? ""}`,
    `wake_comment_id=${payload.wakeCommentId ?? ""}`,
    `approval_id=${payload.approvalId ?? ""}`,
    `approval_status=${payload.approvalStatus ?? ""}`,
    `linked_issue_ids=${payload.issueIds.join(",")}`,
  ];

  lines.push("", "Run your Paperclip heartbeat procedure now.");
  return lines.join("\n");
}

function appendWakeText(baseText: string, wakeText: string): string {
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

function appendWakeTextToOpenResponsesInput(input: unknown, wakeText: string): unknown {
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

function isTextRequiredResponse(responseText: string): boolean {
  const parsed = parseOpenClawResponse(responseText);
  const parsedError = parsed && typeof parsed.error === "string" ? parsed.error : null;
  if (parsedError && parsedError.toLowerCase().includes("text required")) {
    return true;
  }
  return responseText.toLowerCase().includes("text required");
}

async function sendJsonRequest(params: {
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

async function readAndLogResponseText(params: {
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

type ConsumedSse = {
  eventCount: number;
  lastEventType: string | null;
  lastData: string | null;
  lastPayload: Record<string, unknown> | null;
  terminal: boolean;
  failed: boolean;
  errorMessage: string | null;
};

function inferSseTerminal(input: {
  eventType: string;
  data: string;
  parsedPayload: Record<string, unknown> | null;
}): { terminal: boolean; failed: boolean; errorMessage: string | null } {
  const normalizedType = input.eventType.trim().toLowerCase();
  const trimmedData = input.data.trim();
  const payload = input.parsedPayload;
  const payloadType = nonEmpty(payload?.type)?.toLowerCase() ?? null;
  const payloadStatus = nonEmpty(payload?.status)?.toLowerCase() ?? null;

  if (trimmedData === "[DONE]") {
    return { terminal: true, failed: false, errorMessage: null };
  }

  const failType =
    normalizedType.includes("error") ||
    normalizedType.includes("failed") ||
    normalizedType.includes("cancel");
  if (failType) {
    return {
      terminal: true,
      failed: true,
      errorMessage:
        nonEmpty(payload?.error) ??
        nonEmpty(payload?.message) ??
        (trimmedData.length > 0 ? trimmedData : "OpenClaw SSE error"),
    };
  }

  const doneType =
    normalizedType === "done" ||
    normalizedType.endsWith(".completed") ||
    normalizedType.endsWith(".done") ||
    normalizedType === "completed";
  if (doneType) {
    return { terminal: true, failed: false, errorMessage: null };
  }

  if (payloadStatus) {
    if (
      payloadStatus === "completed" ||
      payloadStatus === "succeeded" ||
      payloadStatus === "done"
    ) {
      return { terminal: true, failed: false, errorMessage: null };
    }
    if (
      payloadStatus === "failed" ||
      payloadStatus === "cancelled" ||
      payloadStatus === "error"
    ) {
      return {
        terminal: true,
        failed: true,
        errorMessage:
          nonEmpty(payload?.error) ??
          nonEmpty(payload?.message) ??
          `OpenClaw SSE status ${payloadStatus}`,
      };
    }
  }

  if (payloadType) {
    if (payloadType.endsWith(".completed") || payloadType.endsWith(".done")) {
      return { terminal: true, failed: false, errorMessage: null };
    }
    if (
      payloadType.endsWith(".failed") ||
      payloadType.endsWith(".cancelled") ||
      payloadType.endsWith(".error")
    ) {
      return {
        terminal: true,
        failed: true,
        errorMessage:
          nonEmpty(payload?.error) ??
          nonEmpty(payload?.message) ??
          `OpenClaw SSE type ${payloadType}`,
      };
    }
  }

  if (payload?.done === true) {
    return { terminal: true, failed: false, errorMessage: null };
  }

  return { terminal: false, failed: false, errorMessage: null };
}

async function consumeSseResponse(params: {
  response: Response;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<ConsumedSse> {
  const reader = params.response.body?.getReader();
  if (!reader) {
    throw new Error("OpenClaw SSE response body is missing");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "message";
  let dataLines: string[] = [];
  let eventCount = 0;
  let lastEventType: string | null = null;
  let lastData: string | null = null;
  let lastPayload: Record<string, unknown> | null = null;
  let terminal = false;
  let failed = false;
  let errorMessage: string | null = null;

  const dispatchEvent = async (): Promise<boolean> => {
    if (dataLines.length === 0) {
      eventType = "message";
      return false;
    }

    const data = dataLines.join("\n");
    const trimmedData = data.trim();
    const parsedPayload = parseOpenClawResponse(trimmedData);

    eventCount += 1;
    lastEventType = eventType;
    lastData = data;
    if (parsedPayload) lastPayload = parsedPayload;

    const preview =
      trimmedData.length > 1000 ? `${trimmedData.slice(0, 1000)}...` : trimmedData;
    await params.onLog("stdout", `[openclaw:sse] event=${eventType} data=${preview}\n`);

    const resolution = inferSseTerminal({
      eventType,
      data,
      parsedPayload,
    });

    dataLines = [];
    eventType = "message";

    if (resolution.terminal) {
      terminal = true;
      failed = resolution.failed;
      errorMessage = resolution.errorMessage;
      return true;
    }

    return false;
  };

  let shouldStop = false;
  while (!shouldStop) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    while (!shouldStop) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line.length === 0) {
        shouldStop = await dispatchEvent();
        continue;
      }

      if (line.startsWith(":")) continue;

      const colonIndex = line.indexOf(":");
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
      const rawValue =
        colonIndex === -1 ? "" : line.slice(colonIndex + 1).replace(/^ /, "");

      if (field === "event") {
        eventType = rawValue || "message";
      } else if (field === "data") {
        dataLines.push(rawValue);
      }
    }
  }

  buffer += decoder.decode();
  if (!shouldStop && buffer.trim().length > 0) {
    for (const rawLine of buffer.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (line.length === 0) {
        shouldStop = await dispatchEvent();
        if (shouldStop) break;
        continue;
      }
      if (line.startsWith(":")) continue;

      const colonIndex = line.indexOf(":");
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
      const rawValue =
        colonIndex === -1 ? "" : line.slice(colonIndex + 1).replace(/^ /, "");

      if (field === "event") {
        eventType = rawValue || "message";
      } else if (field === "data") {
        dataLines.push(rawValue);
      }
    }
  }

  if (!shouldStop && dataLines.length > 0) {
    await dispatchEvent();
  }

  return {
    eventCount,
    lastEventType,
    lastData,
    lastPayload,
    terminal,
    failed,
    errorMessage,
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context, onLog, onMeta } = ctx;
  const url = asString(config.url, "").trim();
  if (!url) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "OpenClaw adapter missing url",
      errorCode: "openclaw_url_missing",
    };
  }

  if (isWakeCompatibilityEndpoint(url)) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "OpenClaw /hooks/wake is not stream-capable. Use a streaming endpoint.",
      errorCode: "openclaw_sse_incompatible_endpoint",
    };
  }

  const streamTransport = asString(config.streamTransport, "sse").trim().toLowerCase();
  if (streamTransport && streamTransport !== "sse") {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "OpenClaw adapter only supports streamTransport=sse.",
      errorCode: "openclaw_stream_transport_unsupported",
    };
  }

  const method = asString(config.method, "POST").trim().toUpperCase() || "POST";
  const timeoutSecRaw = asNumber(config.timeoutSec, 0);
  const timeoutSec = timeoutSecRaw > 0 ? Math.max(1, Math.floor(timeoutSecRaw)) : 0;
  const headersConfig = parseObject(config.headers) as Record<string, unknown>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  const webhookAuthHeader = nonEmpty(config.webhookAuthHeader);
  const sessionKeyStrategy = normalizeSessionKeyStrategy(config.sessionKeyStrategy);

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  for (const [key, value] of Object.entries(headersConfig)) {
    if (typeof value === "string" && value.trim().length > 0) {
      headers[key] = value;
    }
  }
  const openClawAuthHeader = nonEmpty(headers["x-openclaw-auth"] ?? headers["X-OpenClaw-Auth"]);
  if (openClawAuthHeader && !headers.authorization && !headers.Authorization) {
    headers.authorization = toAuthorizationHeaderValue(openClawAuthHeader);
  }
  if (webhookAuthHeader && !headers.authorization && !headers.Authorization) {
    headers.authorization = webhookAuthHeader;
  }

  const wakePayload = {
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

  const sessionKey = resolveSessionKey({
    strategy: sessionKeyStrategy,
    configuredSessionKey: nonEmpty(config.sessionKey),
    runId,
    issueId: wakePayload.issueId ?? wakePayload.taskId,
  });

  const templateText = nonEmpty(payloadTemplate.text);
  const paperclipApiUrlOverride = resolvePaperclipApiUrlOverride(config.paperclipApiUrl);
  const paperclipEnv: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    PAPERCLIP_RUN_ID: runId,
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

  const wakeText = buildWakeText(wakePayload, paperclipEnv);
  const payloadText = templateText ? `${templateText}\n\n${wakeText}` : wakeText;
  const isOpenResponses = isOpenResponsesEndpoint(url);
  const openResponsesInput = Object.prototype.hasOwnProperty.call(payloadTemplate, "input")
    ? appendWakeTextToOpenResponsesInput(payloadTemplate.input, wakeText)
    : payloadText;

  const paperclipBody: Record<string, unknown> = isOpenResponses
    ? {
      ...payloadTemplate,
      stream: true,
      model:
          nonEmpty(payloadTemplate.model) ??
          nonEmpty(config.model) ??
          "openclaw",
      input: openResponsesInput,
      metadata: {
        ...toStringRecord(payloadTemplate.metadata),
        ...paperclipEnv,
        paperclip_session_key: sessionKey,
      },
    }
    : {
      ...payloadTemplate,
      stream: true,
      sessionKey,
      text: payloadText,
      paperclip: {
        ...wakePayload,
        sessionKey,
        streamTransport: "sse",
        env: paperclipEnv,
        context,
      },
    };

  if (isOpenResponses) {
    delete paperclipBody.text;
    delete paperclipBody.sessionKey;
    delete paperclipBody.paperclip;
    if (!headers["x-openclaw-session-key"] && !headers["X-OpenClaw-Session-Key"]) {
      headers["x-openclaw-session-key"] = sessionKey;
    }
  }

  if (onMeta) {
    await onMeta({
      adapterType: "openclaw",
      command: "sse",
      commandArgs: [method, url],
      context,
    });
  }

  const outboundHeaderKeys = Array.from(new Set([...Object.keys(headers), "accept"])).sort();
  await onLog("stdout", `[openclaw] outbound header keys: ${outboundHeaderKeys.join(", ")}\n`);
  await onLog("stdout", `[openclaw] invoking ${method} ${url} (transport=sse)\n`);

  const controller = new AbortController();
  const timeout = timeoutSec > 0 ? setTimeout(() => controller.abort(), timeoutSec * 1000) : null;

  try {
    const response = await sendJsonRequest({
      url,
      method,
      headers: {
        ...headers,
        accept: "text/event-stream",
      },
      payload: paperclipBody,
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseText = await readAndLogResponseText({ response, onLog });
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage:
          isTextRequiredResponse(responseText)
            ? "OpenClaw endpoint rejected the payload as text-required."
            : `OpenClaw SSE request failed with status ${response.status}`,
        errorCode: isTextRequiredResponse(responseText)
          ? "openclaw_text_required"
          : "openclaw_http_error",
        resultJson: {
          status: response.status,
          statusText: response.statusText,
          response: parseOpenClawResponse(responseText) ?? responseText,
        },
      };
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      const responseText = await readAndLogResponseText({ response, onLog });
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "OpenClaw SSE endpoint did not return text/event-stream",
        errorCode: "openclaw_sse_expected_event_stream",
        resultJson: {
          status: response.status,
          statusText: response.statusText,
          contentType,
          response: parseOpenClawResponse(responseText) ?? responseText,
        },
      };
    }

    const consumed = await consumeSseResponse({ response, onLog });
    if (consumed.failed) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: consumed.errorMessage ?? "OpenClaw SSE stream failed",
        errorCode: "openclaw_sse_stream_failed",
        resultJson: {
          eventCount: consumed.eventCount,
          terminal: consumed.terminal,
          lastEventType: consumed.lastEventType,
          lastData: consumed.lastData,
          response: consumed.lastPayload ?? consumed.lastData,
        },
      };
    }

    if (!consumed.terminal) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "OpenClaw SSE stream closed without a terminal event",
        errorCode: "openclaw_sse_stream_incomplete",
        resultJson: {
          eventCount: consumed.eventCount,
          terminal: consumed.terminal,
          lastEventType: consumed.lastEventType,
          lastData: consumed.lastData,
          response: consumed.lastPayload ?? consumed.lastData,
        },
      };
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "openclaw",
      model: null,
      summary: `OpenClaw SSE ${method} ${url}`,
      resultJson: {
        eventCount: consumed.eventCount,
        terminal: consumed.terminal,
        lastEventType: consumed.lastEventType,
        lastData: consumed.lastData,
        response: consumed.lastPayload ?? consumed.lastData,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const timeoutMessage =
        timeoutSec > 0
          ? `[openclaw] SSE request timed out after ${timeoutSec}s\n`
          : "[openclaw] SSE request aborted\n";
      await onLog("stderr", timeoutMessage);
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: timeoutSec > 0 ? `Timed out after ${timeoutSec}s` : "Request aborted",
        errorCode: "openclaw_sse_timeout",
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[openclaw] request failed: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: "openclaw_request_failed",
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
