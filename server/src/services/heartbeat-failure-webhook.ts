import { logger } from "../middleware/logger.js";

/**
 * Environment variable that configures the heartbeat failure notification
 * webhook URL (e.g. a Discord channel webhook). When set, a POST with a JSON
 * payload is sent to this URL each time a heartbeat run reaches a terminal
 * failure status.
 */
const WEBHOOK_URL_ENV_KEY = "PAPERCLIP_HEARTBEAT_FAILURE_WEBHOOK_URL";

/**
 * Payload sent to the configured webhook when a heartbeat run fails.
 */
export interface HeartbeatFailurePayload {
  /** The event type — always "heartbeat.failed" for discrimination. */
  event: "heartbeat.failed";
  /** ISO-8601 timestamp of when the failure was recorded. */
  timestamp: string;
  runId: string;
  agentId: string;
  agentName: string | null;
  companyId: string;
  errorCode: string | null;
  error: string | null;
  /** The last known run status before the terminal failure. */
  previousStatus: string | null;
}

/**
 * Send a heartbeat failure notification to the configured webhook URL.
 *
 * This is fire-and-forget: the caller's error handling never sees a rejection
 * from this function. Errors calling the webhook are logged as warnings and
 * swallowed.
 */
export async function notifyHeartbeatFailure(
  payload: HeartbeatFailurePayload,
): Promise<void> {
  const webhookUrl = readWebhookUrl();
  if (!webhookUrl) return;

  try {
    const body = JSON.stringify(payload);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Paperclip-Heartbeat/1.0",
      },
      body,
    });

    if (!response.ok) {
      logger.warn(
        {
          webhookStatus: response.status,
          webhookStatusText: response.statusText,
          runId: payload.runId,
          errorCode: payload.errorCode,
        },
        "heartbeat failure webhook returned non-2xx status",
      );
    }
  } catch (err) {
    logger.warn(
      { err, runId: payload.runId, errorCode: payload.errorCode },
      "failed to send heartbeat failure webhook notification",
    );
  }
}

/**
 * Read the configured webhook URL from the environment.
 * Returns `null` when not set, so callers can skip notification.
 */
function readWebhookUrl(): string | null {
  const url = process.env[WEBHOOK_URL_ENV_KEY]?.trim();
  return url && url.length > 0 ? url : null;
}
