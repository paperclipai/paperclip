import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySpekoToolRequest, spekoToolDefinitions } from "../services/voice/speko-protocol.js";
const now = Date.parse("2026-09-12T20:00:00Z");
const secret = `whsec_${randomBytes(32).toString("base64")}`;
function signed(value: unknown = { session_id: "s1", tool_call_id: "t1", idempotency_key: "s1:t1", tool: "submit_request", args: { text: "Please check the shipment" } }, offset = 0, key = secret) {
  const body = Buffer.from(JSON.stringify(value)), timestamp = String(now / 1000 + offset), webhookId = "s1:t1";
  const signature = createHmac("sha256", Buffer.from(key.slice(6), "base64")).update(`${webhookId}.${timestamp}.`).update(body).digest("base64");
  return { body, headers: { "webhook-id": webhookId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` }, keys: [{ secret }], now };
}
describe("Speko signed tool protocol", () => {
  it("verifies original bytes and returns identities for durable replay checks", () => {
    expect(verifySpekoToolRequest(signed())).toMatchObject({ webhookId: "s1:t1", envelope: { session_id: "s1", tool_call_id: "t1" } });
    const tampered = signed(); tampered.body = Buffer.from(tampered.body.toString().replace("shipment", "payroll")); expect(() => verifySpekoToolRequest(tampered)).toThrow("invalid_signature");
  });
  it("accepts the provider's session:tool delivery id and multiple signatures", () => {
    const request = signed();
    request.headers["webhook-signature"] = `v1,${Buffer.alloc(32).toString("base64")} ${request.headers["webhook-signature"]}`;
    expect(verifySpekoToolRequest(request).webhookId).toBe("s1:t1");
  });
  it.each([-301, 301])("rejects a timestamp outside the replay window: %s seconds", (offset) => { expect(() => verifySpekoToolRequest(signed(undefined, offset))).toThrow("invalid_signature"); });
  it("accepts a rotation grace key only before its deadline", () => {
    const request = signed(); const current = `whsec_${randomBytes(32).toString("base64")}`;
    expect(() => verifySpekoToolRequest({ ...request, keys: [{ secret: current }, { secret, validUntil: new Date(now + 1) }] })).not.toThrow();
    expect(() => verifySpekoToolRequest({ ...request, keys: [{ secret: current }, { secret, validUntil: new Date(now) }] })).toThrow("invalid_signature");
  });
  it("rejects ambiguous repeated headers and oversized payloads", () => {
    const request = signed(); expect(() => verifySpekoToolRequest({ ...request, headers: { ...request.headers, "webhook-id": ["msg_1", "msg_2"] } })).toThrow("invalid_signature");
    expect(() => verifySpekoToolRequest({ ...request, body: Buffer.alloc(65537) })).toThrow("body_too_large");
  });
  it.each([
    { tool: "approve_action", args: {} },
    { tool: "submit_request", args: { text: "ok", taskId: "another-task" } },
    { tool: "get_updates", args: { cursor: -1 } },
    { tool: "get_updates", args: { cursor: 0.5 } },
    { tool: "submit_request", args: { text: "  " } },
  ])("rejects unauthorized tool shapes $tool $args", (operation) => {
    expect(() => verifySpekoToolRequest(signed({ session_id: "s1", tool_call_id: "t1", idempotency_key: "s1:t1", ...operation }))).toThrow("invalid_envelope");
  });
  it("does not allow caller-supplied idempotency to substitute another session", () => {
    expect(() => verifySpekoToolRequest(signed({ session_id: "s1", tool_call_id: "t1", idempotency_key: "s2:t1", tool: "get_updates", args: { cursor: 0 } }))).toThrow("invalid_envelope");
  });
  it("keeps tool waits below the provider timeout and requires HTTPS", () => {
    expect(spekoToolDefinitions("https://paperclip.example/api/voice/callback").every((tool) => tool.source.timeoutMs < 4000)).toBe(true);
    expect(() => spekoToolDefinitions("http://localhost:3100/callback")).toThrow("HTTPS");
  });
});
