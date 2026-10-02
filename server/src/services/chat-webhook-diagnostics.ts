import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { CHAT_PROVIDERS, type ChatProvider } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

const SLACK_RETRY_REASONS = [
  "http_timeout",
  "too_many_redirects",
  "connection_failed",
  "ssl_error",
  "http_error",
  "unknown_error",
] as const;
const STAGES = [
  "http_received",
  "handler_started",
  "endpoint_resolved",
  "runtime_requested",
  "runtime_initializing",
  "runtime_ready",
  "durable_receipt",
  "response_ready",
  "response_finished",
  "response_closed",
] as const;
type Stage = (typeof STAGES)[number];
type RetryReason = (typeof SLACK_RETRY_REASONS)[number];
type ReceiptKind = "message_delivery" | "github_ingress";
export type ChatWebhookDiagnosticEvent = {
  event: "chat_webhook_timing";
  requestId: string;
  provider: ChatProvider;
  stage: Stage;
  httpReceivedAtMs: number;
  elapsedMs: number;
  endpointId?: string;
  receiptId?: string;
  receiptKind?: ReceiptKind;
  providerSentAtMs?: number;
  statusCode?: number;
  // Retry headers are diagnostic hints, not signature-authenticated authority.
  slackRetryNumHint?: number;
  slackRetryReasonHint?: RetryReason;
};
type Trace = {
  base: Pick<
    ChatWebhookDiagnosticEvent,
    | "event"
    | "requestId"
    | "provider"
    | "httpReceivedAtMs"
    | "slackRetryNumHint"
    | "slackRetryReasonHint"
  >;
  start: number;
  now: () => number;
  emit: (event: ChatWebhookDiagnosticEvent) => void;
  endpointId?: string;
  stages: Set<Stage>;
  receipts: Set<string>;
};
const traces = new AsyncLocalStorage<Trace>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emit(
  trace: Trace,
  stage: Stage,
  fields: Partial<ChatWebhookDiagnosticEvent> = {},
) {
  try {
    const elapsed = trace.now() - trace.start;
    const emitted = trace.emit({
      ...trace.base,
      stage,
      elapsedMs: Number.isFinite(elapsed)
        ? Math.min(86_400_000, Math.max(0, Math.round(elapsed * 1000) / 1000))
        : 0,
      ...(trace.endpointId ? { endpointId: trace.endpointId } : {}),
      ...fields,
    }) as unknown;
    // The production logger is synchronous. Never await or leak a rejection
    // if a diagnostic sink is replaced by an asynchronous test/host wrapper.
    if (emitted instanceof Promise) void emitted.catch(() => undefined);
  } catch {
    // Local diagnostics must never change provider acknowledgement or admission.
  }
}

/**
 * Mount before the webhook body parser: http_received means Express received
 * request headers, not that the body, signature or message has been accepted.
 * Local structured logs only: no bodies, URLs, arbitrary headers or errors.
 */
export function createChatWebhookDiagnostics(
  options: {
    emit?: (event: ChatWebhookDiagnosticEvent) => void;
    monotonicNow?: () => number;
  } = {},
): RequestHandler {
  return (req, res, next) => {
    const match = /^\/api\/chat-webhooks\/[^/?]+\/([^/?]+)\/?(?:\?|$)/.exec(
      req.originalUrl,
    );
    const provider = match?.[1];
    if (
      req.method !== "POST" ||
      !CHAT_PROVIDERS.includes(provider as ChatProvider)
    ) {
      next();
      return;
    }
    const retryNum = req.headers["x-slack-retry-num"];
    const retryReason = req.headers["x-slack-retry-reason"];
    const now = options.monotonicNow ?? (() => performance.now());
    const trace: Trace = {
      base: {
        event: "chat_webhook_timing",
        requestId: randomUUID(),
        provider: provider as ChatProvider,
        httpReceivedAtMs: Date.now(),
        ...(provider === "slack" &&
        typeof retryNum === "string" &&
        /^[0-9]{1,2}$/.test(retryNum)
          ? { slackRetryNumHint: Number(retryNum) }
          : {}),
        ...(provider === "slack" &&
        SLACK_RETRY_REASONS.includes(retryReason as RetryReason)
          ? { slackRetryReasonHint: retryReason as RetryReason }
          : {}),
      },
      start: now(),
      now,
      emit:
        options.emit ?? ((event) => logger.info(event, "Chat webhook timing")),
      stages: new Set(),
      receipts: new Set(),
    };
    let finished = false;
    res.once("finish", () => {
      finished = true;
      emit(trace, "response_finished", {
        ...(Number.isInteger(res.statusCode) &&
        res.statusCode >= 100 &&
        res.statusCode <= 599
          ? { statusCode: res.statusCode }
          : {}),
      });
    });
    res.once("close", () => {
      if (!finished) emit(trace, "response_closed");
    });
    traces.run(trace, () => {
      recordChatWebhookStage("http_received");
      next();
    });
  };
}

export function recordChatWebhookStage(
  stage: Stage,
  endpointId?: string,
): void {
  const trace = traces.getStore();
  if (!trace || !STAGES.includes(stage) || trace.stages.has(stage)) return;
  if (endpointId && UUID.test(endpointId)) trace.endpointId = endpointId;
  trace.stages.add(stage);
  emit(trace, stage);
}

/**
 * Call only after a real receipt transaction commits, never before an INSERT.
 * Receipt storage includes duplicate/filtered input; it does not grant a wake
 * or mean the provider response has finished. Catch-up callbacks are capped
 * at eight distinct receipt IDs per HTTP request.
 */
export function recordChatWebhookReceipt(
  endpointId: string,
  receiptId: string,
  receiptKind: ReceiptKind,
  providerSentAt?: Date | null,
): void {
  const trace = traces.getStore();
  if (
    !trace ||
    !UUID.test(endpointId) ||
    !UUID.test(receiptId) ||
    (receiptKind !== "message_delivery" && receiptKind !== "github_ingress") ||
    trace.receipts.has(receiptId) ||
    trace.receipts.size >= 8
  )
    return;
  trace.endpointId = endpointId;
  trace.receipts.add(receiptId);
  const sentAt =
    providerSentAt instanceof Date ? providerSentAt.getTime() : undefined;
  emit(trace, "durable_receipt", {
    receiptId,
    receiptKind,
    ...(typeof sentAt === "number" && Number.isFinite(sentAt) && sentAt >= 0
      ? { providerSentAtMs: sentAt }
      : {}),
  });
}
