// Webhook signature verification helpers (SEC-WEBHOOK-002).
//
// Pure functions: easy to unit-test, no Express coupling.
//
// - verifyHmacSha256: Mailgun / generic HMAC-SHA256 webhooks (e.g. Mailgun "X-Mailgun-Signature-256").
// - verifySendgridSignature: SendGrid Inbound Parse signed webhooks use Ed25519 over `timestamp + payload`.

import crypto from "node:crypto";

/**
 * Verify an HMAC-SHA256 signature in `sha256=<hex>` or bare `<hex>` form.
 *
 * Mailgun's signed webhooks send `X-Mailgun-Signature-256` as a bare hex string,
 * but many integrators (and our own `/routine-triggers/public/:publicId/fire`)
 * use the `sha256=<hex>` convention. Both are accepted.
 *
 * Returns false (never throws) on any input shape we can't parse — callers
 * just need a yes/no, and throwing on attacker-controlled headers leaks signal.
 */
export function verifyHmacSha256(rawBody: Buffer, signature: string | null | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const normalized = signature.trim().replace(/^sha256=/i, "");
  if (!/^[0-9a-f]+$/i.test(normalized)) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (normalized.length !== expected.length) return false;

  // Both buffers are equal-length hex strings derived from headers/computation,
  // safe to feed into timingSafeEqual.
  try {
    return crypto.timingSafeEqual(Buffer.from(normalized, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify a SendGrid Event Webhook / Inbound Parse signature (Ed25519).
 *
 * SendGrid signs `timestamp + rawBody` with an Ed25519 private key; the public
 * key is exposed in their dashboard. Header names:
 *   - X-Twilio-Email-Event-Webhook-Signature  (base64 signature)
 *   - X-Twilio-Email-Event-Webhook-Timestamp  (unix seconds)
 *
 * `publicKeyPem` may be either a full PEM block or the base64 DER body that
 * SendGrid exposes in their UI; we wrap it in PEM headers if needed.
 */
export function verifySendgridSignature(
  rawBody: Buffer,
  timestamp: string | null | undefined,
  signature: string | null | undefined,
  publicKey: string,
): boolean {
  if (!timestamp || !signature || !publicKey) return false;

  const pem = publicKey.includes("BEGIN PUBLIC KEY")
    ? publicKey
    : `-----BEGIN PUBLIC KEY-----\n${publicKey.replace(/\s+/g, "")}\n-----END PUBLIC KEY-----`;

  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(signature, "base64");
  } catch {
    return false;
  }

  // Concatenate timestamp + rawBody as bytes — timestamp is ASCII per SendGrid spec.
  const message = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);

  try {
    // For Ed25519, algorithm parameter must be null; key handles the curve.
    const keyObject = crypto.createPublicKey(pem);
    return crypto.verify(null, message, keyObject, sigBuf);
  } catch {
    return false;
  }
}

/**
 * One-time startup warning helper — call at server boot to surface missing
 * env vars without spamming per-request logs.
 */
let warned = false;
export function warnIfWebhookSigningDisabledOnce(logger: { warn: (msg: string) => void }): void {
  if (warned) return;
  warned = true;
  const missing: string[] = [];
  if (!process.env.MAILGUN_WEBHOOK_SIGNING_KEY) missing.push("MAILGUN_WEBHOOK_SIGNING_KEY");
  if (!process.env.SENDGRID_WEBHOOK_PUBLIC_KEY) missing.push("SENDGRID_WEBHOOK_PUBLIC_KEY");
  if (missing.length === 0) return;
  logger.warn(
    `[email-bridge] email webhook signature verification disabled — set ${missing.join(" and/or ")} to enable provider signature checks (X-Mailgun-Signature-256 / X-Twilio-Email-Event-Webhook-Signature)`,
  );
}

/** Test-only: reset the once-warning latch. */
export function __resetWebhookSigningWarningForTests(): void {
  warned = false;
}
