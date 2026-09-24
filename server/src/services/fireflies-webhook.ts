import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { badRequest, unauthorized } from "../errors.js";

/** Fireflies V2 signs the exact bytes, with no timestamp prefix. */
export function verifyFirefliesWebhook(input: {
  secret: string;
  signature?: string | null;
  rawBody?: Buffer | null;
  publicId: string;
}) {
  if (!input.rawBody || !/^sha256=[a-fA-F0-9]{64}$/.test(input.signature ?? "")) {
    throw unauthorized();
  }
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest();
  const provided = Buffer.from(input.signature!.slice(7), "hex");
  if (!timingSafeEqual(expected, provided)) throw unauthorized();

  let body: unknown;
  try {
    body = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    throw badRequest("Invalid Fireflies webhook JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Fireflies webhook payload must be an object");
  }
  const value = body as Record<string, unknown>;
  if (typeof value.event !== "string" || !value.event.trim() || value.event.length > 120
    || typeof value.meeting_id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value.meeting_id)
    || typeof value.timestamp !== "number" || !Number.isSafeInteger(value.timestamp)
    || value.timestamp <= 0 || !Number.isFinite(new Date(value.timestamp).getTime())
    || (value.client_reference_id != null && (typeof value.client_reference_id !== "string" || value.client_reference_id.length > 1024))) {
    throw badRequest("Fireflies webhook requires event, meeting_id, and a millisecond timestamp");
  }
  // Only authenticated meeting metadata becomes routine input. Provider extras
  // must not override routine variables or carry arbitrary task instructions.
  const payload = {
    event: value.event,
    meeting_id: value.meeting_id,
    timestamp: value.timestamp,
    ...(typeof value.client_reference_id === "string" ? { client_reference_id: value.client_reference_id } : {}),
  };
  return {
    payload,
    ignored: payload.event !== "meeting.summarized",
    // One summary-ready run per meeting and trigger, even when retry headers or
    // timestamps change. Do not expire legitimate delayed deliveries.
    idempotencyKey: `fireflies:${createHash("sha256")
      .update(JSON.stringify([input.publicId, payload.event, payload.meeting_id]))
      .digest("hex")}`,
  };
}
