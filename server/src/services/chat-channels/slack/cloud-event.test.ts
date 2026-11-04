import { guardSlackFixtureNetwork, stubSlackFixtureTransport } from "./cloud-test-transport.js";
import { createHmac, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifySlackSignature } from "@chat-adapter/slack/webhook";
import { createChatSdkEndpointRuntime } from "../../chat-sdk-runtime.js";
import { receiveSlackCloudEvent, slackCloudAcceptedAt, type CurrentSlackCloudBinding, type SlackCloudEvent } from "./cloud-event.js";

const acceptedAt = Date.parse("2099-01-01T00:00:00Z");
function fixture() {
  const binding: CurrentSlackCloudBinding = { companyId: "company", endpointId: "endpoint", publicId: "a".repeat(43),
    connectionId: "connection", runtimeGeneration: 1, teamId: "TTEST", appId: "ATEST", bindingId: `slack-event:${"b".repeat(64)}`,
    signingSecret: "0123456789abcdef0123456789abcdef" };
  const rawBody = Buffer.from(JSON.stringify({ type: "event_callback", event_id: "EvFIRST", team_id: "TTEST", api_app_id: "ATEST", event: { type: "app_mention", text: "<@UBOT> hello", user: "UOPERATOR", channel: "CTEST", ts: "1788.500", event_ts: "1788.500" } }));
  const timestamp = String(acceptedAt / 1000);
  const signature = `v0=${createHmac("sha256", binding.signingSecret).update(`v0:${timestamp}:`).update(rawBody).digest("hex")}`;
  const { signingSecret: _secret, ...identity } = binding;
  const event: SlackCloudEvent = { id: `slack_${"b".repeat(64)}_${createHash("sha256").update("EvFIRST").digest("hex")}`,
    provider: "slack", event: "event_callback", installationId: binding.bindingId, bindingIds: [binding.bindingId],
    createdAt: new Date(acceptedAt).toISOString(), payload: { slackEvent: { version: 1, ...identity,
      rawBody: rawBody.toString("base64"), timestamp, signature, eventId: "EvFIRST", acceptedAt: new Date(acceptedAt).toISOString() } } };
  return { binding, event, rawBody, timestamp, signature };
}

describe("authenticated Slack Cloud receipt consumer", () => {
  it("crosses the real pinned Chat runtime after cold-start delay and preserves ordinary external freshness rejection", async () => {
    const network = guardSlackFixtureNetwork();
    const f = fixture(), onMessage = vi.fn(async () => {});
    const runtime = createChatSdkEndpointRuntime({ companyId: f.binding.companyId, endpointId: f.binding.endpointId,
      logger: "silent", callbacks: { onMessage }, persistence: { read: async () => null,
        compareAndSet: async () => true, deleteIfVersion: async () => true },
      providerConfig: { provider: "slack", userName: "paperclip-agent",
        credentials: { apiUrl: "http://127.0.0.1:1/api/", botToken: "xoxb-synthetic", botUserId: "UBOT", signingSecret: f.binding.signingSecret } } });
    try {
      await runtime.initialize();
      const transport = stubSlackFixtureTransport(runtime.getProviderAdapter());
      await receiveSlackCloudEvent(f.event, f.binding, request => runtime.handleWebhook(request), acceptedAt + 600_000);
      expect(onMessage).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalled();
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ provider: "slack", endpointId: f.binding.endpointId }));
      const response = await runtime.handleWebhook(new Request("https://external.invalid", { method: "POST",
        headers: { "content-type": "application/json", "x-slack-request-timestamp": f.timestamp, "x-slack-signature": f.signature },
        body: new Uint8Array(f.rawBody) }));
      expect(response.status).toBe(401);
      expect(onMessage).toHaveBeenCalledOnce();
    } finally {
      await runtime.shutdown();
      try { network.assertQuiet(); } finally { network.restore(); }
    }
  });
  it("replays original evidence after a cold-start delay without refreshing its timestamp", async () => {
    const f = fixture();
    let delivered: Request | undefined;
    await receiveSlackCloudEvent(f.event, f.binding, async request => {
      delivered = request;
      expect(slackCloudAcceptedAt(request)).toBe(acceptedAt);
      expect(request.headers.get("x-slack-request-timestamp")).toBe(f.timestamp);
      expect(request.headers.get("x-slack-signature")).toBe(f.signature);
      const body = await request.text();
      expect(body).toBe(f.rawBody.toString());
      // Exercise the pinned adapter's actual signature verifier with the same
      // request-local acceptance clock used by the production runtime.
      await verifySlackSignature(body, request.headers, { signingSecret: f.binding.signingSecret,
        now: () => slackCloudAcceptedAt(request) ?? acceptedAt + 600_000 });
      await expect(verifySlackSignature(body, request.headers, { signingSecret: f.binding.signingSecret,
        now: () => acceptedAt + 600_000 })).rejects.toThrow("too old");
      return new Response("durably accepted");
    }, acceptedAt + 600_000);
    expect(slackCloudAcceptedAt(delivered!)).toBeUndefined();
    expect(slackCloudAcceptedAt(new Request("https://external.invalid"))).toBeUndefined();
  });

  it("ignores removed or superseded generations without invoking product admission", async () => {
    const f = fixture(), handler = vi.fn();
    await receiveSlackCloudEvent(f.event, null, handler, acceptedAt);
    await receiveSlackCloudEvent(f.event, { ...f.binding, runtimeGeneration: 2 }, handler, acceptedAt);
    expect(handler).not.toHaveBeenCalled();
  });

  it("retains current work on signature/body/receipt-time failure and on failed durable admission", async () => {
    const f = fixture(), handler = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(receiveSlackCloudEvent(f.event, f.binding, handler, acceptedAt)).rejects.toThrow("not been durably accepted");
    await expect(receiveSlackCloudEvent(f.event, { ...f.binding, signingSecret: "rotated" }, handler, acceptedAt)).rejects.toThrow("signature");
    await expect(receiveSlackCloudEvent({ ...f.event, createdAt: new Date(acceptedAt + 600_000).toISOString() }, f.binding, handler, acceptedAt)).rejects.toThrow("acceptance time");
    await expect(receiveSlackCloudEvent(f.event, f.binding, handler, acceptedAt + 31 * 24 * 60 * 60_000)).rejects.toThrow("acceptance time");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
