import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { badRequest, unauthorized } from "../errors.js";

/** Generic app setup supports either custom Authorization or a signing secret. */
export function verifyAppWebhook(input: {
  secret: string;
  publicId: string;
  authorization?: string | null;
  signature?: string | null;
  rawBody?: Buffer | null;
  idempotencyKey?: string | null;
}) {
  // A supplied signature must be valid; do not fall back to bearer on failure.
  if (input.signature != null) {
    if (!input.rawBody || !/^sha256=[a-fA-F0-9]{64}$/.test(input.signature)) throw unauthorized();
    const expected = createHmac("sha256", input.secret).update(input.rawBody).digest();
    const provided = Buffer.from(input.signature.slice(7), "hex");
    if (!timingSafeEqual(expected, provided)) throw unauthorized();
    let value: unknown;
    try { value = JSON.parse(input.rawBody.toString("utf8")); }
    catch { throw badRequest("Invalid webhook JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("Webhook payload must be an object");
    const payload = value as Record<string, unknown>;
    return {
      payload, ignored: false, meetingMetadata: false,
      idempotencyKey: input.idempotencyKey ?? `app-webhook:${createHash("sha256")
        .update(input.publicId).update(":").update(input.rawBody).digest("hex")}`,
    };
  }
  const expected = Buffer.from(`Bearer ${input.secret}`);
  const provided = Buffer.from(input.authorization?.trim() ?? "");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw unauthorized();
  return null;
}
