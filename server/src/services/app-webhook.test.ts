import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAppWebhook } from "./app-webhook.js";

const secret = "app-signing-secret";
const base = { secret, publicId: "trigger-1" };
function signed(payload: unknown) {
  const rawBody = Buffer.from(JSON.stringify(payload, null, 2));
  return { ...base, rawBody, signature: `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
}

describe("shared app webhook authentication", () => {
  it("accepts bearer authentication without requiring a provider", () => {
    expect(verifyAppWebhook({ ...base, authorization: `Bearer ${secret}` })).toBeNull();
    expect(() => verifyAppWebhook({ ...base, authorization: "Bearer wrong" })).toThrow();
    expect(() => verifyAppWebhook(base)).toThrow();
  });
  it("accepts arbitrary signed app events and derives a retry key", () => {
    const event = { event: "deployment.completed", deployment_id: "d-1", meeting_id: "unrelated-reference" };
    const input = signed(event);
    const result = verifyAppWebhook(input)!;
    expect(result).toMatchObject({ payload: event, ignored: false, meetingMetadata: false });
    expect(verifyAppWebhook(input)?.idempotencyKey).toBe(result.idempotencyKey);
    expect(verifyAppWebhook({ ...input, publicId: "trigger-2" })?.idempotencyKey).not.toBe(result.idempotencyKey);
    expect(verifyAppWebhook({ ...input, idempotencyKey: "delivery-123" })?.idempotencyKey).toBe("delivery-123");
  });
  it.each(["", "sha256=bad", `sha256=${"0".repeat(64)}`])("rejects invalid signature %s even with a bearer token", (signature) => {
    expect(() => verifyAppWebhook({ ...signed({}), signature, authorization: `Bearer ${secret}` })).toThrow();
  });
  it("rejects changed bodies, missing raw bytes, and the old secret after rotation", () => {
    const input = signed({ event: "deployment.completed" });
    expect(() => verifyAppWebhook({ ...input, rawBody: Buffer.from("{}") })).toThrow();
    expect(() => verifyAppWebhook({ ...input, rawBody: null })).toThrow();
    expect(() => verifyAppWebhook({ ...input, secret: "replacement" })).toThrow();
  });
  it.each([[], null, "string"])("rejects signed non-object payload %#", (payload) => {
    expect(() => verifyAppWebhook(signed(payload))).toThrow("must be an object");
  });
  it.each([
    { event: "meeting.summarized", meeting_id: "meeting-1", timestamp: 1780000000000 },
    { event: "meeting.created", id: "another-provider-meeting" },
    { event: "meeting.transcribed" },
  ])("treats meeting events as generic app data %#", (payload) => {
    const input = signed(payload);
    const result = verifyAppWebhook(input);
    expect(result).toMatchObject({ payload, ignored: false, meetingMetadata: false });
    expect(verifyAppWebhook(input)?.idempotencyKey).toBe(result?.idempotencyKey);
  });
});
