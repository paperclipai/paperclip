import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  appendWakeTextToOpenResponsesInput,
  buildExecutionState,
  isOpenResponsesEndpoint,
  isTextRequiredResponse,
  readAndLogResponseText,
  redactForLog,
  sendJsonRequest,
  stringifyForLog,
  toStringRecord,
  type OpenClawExecutionState,
} from "./execute-common.js";
import { parseOpenClawResponse } from "./parse.js";

type ConsumedSse = {
  eventCount: number;
  lastEventType: string | null;
  lastData: string | null;
  lastPayload: Record<string, unknown> | null;
  terminal: boolean;
  failed: boolean;
  errorMessage: string | null;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

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
    if (payloadType.endsWith(".completed")) {
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

function buildSseBody(input: {
  url: string;
  state: OpenClawExecutionState;
  context: AdapterExecutionContext["context"];
  configModel: unknown;
}): { headers: Record<string, string>; body: Record<string, unknown> } {
  const { url, state, context, configModel } = input;
  const templateText = nonEmpty(state.payloadTemplate.text);
  const payloadText = templateText ? `${templateText}\n\n${state.wakeText}` : state.wakeText;

  const isOpenResponses = isOpenResponsesEndpoint(url);
  const openResponsesInput = Object.prototype.hasOwnProperty.call(state.payloadTemplate, "input")
    ? appendWakeTextToOpenResponsesInput(state.payloadTemplate.input, state.wakeText)
    : payloadText;

  const body: Record<string, unknown> = isOpenResponses
    ? {
      ...state.payloadTemplate,
      stream: true,
      model:
          nonEmpty(state.payloadTemplate.model) ??
          nonEmpty(configModel) ??
          "openclaw",
      input: openResponsesInput,
      metadata: {
        ...toStringRecord(state.payloadTemplate.metadata),
        ...state.paperclipEnv,
        paperclip_session_key: state.sessionKey,
      },
    }
    : {
      ...state.payloadTemplate,
      stream: true,
      sessionKey: state.sessionKey,
      text: payloadText,
      paperclip: {
        ...state.wakePayload,
        sessionKey: state.sessionKey,
        streamTransport: "sse",
        env: state.paperclipEnv,
        context,
      },
    };

  const headers: Record<string, string> = {
    ...state.headers,
    accept: "text/event-stream",
  };

  if (isOpenResponses && !headers["x-openclaw-session-key"] && !headers["X-OpenClaw-Session-Key"]) {
    headers["x-openclaw-session-key"] = state.sessionKey;
  }

  return { headers, body };
}

export async function executeSse(ctx: AdapterExecutionContext, url: string): Promise<AdapterExecutionResult> {
  const { onLog, onMeta, context } = ctx;
  const state = buildExecutionState(ctx);

  if (onMeta) {
    await onMeta({
      adapterType: "openclaw",
      command: "sse",
      commandArgs: [state.method, url],
      context,
    });
  }

  const { headers, body } = buildSseBody({
    url,
    state,
    context,
    configModel: ctx.config.model,
  });

  const outboundHeaderKeys = Object.keys(headers).sort();
  await onLog(
    "stdout",
    `[openclaw] outbound headers (redacted): ${stringifyForLog(redactForLog(headers), 4_000)}\n`,
  );
  await onLog(
    "stdout",
    `[openclaw] outbound payload (redacted): ${stringifyForLog(redactForLog(body), 12_000)}\n`,
  );
  await onLog("stdout", `[openclaw] outbound header keys: ${outboundHeaderKeys.join(", ")}\n`);
  await onLog("stdout", `[openclaw] invoking ${state.method} ${url} (transport=sse)\n`);

  const controller = new AbortController();
  const timeout = state.timeoutSec > 0 ? setTimeout(() => controller.abort(), state.timeoutSec * 1000) : null;

  try {
    const response = await sendJsonRequest({
      url,
      method: state.method,
      headers,
      payload: body,
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
      summary: `OpenClaw SSE ${state.method} ${url}`,
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
        state.timeoutSec > 0
          ? `[openclaw] SSE request timed out after ${state.timeoutSec}s\n`
          : "[openclaw] SSE request aborted\n";
      await onLog("stderr", timeoutMessage);
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: state.timeoutSec > 0 ? `Timed out after ${state.timeoutSec}s` : "Request aborted",
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
