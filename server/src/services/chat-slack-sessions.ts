import type { SafeChatPublicationPayload } from "@paperclipai/shared";

export type SlackSessionStatus =
  "processing" | "active" | "suspended" | "closed";

export interface SlackSessionStop {
  providerEventId: string;
  threadId: string;
  userId: string;
  eventTimestamp: string;
  occurredAt: Date;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const SLACK_TIMESTAMP = /^\d{1,12}\.\d{1,6}$/;
const SLACK_CHANNEL_ID = /^[CDG][A-Z0-9]+$/;

/** Parse only an already signature-verified Events API envelope. */
export function parseSlackSessionStop(
  payload: unknown,
  expectedWorkspaceId: string | null,
): SlackSessionStop | null {
  const envelope = record(payload);
  const event = record(envelope?.event);
  if (
    !expectedWorkspaceId ||
    envelope?.type !== "event_callback" ||
    envelope.team_id !== expectedWorkspaceId ||
    typeof envelope.event_id !== "string" ||
    !/^Ev[A-Za-z0-9_-]{1,180}$/.test(envelope.event_id) ||
    event?.type !== "agent_session_stopped" ||
    typeof event.channel !== "string" ||
    !SLACK_CHANNEL_ID.test(event.channel) ||
    typeof event.thread_ts !== "string" ||
    !SLACK_TIMESTAMP.test(event.thread_ts) ||
    typeof event.event_ts !== "string" ||
    !SLACK_TIMESTAMP.test(event.event_ts) ||
    typeof event.user !== "string" ||
    !/^[UW][A-Z0-9]+$/.test(event.user)
  ) {
    return null;
  }
  const occurredAt = new Date(Math.floor(Number(event.event_ts) * 1_000));
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() <= 0) {
    return null;
  }
  return {
    providerEventId: envelope.event_id,
    threadId: `slack:${event.channel}:${event.thread_ts}`,
    userId: event.user,
    eventTimestamp: event.event_ts,
    occurredAt,
  };
}

export function slackSessionStatusForPublication(
  payload: Pick<SafeChatPublicationPayload, "progressState">,
  completed: boolean,
): SlackSessionStatus {
  if (completed) return "closed";
  if (
    payload.progressState === "working" ||
    payload.progressState === "queued"
  ) {
    return "processing";
  }
  if (payload.progressState === "waiting_for_input") return "suspended";
  return "active";
}

const SAFE_SLACK_SESSION_ERRORS = new Set([
  "feature_disabled",
  "unknown_method",
  "method_not_supported_for_channel_type",
  "missing_scope",
  "not_authed",
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
]);

/**
 * Session status is an idempotent provider effect, independent of message
 * delivery. A failed status update must never cause a message to be reposted.
 * No provider-authored error text, token, or user content escapes this helper.
 */
export async function setSlackSessionStatus(input: {
  botToken: string;
  threadId: string;
  status: SlackSessionStatus;
  fetch?: typeof globalThis.fetch;
}): Promise<"updated" | "unavailable"> {
  const [, channelId, threadTs, extra] = input.threadId.split(":");
  if (
    !input.threadId.startsWith("slack:") ||
    !channelId ||
    !SLACK_CHANNEL_ID.test(channelId) ||
    !threadTs ||
    !SLACK_TIMESTAMP.test(threadTs) ||
    extra !== undefined ||
    !["processing", "active", "suspended", "closed"].includes(input.status)
  ) {
    throw Object.assign(
      new Error("Invalid Slack session destination or status"),
      {
        code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED",
      },
    );
  }
  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(
      "https://slack.com/api/agents.sessions.setStatus",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.botToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel_id: channelId,
          thread_ts: threadTs,
          status: input.status,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    // Reapplying status is safe even when this attempt may have succeeded.
    // Deliberately omit the fetch exception: it may contain request headers.
    throw Object.assign(
      new Error("Slack session status could not be confirmed"),
      {
        code: "chat_slack_session_transport_failed",
      },
    );
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = record(await response.json());
  } catch {
    // A non-JSON response is classified using only its status below.
  }
  if (response.ok && body?.ok === true) return "updated";
  const providerCode =
    typeof body?.error === "string" && SAFE_SLACK_SESSION_ERRORS.has(body.error)
      ? body.error
      : "unrecognized_error";
  if (
    response.ok &&
    [
      "feature_disabled",
      "unknown_method",
      "method_not_supported_for_channel_type",
    ].includes(providerCode)
  ) {
    return "unavailable";
  }
  const retryAfter = Number(response.headers.get("retry-after"));
  throw Object.assign(
    new Error(`Slack session status failed (${providerCode})`),
    {
      code: "chat_slack_session_status_failed",
      status: response.status,
      data: { error: providerCode },
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
    },
  );
}
