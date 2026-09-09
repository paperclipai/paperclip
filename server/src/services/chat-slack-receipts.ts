/** Noncritical acknowledgement I/O must not occupy the endpoint's credential
 * fence for the ordinary message API's 45-second timeout. There is no retry
 * here: the durable receipt action owns retry and idempotent reconciliation. */
export const SLACK_RECEIPT_TIMEOUT_MS = 2_000;

export interface SlackReceiptMutation {
  operation: "add" | "remove";
  threadId: string;
  messageId: string;
  reaction: "eyes";
}

const SAFE_ERRORS = new Set([
  "already_reacted",
  "no_reaction",
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "not_authed",
  "account_inactive",
  "missing_scope",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "message_not_found",
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "not_reactable",
  "too_many_reactions",
  "too_many_emoji",
  "thread_locked",
  "no_permission",
  "access_denied",
  "ekm_access_denied",
]);

function unavailable() {
  return Object.assign(
    new Error("Slack receipt reaction could not be confirmed"),
    {
      name: "NetworkError",
      code: "chat_slack_receipt_transport_failed",
    },
  );
}

/** Caller retains its current credential lease until this promise settles.
 * Fetch's abort is awaited, including response-body consumption; a timeout
 * never races past still-running local I/O. Remote acceptance may be unknown. */
export async function applySlackReceiptReaction(
  input: SlackReceiptMutation & { botToken: string },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const parts = input.threadId.split(":");
  if (
    parts[0] !== "slack" ||
    !/^[CDG][A-Z0-9]+$/.test(parts[1] ?? "") ||
    parts.length < 2 ||
    parts.length > 3 ||
    (parts[2] !== undefined && !/^\d{1,12}\.\d{1,6}$/.test(parts[2])) ||
    !/^\d{1,12}\.\d{1,6}$/.test(input.messageId) ||
    !["add", "remove"].includes(input.operation) ||
    input.reaction !== "eyes" ||
    !input.botToken ||
    /[\r\n]/.test(input.botToken)
  ) {
    throw Object.assign(new Error("Invalid Slack receipt destination"), {
      code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED",
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_RECEIPT_TIMEOUT_MS);
  let response: Response;
  let body: Record<string, unknown> | null = null;
  try {
    response = await fetchImpl(
      `https://slack.com/api/reactions.${input.operation}`,
      {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${input.botToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: parts[1],
          timestamp: input.messageId,
          name: "eyes",
        }),
      },
    );
    const reader = response.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 8_192) {
            controller.abort();
            await reader.cancel();
            throw unavailable();
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      try {
        const parsed: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          body = parsed as Record<string, unknown>;
      } catch {
        /* Only HTTP status and closed error codes survive malformed replies. */
      }
    }
    controller.signal.throwIfAborted();
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timer);
  }
  if (response.ok && body?.ok === true) return;
  const error =
    typeof body?.error === "string" &&
    SAFE_ERRORS.has(body.error) &&
    (body.error !== "already_reacted" || (response.ok && body.ok === false))
      ? body.error
      : "unrecognized_error";
  if (
    response.ok &&
    body?.ok === false &&
    input.operation === "remove" &&
    error === "no_reaction"
  )
    return;
  if (response.ok && (!body || typeof body.ok !== "boolean"))
    throw unavailable();
  const retryAfter = response.headers.get("retry-after");
  throw Object.assign(new Error(`Slack receipt reaction failed (${error})`), {
    code: response.ok
      ? "slack_webapi_platform_error"
      : "slack_webapi_http_error",
    data: { error },
    status: response.status,
    response: {
      status: response.status,
      headers:
        retryAfter && /^\d{1,10}(?:\.\d{1,3})?$/.test(retryAfter)
          ? { "retry-after": retryAfter }
          : {},
    },
  });
}
