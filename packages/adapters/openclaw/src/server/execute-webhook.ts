import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  appendWakeText,
  appendWakeTextToOpenResponsesInput,
  buildExecutionState,
  buildWakeCompatibilityPayload,
  deriveHookAgentUrlFromResponses,
  isTextRequiredResponse,
  isWakeCompatibilityRetryableResponse,
  readAndLogResponseText,
  redactForLog,
  resolveEndpointKind,
  sendJsonRequest,
  stringifyForLog,
  toStringRecord,
  type OpenClawEndpointKind,
  type OpenClawExecutionState,
} from "./execute-common.js";
import { parseOpenClawResponse } from "./parse.js";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asBooleanFlag(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return fallback;
}

function normalizeWakeMode(value: unknown): "now" | "next-heartbeat" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "now" || normalized === "next-heartbeat") return normalized;
  return null;
}

function parseOptionalPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.max(1, Math.floor(value));
    return Number.isFinite(normalized) ? normalized : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      const normalized = Math.max(1, Math.floor(parsed));
      return Number.isFinite(normalized) ? normalized : null;
    }
  }
  return null;
}

function buildOpenResponsesWebhookBody(input: {
  state: OpenClawExecutionState;
  configModel: unknown;
}): Record<string, unknown> {
  const { state, configModel } = input;
  const templateText = nonEmpty(state.payloadTemplate.text);
  const payloadText = templateText ? appendWakeText(templateText, state.wakeText) : state.wakeText;
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

function buildHookWakeBody(state: OpenClawExecutionState): Record<string, unknown> {
  const templateText = nonEmpty(state.payloadTemplate.text) ?? nonEmpty(state.payloadTemplate.message);
  const payloadText = templateText ? appendWakeText(templateText, state.wakeText) : state.wakeText;
  const wakeMode = normalizeWakeMode(state.payloadTemplate.mode ?? state.payloadTemplate.wakeMode) ?? "now";

  return {
    text: payloadText,
    mode: wakeMode,
  };
}

function buildHookAgentBody(input: {
  state: OpenClawExecutionState;
  includeSessionKey: boolean;
}): Record<string, unknown> {
  const { state, includeSessionKey } = input;
  const templateMessage = nonEmpty(state.payloadTemplate.message) ?? nonEmpty(state.payloadTemplate.text);
  const message = templateMessage ? appendWakeText(templateMessage, state.wakeText) : state.wakeText;
  const payload: Record<string, unknown> = {
    message,
  };

  const name = nonEmpty(state.payloadTemplate.name);
  if (name) payload.name = name;

  const agentId = nonEmpty(state.payloadTemplate.agentId);
  if (agentId) payload.agentId = agentId;

  const wakeMode = normalizeWakeMode(state.payloadTemplate.wakeMode ?? state.payloadTemplate.mode);
  if (wakeMode) payload.wakeMode = wakeMode;

  const deliver = state.payloadTemplate.deliver;
  if (typeof deliver === "boolean") payload.deliver = deliver;

  const channel = nonEmpty(state.payloadTemplate.channel);
  if (channel) payload.channel = channel;

  const to = nonEmpty(state.payloadTemplate.to);
  if (to) payload.to = to;

  const model = nonEmpty(state.payloadTemplate.model);
  if (model) payload.model = model;

  const thinking = nonEmpty(state.payloadTemplate.thinking);
  if (thinking) payload.thinking = thinking;

  const timeoutSeconds = parseOptionalPositiveInteger(state.payloadTemplate.timeoutSeconds);
  if (timeoutSeconds != null) payload.timeoutSeconds = timeoutSeconds;

  const explicitSessionKey = nonEmpty(state.payloadTemplate.sessionKey);
  if (explicitSessionKey) {
    payload.sessionKey = explicitSessionKey;
  } else if (includeSessionKey) {
    payload.sessionKey = state.sessionKey;
  }

  return payload;
}

function buildLegacyWebhookBody(input: {
  state: OpenClawExecutionState;
  context: AdapterExecutionContext["context"];
}): Record<string, unknown> {
  const { state, context } = input;
  const templateText = nonEmpty(state.payloadTemplate.text);
  const payloadText = templateText ? appendWakeText(templateText, state.wakeText) : state.wakeText;
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

function buildWebhookBody(input: {
  endpointKind: OpenClawEndpointKind;
  state: OpenClawExecutionState;
  context: AdapterExecutionContext["context"];
  configModel: unknown;
  includeHookSessionKey: boolean;
}): Record<string, unknown> {
  const { endpointKind, state, context, configModel, includeHookSessionKey } = input;
  if (endpointKind === "open_responses") {
    return buildOpenResponsesWebhookBody({ state, configModel });
  }
  if (endpointKind === "hook_wake") {
    return buildHookWakeBody(state);
  }
  if (endpointKind === "hook_agent") {
    return buildHookAgentBody({ state, includeSessionKey: includeHookSessionKey });
  }

  return buildLegacyWebhookBody({ state, context });
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
  const originalUrl = url;
  const originalEndpointKind = resolveEndpointKind(originalUrl);
  let targetUrl = originalUrl;
  let endpointKind = resolveEndpointKind(targetUrl);
  const remappedFromResponses = originalEndpointKind === "open_responses";

  // In webhook mode, /v1/responses is legacy wiring. Prefer hooks/agent.
  if (remappedFromResponses) {
    const rewritten = deriveHookAgentUrlFromResponses(targetUrl);
    if (rewritten) {
      await onLog(
        "stdout",
        `[openclaw] webhook transport selected; remapping ${targetUrl} -> ${rewritten}\n`,
      );
      targetUrl = rewritten;
      endpointKind = resolveEndpointKind(targetUrl);
    }
  }

  const headers = { ...state.headers };
  if (endpointKind === "open_responses" && !headers["x-openclaw-session-key"] && !headers["X-OpenClaw-Session-Key"]) {
    headers["x-openclaw-session-key"] = state.sessionKey;
  }

  if (onMeta) {
    await onMeta({
      adapterType: "openclaw",
      command: "webhook",
      commandArgs: [state.method, targetUrl],
      context,
    });
  }

  const includeHookSessionKey = asBooleanFlag(ctx.config.hookIncludeSessionKey, false);
  const webhookBody = buildWebhookBody({
    endpointKind,
    state,
    context,
    configModel: ctx.config.model,
    includeHookSessionKey,
  });
  const wakeCompatibilityBody = buildWakeCompatibilityPayload(state.wakeText);
  const preferWakeCompatibilityBody = endpointKind === "hook_wake";
  const initialBody = webhookBody;

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
  await onLog("stdout", `[openclaw] invoking ${state.method} ${targetUrl} (transport=webhook kind=${endpointKind})\n`);

  if (preferWakeCompatibilityBody) {
    await onLog("stdout", "[openclaw] using webhook wake payload for /hooks/wake\n");
  }

  const controller = new AbortController();
  const timeout = state.timeoutSec > 0 ? setTimeout(() => controller.abort(), state.timeoutSec * 1000) : null;

  try {
    const initialResponse = await sendWebhookRequest({
      url: targetUrl,
      method: state.method,
      headers,
      payload: initialBody,
      onLog,
      signal: controller.signal,
    });

    let activeResponse = initialResponse;
    let activeEndpointKind = endpointKind;
    let activeUrl = targetUrl;
    let activeHeaders = headers;
    let usedLegacyResponsesFallback = false;

    if (
      remappedFromResponses &&
      targetUrl !== originalUrl &&
      initialResponse.response.status === 404
    ) {
      await onLog(
        "stdout",
        `[openclaw] remapped hook endpoint returned 404; retrying legacy endpoint ${originalUrl}\n`,
      );

      activeEndpointKind = originalEndpointKind;
      activeUrl = originalUrl;
      usedLegacyResponsesFallback = true;
      const fallbackHeaders = { ...state.headers };
      if (
        activeEndpointKind === "open_responses" &&
        !fallbackHeaders["x-openclaw-session-key"] &&
        !fallbackHeaders["X-OpenClaw-Session-Key"]
      ) {
        fallbackHeaders["x-openclaw-session-key"] = state.sessionKey;
      }

      const fallbackBody = buildWebhookBody({
        endpointKind: activeEndpointKind,
        state,
        context,
        configModel: ctx.config.model,
        includeHookSessionKey,
      });

      await onLog(
        "stdout",
        `[openclaw] fallback headers (redacted): ${stringifyForLog(redactForLog(fallbackHeaders), 4_000)}\n`,
      );
      await onLog(
        "stdout",
        `[openclaw] fallback payload (redacted): ${stringifyForLog(redactForLog(fallbackBody), 12_000)}\n`,
      );
      await onLog(
        "stdout",
        `[openclaw] invoking fallback ${state.method} ${activeUrl} (transport=webhook kind=${activeEndpointKind})\n`,
      );

      activeResponse = await sendWebhookRequest({
        url: activeUrl,
        method: state.method,
        headers: fallbackHeaders,
        payload: fallbackBody,
        onLog,
        signal: controller.signal,
      });
      activeHeaders = fallbackHeaders;
    }

    if (!activeResponse.response.ok) {
      const canRetryWithWakeCompatibility =
        (activeEndpointKind === "open_responses" || activeEndpointKind === "generic") &&
        isWakeCompatibilityRetryableResponse(activeResponse.responseText);

      if (canRetryWithWakeCompatibility) {
        await onLog(
          "stdout",
          "[openclaw] endpoint requires text payload; retrying with wake compatibility format\n",
        );

        const retryResponse = await sendWebhookRequest({
          url: activeUrl,
          method: state.method,
          headers: activeHeaders,
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
            summary: `OpenClaw webhook ${state.method} ${activeUrl} (wake compatibility)`,
            resultJson: {
              status: retryResponse.response.status,
              statusText: retryResponse.response.statusText,
              compatibilityMode: "wake_text",
              usedLegacyResponsesFallback,
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
            isTextRequiredResponse(activeResponse.responseText)
              ? "OpenClaw endpoint rejected the payload as text-required."
            : `OpenClaw webhook failed with status ${activeResponse.response.status}`,
        errorCode: isTextRequiredResponse(activeResponse.responseText)
          ? "openclaw_text_required"
          : "openclaw_http_error",
        resultJson: {
          status: activeResponse.response.status,
          statusText: activeResponse.response.statusText,
          response: parseOpenClawResponse(activeResponse.responseText) ?? activeResponse.responseText,
        },
      };
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "openclaw",
      model: null,
      summary: `OpenClaw webhook ${state.method} ${activeUrl}`,
      resultJson: {
        status: activeResponse.response.status,
        statusText: activeResponse.response.statusText,
        usedLegacyResponsesFallback,
        response: parseOpenClawResponse(activeResponse.responseText) ?? activeResponse.responseText,
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
