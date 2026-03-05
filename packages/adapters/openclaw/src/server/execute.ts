import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { parseOpenClawResponse } from "./parse.js";

type OpenClawTransport = "sse" | "webhook";
type SessionKeyStrategy = "fixed" | "issue" | "run";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeTransport(value: unknown): OpenClawTransport {
  const normalized = asString(value, "sse").trim().toLowerCase();
  return normalized === "webhook" ? "webhook" : "sse";
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

function shouldUseWakeTextPayload(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return path === "/hooks/wake" || path.endsWith("/hooks/wake");
  } catch {
    return false;
  }
}

function buildWakeText(payload: {
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
}): string {
  const lines = [
    "Paperclip wake event.",
    "",
    `runId: ${payload.runId}`,
    `agentId: ${payload.agentId}`,
    `companyId: ${payload.companyId}`,
  ];

  if (payload.taskId) lines.push(`taskId: ${payload.taskId}`);
  if (payload.issueId) lines.push(`issueId: ${payload.issueId}`);
  if (payload.wakeReason) lines.push(`wakeReason: ${payload.wakeReason}`);
  if (payload.wakeCommentId) lines.push(`wakeCommentId: ${payload.wakeCommentId}`);
  if (payload.approvalId) lines.push(`approvalId: ${payload.approvalId}`);
  if (payload.approvalStatus) lines.push(`approvalStatus: ${payload.approvalStatus}`);
  if (payload.issueIds.length > 0) lines.push(`issueIds: ${payload.issueIds.join(",")}`);

  lines.push("", "Run your Paperclip heartbeat procedure now.");
  return lines.join("\n");
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

async function sendWebhookRequest(params: {
  url: string;
  method: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  onLog: AdapterExecutionContext["onLog"];
  signal: AbortSignal;
}): Promise<{ response: Response; responseText: string }> {
  const response = await sendJsonRequest({
    url: params.url,
    method: params.method,
    headers: params.headers,
    payload: params.payload,
    signal: params.signal,
  });

  const responseText = await readAndLogResponseText({ response, onLog: params.onLog });
  return { response, responseText };
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

  const transport = normalizeTransport(config.streamTransport);
  const method = asString(config.method, "POST").trim().toUpperCase() || "POST";
  const timeoutSec = Math.max(1, asNumber(config.timeoutSec, 30));
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

  const paperclipBody = {
    ...payloadTemplate,
    stream: transport === "sse",
    sessionKey,
    paperclip: {
      ...wakePayload,
      sessionKey,
      streamTransport: transport,
      context,
    },
  };

  const wakeTextBody = {
    text: buildWakeText(wakePayload),
    mode: "now",
  };

  if (onMeta) {
    await onMeta({
      adapterType: "openclaw",
      command: transport === "sse" ? "sse" : "webhook",
      commandArgs: [method, url],
      context,
    });
  }

  await onLog("stdout", `[openclaw] invoking ${method} ${url} (transport=${transport})\n`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    if (transport === "sse") {
      const sseHeaders = {
        ...headers,
        accept: "text/event-stream",
      };

      const response = await sendJsonRequest({
        url,
        method,
        headers: sseHeaders,
        payload: paperclipBody,
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseText = await readAndLogResponseText({ response, onLog });
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `OpenClaw SSE request failed with status ${response.status}`,
          errorCode: "openclaw_http_error",
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
    }

    const preferWakeTextPayload = shouldUseWakeTextPayload(url);
    if (preferWakeTextPayload) {
      await onLog("stdout", "[openclaw] using wake text payload for /hooks/wake compatibility\n");
    }

    const initialPayload = preferWakeTextPayload ? wakeTextBody : paperclipBody;

    const { response, responseText } = await sendWebhookRequest({
      url,
      method,
      headers,
      payload: initialPayload,
      onLog,
      signal: controller.signal,
    });

    if (!response.ok) {
      const canRetryWithWakeText = !preferWakeTextPayload && isTextRequiredResponse(responseText);

      if (canRetryWithWakeText) {
        await onLog(
          "stdout",
          "[openclaw] endpoint requires text payload; retrying with wake compatibility format\n",
        );

        const retry = await sendWebhookRequest({
          url,
          method,
          headers,
          payload: wakeTextBody,
          onLog,
          signal: controller.signal,
        });

        if (retry.response.ok) {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            provider: "openclaw",
            model: null,
            summary: `OpenClaw webhook ${method} ${url} (wake compatibility)`,
            resultJson: {
              status: retry.response.status,
              statusText: retry.response.statusText,
              compatibilityMode: "wake_text",
              response: parseOpenClawResponse(retry.responseText) ?? retry.responseText,
            },
          };
        }

        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `OpenClaw webhook failed with status ${retry.response.status}`,
          errorCode: "openclaw_http_error",
          resultJson: {
            status: retry.response.status,
            statusText: retry.response.statusText,
            compatibilityMode: "wake_text",
            response: parseOpenClawResponse(retry.responseText) ?? retry.responseText,
          },
        };
      }

      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `OpenClaw webhook failed with status ${response.status}`,
        errorCode: "openclaw_http_error",
        resultJson: {
          status: response.status,
          statusText: response.statusText,
          response: parseOpenClawResponse(responseText) ?? responseText,
        },
      };
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "openclaw",
      model: null,
      summary: `OpenClaw webhook ${method} ${url}`,
      resultJson: {
        status: response.status,
        statusText: response.statusText,
        response: parseOpenClawResponse(responseText) ?? responseText,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      await onLog("stderr", `[openclaw] request timed out after ${timeoutSec}s\n`);
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
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
    clearTimeout(timeout);
  }
}
