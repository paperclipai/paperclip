import { guardSlackFixtureNetwork, stubSlackFixtureTransport } from "../../../__tests__/helpers/slack-cloud/transport.js";
import { verifySlackSignature } from "@chat-adapter/slack/webhook";
import type { ChatSdkRuntimeCallbacks } from "../../chat-sdk-runtime.js";
import { createChatSdkEndpointRuntime } from "../../chat-sdk-runtime.js";
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { receiveSlackCloudCallback, slackDeferredCallbackActive } from "./cloud-callback.js";
import { slackCloudAcceptedAt, type SlackCloudEvent } from "./cloud-event.js";
const acceptedAt = Date.parse("2099-01-01T00:00:00Z");
function fixture(lane: "command" | "action" = "command") {
  const current = { instanceId: "instance", environment: "test", companyId: "company", endpointId: "endpoint", connectionId: "connection", publicId: "a".repeat(43), runtimeGeneration: 1,
    teamId: "TTEST", appId: "ATEST", bindingId: `slack-event:${"b".repeat(64)}`, signingSecret: "0123456789abcdef0123456789abcdef" };
  const body = lane === "command" ? new URLSearchParams({ command: "/paperclip", text: "useful original task", trigger_id: "original-one-use-trigger", team_id: "TTEST", api_app_id: "ATEST", user_id: "UTEST", channel_id: "CTEST", response_url: "https://hooks.slack.com/commands/controlled" }).toString()
    : new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", api_app_id: "ATEST", team: { id: "TTEST" }, user: { id: "UTEST" }, channel: { id: "CTEST" }, actions: [{ action_id: "opaque-confirmation", action_ts: "4070908800.000001" }], trigger_id: "original-one-use-trigger" }) }).toString();
  const rawBody = Buffer.from(body).toString("base64"), timestamp = String(Math.floor(acceptedAt / 1000));
  const signature = `v0=${createHmac("sha256", current.signingSecret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;
  const { signingSecret: _secret, ...identity } = current;
  const event: SlackCloudEvent = { id: `slack_callback_${createHash("sha256").update(JSON.stringify([current.bindingId, timestamp, rawBody])).digest("hex")}`, provider: "slack", event: lane,
    installationId: current.bindingId, bindingIds: [current.bindingId], createdAt: new Date(acceptedAt).toISOString(), payload: { slackCallback: { version: 1, ...identity, lane, userId: "UTEST", channelId: "CTEST", acceptedAt: new Date(acceptedAt).toISOString(), rawBody, timestamp, signature } } };
  return { current, event, body };
}
describe("deferred Slack command and action custody", () => {
  it.each(["command", "action"] as const)("preserves original %s bytes and authentication while awaiting actual callback completion", async lane => {
    const f = fixture(lane); let completed = false;
    await receiveSlackCloudCallback(f.event, f.current, async request => {
      expect(slackDeferredCallbackActive()).toBe(true); expect(slackCloudAcceptedAt(request)).toBe(acceptedAt);
      expect(await request.text()).toBe(f.body); expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
      await Promise.resolve(); completed = true; return new Response(null, { status: 200 });
    }, acceptedAt + 3500);
    expect(completed).toBe(true); expect(slackDeferredCallbackActive()).toBe(false);
  });
  it("does not acknowledge unaccepted or failed callback work", async () => {
    const f = fixture();
    await expect(receiveSlackCloudCallback(f.event, f.current, async () => new Response(null, { status: 503 }), acceptedAt)).rejects.toMatchObject({ disposition: "retry" });
    const original = new Error("actual admission failed");
    await expect(receiveSlackCloudCallback(f.event, f.current, async () => { throw original; }, acceptedAt)).rejects.toBe(original);
    expect(slackDeferredCallbackActive()).toBe(false);
  });
  it("rejects forged original authentication and foreign instance without invoking the SDK", async () => {
    const f = fixture(), handler = vi.fn(async () => new Response(null, { status: 200 }));
    const packet = f.event.payload.slackCallback as Record<string, unknown>;
    packet.signature = "v0=" + "0".repeat(64);
    await expect(receiveSlackCloudCallback(f.event, f.current, handler, acceptedAt)).rejects.toMatchObject({ disposition: "attention" });
    const foreign = fixture();
    await receiveSlackCloudCallback(foreign.event, { ...foreign.current, instanceId: "foreign" }, handler, acceptedAt);
    expect(handler).not.toHaveBeenCalled();
  });
  it("does not accept a callback profile as a view submission or options response owner", async () => {
    const f = fixture(), handler = vi.fn(async () => new Response(null, { status: 200 }));
    f.event.event = "view_submission";
    await expect(receiveSlackCloudCallback(f.event, f.current, handler, acceptedAt)).rejects.toMatchObject({ disposition: "invalid" });
    expect(handler).not.toHaveBeenCalled();
  });
  it("crosses the actual registered Slash SDK owner and refuses ordinary expired external evidence", async () => {
    const network = guardSlackFixtureNetwork(), f = fixture();
    let runtime: ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
    let primary: unknown;
    try {
      const slash: NonNullable<ChatSdkRuntimeCallbacks["onSlashCommand"]> = async event => {
        await event.event.channel.postEphemeral(event.event.user, { markdown: "Useful normal bot notice" }, { fallbackToDM: false });
      };
      const onSlashCommand = vi.fn(slash);
      runtime = createChatSdkEndpointRuntime({ companyId: f.current.companyId, endpointId: f.current.endpointId, logger: "silent",
        callbacks: { onMessage: async () => {}, onSlashCommand }, persistence: { read: async () => null, compareAndSet: async () => true, deleteIfVersion: async () => true },
        providerConfig: { provider: "slack", userName: "paperclip-agent", credentials: { apiUrl: "http://127.0.0.1:1/api/", botToken: "xoxb-synthetic", botUserId: "UBOT", signingSecret: f.current.signingSecret } } });
      await runtime.initialize();
      const transport = stubSlackFixtureTransport(runtime.getProviderAdapter());
      const delegate = transport.getMockImplementation();
      if (!delegate) throw new Error("Slack fixture transport is missing");
      let notices = 0;
      transport.mockImplementation(async config => {
        const url = new URL(config.url, config.baseURL);
        if (url.hostname === "127.0.0.1" && url.pathname.endsWith("/chat.postEphemeral")) {
          notices++;
          const body = new URLSearchParams(String(Reflect.get(config, "data")));
          expect(body.get("channel")).toBe("CTEST"); expect(body.get("user")).toBe("UTEST");
          expect(body.has("response_url")).toBe(false);
          return { data: { ok: true, message_ts: "1.2" }, status: 200, statusText: "OK", headers: {}, config, request: { path: url.pathname } };
        }
        return delegate(config);
      });
      const owner = runtime;
      await receiveSlackCloudCallback(f.event, f.current, request => owner.handleWebhook(request), acceptedAt + 31 * 60_000);
      expect(notices).toBe(1);
      expect(onSlashCommand).toHaveBeenCalledOnce();
      expect(onSlashCommand).toHaveBeenCalledWith(expect.objectContaining({ endpointId: f.current.endpointId, provider: "slack",
        event: expect.objectContaining({ command: "/paperclip", text: "useful original task", triggerId: "original-one-use-trigger" }) }));
      await transport.assertNoErrors();
      const packet = f.event.payload.slackCallback as Record<string, unknown>;
      await expect(verifySlackSignature(f.body, new Headers({ "x-slack-request-timestamp": String(packet.timestamp), "x-slack-signature": String(packet.signature) }),
        { signingSecret: f.current.signingSecret, now: () => acceptedAt + 31 * 60_000 })).rejects.toThrow("too old");
      const response = await runtime.handleWebhook(new Request("https://external.invalid", { method: "POST", body: f.body,
        headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": String(packet.timestamp), "x-slack-signature": String(packet.signature) } }));
      expect(response.status).toBe(401); expect(onSlashCommand).toHaveBeenCalledOnce();
    } catch (error) { primary = error; throw error; }
    finally {
      const failures: unknown[] = [];
      try { await runtime?.shutdown(); } catch (error) { failures.push(error); }
      try { network.assertQuiet(); } catch (error) { failures.push(error); }
      try { network.restore(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(primary === undefined ? failures : [primary, ...failures], "Slack registered callback cleanup failed");
    }
  });

});
