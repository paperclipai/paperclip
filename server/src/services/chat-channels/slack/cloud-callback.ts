import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { SlackCloudReceiptError, withSlackCloudAcceptedAt, type CurrentSlackCloudBinding, type SlackCloudEvent } from "./cloud-event.js";

const deferred = new AsyncLocalStorage<boolean>();
export const slackDeferredCallbackActive = () => deferred.getStore() === true;
export async function receiveSlackCloudCallback(event: SlackCloudEvent, current: (CurrentSlackCloudBinding & { instanceId: string; environment: string }) | null,
  handleWebhook: (request: Request) => Promise<Response>, now = Date.now()): Promise<void> {
  if (!current) return;
  const raw = event.payload.slackCallback;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SlackCloudReceiptError("callback_packet_invalid", "invalid");
  const packet = raw as Record<string, unknown>;
  const expectedKeys = ["version", "lane", "teamId", "appId", "userId", "channelId", "instanceId", "environment", "bindingId", "companyId", "endpointId", "publicId", "connectionId", "runtimeGeneration", "acceptedAt", "timestamp", "signature", "rawBody"];
  if (Object.keys(packet).sort().join() !== expectedKeys.sort().join() || packet.version !== 1 || event.provider !== "slack"
    || !["command", "action"].includes(String(packet.lane)) || event.event !== packet.lane)
    throw new SlackCloudReceiptError("callback_packet_invalid", "invalid");
  if (["companyId", "endpointId", "publicId", "connectionId", "runtimeGeneration", "teamId", "appId", "bindingId", "instanceId", "environment"].some(key => packet[key] !== Reflect.get(current, key))) return;
  if (event.installationId !== current.bindingId || event.bindingIds.length !== 1 || event.bindingIds[0] !== current.bindingId
    || typeof packet.timestamp !== "string" || !/^[0-9]{1,16}$/.test(packet.timestamp)
    || typeof packet.signature !== "string" || !/^v0=[a-f0-9]{64}$/.test(packet.signature)
    || typeof packet.rawBody !== "string" || packet.rawBody.length > 1_398_104 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packet.rawBody))
    throw new SlackCloudReceiptError("callback_packet_invalid", "invalid");
  const acceptedAt = Date.parse(event.createdAt);
  if (packet.acceptedAt !== event.createdAt || !Number.isFinite(acceptedAt) || acceptedAt > now + 300_000 || now - acceptedAt >= 30 * 24 * 60 * 60_000
    || Math.abs(Math.floor(acceptedAt / 1000) - Number(packet.timestamp)) > 300)
    throw new SlackCloudReceiptError("callback_acceptance_invalid", "attention");
  const body = Buffer.from(packet.rawBody, "base64");
  if (body.byteLength > 1_048_576) throw new SlackCloudReceiptError("callback_packet_invalid", "invalid");
  const digest = createHash("sha256").update(JSON.stringify([current.bindingId, packet.timestamp, packet.rawBody])).digest("hex");
  if (event.id !== `slack_callback_${digest}` || !timingSafeEqual(createHmac("sha256", current.signingSecret).update(`v0:${packet.timestamp}:`).update(body).digest(), Buffer.from(packet.signature.slice(3), "hex")))
    throw new SlackCloudReceiptError("callback_original_authentication_failed", "attention");
  const params = new URLSearchParams(body.toString("utf8"));
  for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new SlackCloudReceiptError("callback_duplicate_field", "invalid");
  if (packet.lane === "command") {
    if (params.has("payload") || !/^\/[A-Za-z0-9_-]{1,32}$/.test(params.get("command") ?? "") || !params.get("trigger_id") || !params.has("text")
      || params.get("team_id") !== current.teamId || params.get("api_app_id") !== current.appId || params.get("user_id") !== packet.userId || params.get("channel_id") !== packet.channelId)
      throw new SlackCloudReceiptError("callback_original_identity_changed", "invalid");
  } else {
    let payload: unknown;
    try { payload = JSON.parse(params.get("payload") ?? "null"); } catch { throw new SlackCloudReceiptError("callback_original_invalid", "invalid"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || [...params.keys()].join() !== "payload") throw new SlackCloudReceiptError("callback_original_invalid", "invalid");
    const actions = Reflect.get(payload, "actions");
    const field = (key: string) => { const value = Reflect.get(payload, key); return value && typeof value === "object" ? Reflect.get(value, "id") : undefined; };
    if (Reflect.get(payload, "type") !== "block_actions" || Reflect.get(payload, "api_app_id") !== current.appId || field("team") !== current.teamId || field("user") !== packet.userId || field("channel") !== packet.channelId
      || !Array.isArray(actions) || actions.length !== 1 || !actions[0] || typeof actions[0] !== "object"
      || typeof Reflect.get(actions[0], "action_id") !== "string" || !Reflect.get(actions[0], "action_id") || String(Reflect.get(actions[0], "action_id")).length > 255 || String(Reflect.get(actions[0], "action_id")).startsWith("pcf:"))
      throw new SlackCloudReceiptError("callback_trigger_owner_required", "attention");
  }
  const request = new Request("https://paperclip.invalid/slack-cloud-ingress", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": packet.timestamp, "x-slack-signature": packet.signature }, body: new Uint8Array(body) });
  await deferred.run(true, () => withSlackCloudAcceptedAt(request, acceptedAt, async () => {
    const response = await handleWebhook(request);
    await response.body?.cancel();
    if (!response.ok) throw new SlackCloudReceiptError("callback_unaccepted", "retry");
  }));
}
