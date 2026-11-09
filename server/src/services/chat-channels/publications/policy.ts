import type { LifecycleRuntimeFence } from "../runtime-types.js";

import {
  chatPublications,
} from "@paperclipai/db";
import type {
  SafeChatPublicationPayload,
} from "@paperclipai/shared";

  function isExplicitOperatorPublication(
    publication: Pick<typeof chatPublications.$inferSelect, "idempotencyKey">,
  ): boolean {
    return /^(?:explicit:|explicit-board:)/.test(publication.idempotencyKey);
  }

const ATTACHMENT_FAILURE_NOTICE_PREFIX = "attachment-failure-notice:";

function attachmentFailureNoticeFence(
  idempotencyKey: string,
): LifecycleRuntimeFence | null {
  const match =
    /^attachment-failure-notice:[0-9a-f-]{36}:(\d+):([0-9a-f]{64})$/i.exec(
      idempotencyKey,
    );
  if (!match) return null;
  const generation = Number(match[1]);
  if (!Number.isSafeInteger(generation) || generation < 0) return null;
  return { generation, credentialFingerprint: match[2]!.toLowerCase() };
}

function definiteAttachmentProviderRejection(error: unknown): boolean {
  const pending: Array<{ depth: number; value: unknown }> = [
    { depth: 0, value: error },
  ];
  const seen = new Set<object>();
  const statuses: number[] = [];
  const names: string[] = [];
  const codes: string[] = [];
  while (pending.length > 0) {
    const current = pending.shift();
    if (
      !current ||
      current.depth > 4 ||
      !current.value ||
      typeof current.value !== "object" ||
      seen.has(current.value)
    ) {
      continue;
    }
    seen.add(current.value);
    const record = current.value as {
      cause?: unknown;
      code?: unknown;
      details?: { code?: unknown; providerStatus?: unknown };
      innerHttpError?: { statusCode?: unknown };
      name?: unknown;
      original?: unknown;
      originalError?: unknown;
      response?: { status?: unknown };
      status?: unknown;
      statusCode?: unknown;
    };
    for (const status of [
      record.status,
      record.statusCode,
      record.response?.status,
      record.details?.providerStatus,
      record.innerHttpError?.statusCode,
    ]) {
      if (typeof status === "number" && Number.isInteger(status)) {
        statuses.push(status);
      }
    }
    if (typeof record.name === "string") names.push(record.name);
    for (const code of [record.code, record.details?.code]) {
      if (typeof code === "string") codes.push(code);
    }
    for (const nested of [
      record.cause,
      record.original,
      record.originalError,
    ]) {
      pending.push({ depth: current.depth + 1, value: nested });
    }
  }
  if (
    names.some((name) =>
      ["ValidationError", "NotImplementedError"].includes(name),
    ) ||
    codes.some((code) =>
      [
        "CHAT_ADAPTER_COMPATIBILITY_ERROR",
        "CHAT_PROVIDER_PRETRANSPORT_REJECTED",
        "NOT_IMPLEMENTED",
        "VALIDATION_ERROR",
      ].includes(code),
    )
  ) {
    return false;
  }
  // Slack's Web API can reject a file operation with `ok: false` in an HTTP
  // 200 response. The SDK's structured platform-error code is still a
  // definitive provider rejection; the main disposition classifier has
  // already excluded auth, destination, and rate-limit outcomes.
  if (codes.includes("slack_webapi_platform_error")) return true;
  return statuses.some(
    (status) =>
      status >= 400 &&
      status < 500 &&
      ![401, 403, 404, 410, 429].includes(status),
  );
}

function attachmentFailureKind(
  payload: SafeChatPublicationPayload,
):
  | { kind: "generated_response"; provider: "discord" | "telegram" }
  | { kind: "selected_file"; provider: null }
  | null {
  if (payload.transportPart?.mode === "discord_markdown_attachment") {
    return { kind: "generated_response", provider: "discord" };
  }
  if (payload.transportPart?.mode === "telegram_markdown_attachment") {
    return { kind: "generated_response", provider: "telegram" };
  }
  if (payload.attachmentIds?.length) {
    return { kind: "selected_file", provider: null };
  }
  return null;
}

export { isExplicitOperatorPublication, ATTACHMENT_FAILURE_NOTICE_PREFIX, attachmentFailureNoticeFence, definiteAttachmentProviderRejection, attachmentFailureKind };
