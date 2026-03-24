import { createHmac, timingSafeEqual } from "node:crypto";

const FIVE_MINUTES_S = 5 * 60;

/**
 * Verifies a Slack request signature using HMAC-SHA256.
 *
 * Slack signs every request with `X-Slack-Signature` and
 * `X-Slack-Request-Timestamp`. We verify both to prevent replay attacks.
 *
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(
  signature: string,
  timestamp: string,
  rawBody: string,
  signingSecret: string,
): boolean {
  if (!signature || !timestamp || !signingSecret) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;

  // Reject requests older than 5 minutes (replay prevention)
  if (Math.abs(Date.now() / 1000 - ts) > FIVE_MINUTES_S) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(sigBase).digest("hex")}`;

  try {
    return timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}
