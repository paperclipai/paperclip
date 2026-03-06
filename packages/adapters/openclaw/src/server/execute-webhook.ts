import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  appendWakeText,
  appendWakeTextToOpenResponsesInput,
  buildExecutionState,
  buildWakeCompatibilityPayload,
  isOpenResponsesEndpoint,
  isTextRequiredResponse,
  isWakeCompatibilityRetryableResponse,
  isWakeCompatibilityEndpoint,
  normalizeWebhookInvocationUrl,
  readAndLogResponseText,
  redactForLog,
  sendJsonRequest,
  stringifyForLog,
  toStringRecord,
  type OpenClawExecutionState,
} from "./execute-common.js";
import { parseOpenClawResponse } from "./parse.js";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function buildWebhookBody(input: {
  url: string;
  state: OpenClawExecutionState;
  context: AdapterExecutionContext["context"];
  configModel: unknown;
}): Record<string, unknown> {
  const { url, state, context, configModel } = input;
  const templateText = nonEmpty(state.payloadTemplate.text);
  const payloadText = templateText ? appendWakeText(templateText, state.wakeText) : state.wakeText;
  const isOpenResponses = isOpenResponsesEndpoint(url);

  if (isOpenResponses) {
    const openResponsesInput = Object.prototype.hasOwnProperty.call(state.payloadTemplate, "input")
      ? appendWakeTextToOpenResponsesInput(state.payloadTemplate.input, state.wakeText)
      : payloadText;

    return {
      ...state.payloadTemplate,
      stream: false,
      model:
        nonEmpty(state.payloadTemplate.model) ??
        nonEmpty(configModel) ??
        "openclaw",
      input: openResponsesInput,
      metadata: {
        ...toStringRecord(state.payloadTemplate.metadata),
        ...state.paperclipEnv,
        paperclip_session_key: state.sessionKey,
        paperclip_stream_transport: "webhook",
      },
    };
  }

  return {
    ...state.payloadTemplate,
    stream: false,
    sessionKey: state.sessionKey,
    text: payloadText,
    paperclip: {
      ...state.wakePayload,
      sessionKey: state.sessionKey,
      streamTransport: "webhook",
      env: state.paperclipEnv,
      context,
    },
  };
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

export async function executeWebhook(ctx: AdapterExecutionContext, url: string): Promise<AdapterExecutionResult> {
  const { onLog, onMeta, context } = ctx;
  const state = buildExecutionState(ctx);
  const webhookTarget = normalizeWebhookInvocationUrl(url);
  const webhookUrl = webhookTarget.url;

  if (onMeta) {
    await onMeta({
      adapterType: "openclaw",
      command: "webhook",
      commandArgs: [state.method, webhookUrl],
      context,
    });
  }

  const headers = { ...state.headers };
  if (
    isOpenResponsesEndpoint(webhookUrl) &&
    !headers["x-openclaw-session-key"] &&
    !headers["X-OpenClaw-Session-Key"]
  ) {
    headers["x-openclaw-session-key"] = state.sessionKey;
  }

  const webhookBody = buildWebhookBody({
    url: webhookUrl,
    state,
    context,
    configModel: ctx.config.model,
  });
  const wakeCompatibilityBody = buildWakeCompatibilityPayload(state.wakeText);
  const preferWakeCompatibilityBody = isWakeCompatibilityEndpoint(webhookUrl);
  const initialBody = preferWakeCompatibilityBody ? wakeCompatibilityBody : webhookBody;

  const outboundHeaderKeys = Object.keys(headers).sort();
  await onLog(
    "stdout",
    `[openclaw] outbound headers (redacted): ${stringifyForLog(redactForLog(headers), 4_000)}\n`,
  );
  await onLog(
    "stdout",
    `[openclaw] outbound payload (redacted): ${stringifyForLog(redactForLog(initialBody), 12_000)}\n`,
  );
  await onLog("stdout", `[openclaw] outbound header keys: ${outboundHeaderKeys.join(", ")}\n`);
  if (webhookTarget.normalizedFromOpenResponses) {
    await onLog(
      "stdout",
      `[openclaw] webhook transport normalized /v1/responses endpoint to ${webhookUrl}\n`,
    );
  }
  await onLog("stdout", `[openclaw] invoking ${state.method} ${webhookUrl} (transport=webhook)\n`);

  if (preferWakeCompatibilityBody) {
    await onLog("stdout", "[openclaw] using wake text payload for /hooks/wake compatibility\n");
  }

  const controller = new AbortController();
  const timeout = state.timeoutSec > 0 ? setTimeout(() => controller.abort(), state.timeoutSec * 1000) : null;

  try {
    const initialResponse = await sendWebhookRequest({
      url: webhookUrl,
      method: state.method,
      headers,
      payload: initialBody,
      onLog,
      signal: controller.signal,
    });

    if (!initialResponse.response.ok) {
      const canRetryWithWakeCompatibility =
        !preferWakeCompatibilityBody && isWakeCompatibilityRetryableResponse(initialResponse.responseText);

      if (canRetryWithWakeCompatibility) {
        await onLog(
          "stdout",
          "[openclaw] endpoint requires text payload; retrying with wake compatibility format\n",
        );

        const retryResponse = await sendWebhookRequest({
          url: webhookUrl,
          method: state.method,
          headers,
          payload: wakeCompatibilityBody,
          onLog,
          signal: controller.signal,
        });

        if (retryResponse.response.ok) {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            provider: "openclaw",
            model: null,
            summary: `OpenClaw webhook ${state.method} ${webhookUrl} (wake compatibility)`,
            resultJson: {
              status: retryResponse.response.status,
              statusText: retryResponse.response.statusText,
              compatibilityMode: "wake_text",
              response: parseOpenClawResponse(retryResponse.responseText) ?? retryResponse.responseText,
            },
          };
        }

        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage:
            isTextRequiredResponse(retryResponse.responseText)
              ? "OpenClaw endpoint rejected the wake compatibility payload as text-required."
              : `OpenClaw webhook failed with status ${retryResponse.response.status}`,
          errorCode: isTextRequiredResponse(retryResponse.responseText)
            ? "openclaw_text_required"
            : "openclaw_http_error",
          resultJson: {
            status: retryResponse.response.status,
            statusText: retryResponse.response.statusText,
            compatibilityMode: "wake_text",
            response: parseOpenClawResponse(retryResponse.responseText) ?? retryResponse.responseText,
          },
        };
      }

      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage:
          isTextRequiredResponse(initialResponse.responseText)
            ? "OpenClaw endpoint rejected the payload as text-required."
            : `OpenClaw webhook failed with status ${initialResponse.response.status}`,
        errorCode: isTextRequiredResponse(initialResponse.responseText)
          ? "openclaw_text_required"
          : "openclaw_http_error",
        resultJson: {
          status: initialResponse.response.status,
          statusText: initialResponse.response.statusText,
          response: parseOpenClawResponse(initialResponse.responseText) ?? initialResponse.responseText,
        },
      };
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "openclaw",
      model: null,
      summary: `OpenClaw webhook ${state.method} ${webhookUrl}`,
      resultJson: {
        status: initialResponse.response.status,
        statusText: initialResponse.response.statusText,
        response: parseOpenClawResponse(initialResponse.responseText) ?? initialResponse.responseText,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const timeoutMessage =
        state.timeoutSec > 0
          ? `[openclaw] webhook request timed out after ${state.timeoutSec}s\n`
          : "[openclaw] webhook request aborted\n";
      await onLog("stderr", timeoutMessage);
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: state.timeoutSec > 0 ? `Timed out after ${state.timeoutSec}s` : "Request aborted",
        errorCode: "openclaw_webhook_timeout",
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
