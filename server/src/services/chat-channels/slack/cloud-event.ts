import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Request-local proof, never a caller-controlled HTTP header. Only the sealed
 * connector event consumer below creates it after current-generation checks. */
const acceptedTimes = new WeakMap<Request, number>();
export const slackCloudAcceptedAt = (request: Request): number | undefined => acceptedTimes.get(request);

export interface SlackCloudEvent {
  id: string;
  provider: string;
  event: string;
  installationId: string | null;
  bindingIds: string[];
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface CurrentSlackCloudBinding {
  companyId: string;
  endpointId: string;
  publicId: string;
  connectionId: string;
  runtimeGeneration: number;
  teamId: string;
  appId: string;
  bindingId: string;
  signingSecret: string;
}

/** Called only after the existing connector sealed envelope has authenticated
 * the event. The caller snapshots the current binding under its credential
 * lease and passes that exact generation to the normal admission fence.
 * Return for a stale binding (safe to acknowledge); throw for malformed or
 * unaccepted current work so the broker retains its leased delivery for retry. */
export async function receiveSlackCloudEvent(event: SlackCloudEvent, current: CurrentSlackCloudBinding | null,
  handleWebhook: (request: Request) => Promise<Response>, now = Date.now()): Promise<void> {
  if (!current) return;
  const value = event.payload.slackEvent;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Slack Cloud receipt");
  const packet = value as Record<string, unknown>;
  if (event.provider !== "slack" || event.event !== "event_callback" || packet.version !== 1)
    throw new Error("Unsupported Slack Cloud receipt");
  if (packet.bindingId !== current.bindingId || packet.companyId !== current.companyId
    || packet.endpointId !== current.endpointId || packet.publicId !== current.publicId
    || packet.connectionId !== current.connectionId || packet.runtimeGeneration !== current.runtimeGeneration
    || packet.teamId !== current.teamId || packet.appId !== current.appId) return;
  if (event.installationId !== current.bindingId || !event.bindingIds.includes(current.bindingId)
    || typeof packet.rawBody !== "string" || packet.rawBody.length > 1_398_104
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packet.rawBody)
    || typeof packet.timestamp !== "string" || !/^[0-9]{1,16}$/.test(packet.timestamp)
    || typeof packet.signature !== "string" || !/^v0=[a-f0-9]{64}$/.test(packet.signature))
    throw new Error("Invalid Slack Cloud receipt");
  const acceptedAt = Date.parse(event.createdAt);
  // Cloud's authenticated receipt attests freshness at original acceptance.
  // A retry does not renew the 30-day durable transport recovery horizon.
  if (packet.acceptedAt !== event.createdAt || !Number.isFinite(acceptedAt) || acceptedAt > now + 300_000 || now - acceptedAt >= 30 * 24 * 60 * 60_000
    || Math.abs(Math.floor(acceptedAt / 1000) - Number(packet.timestamp)) > 300)
    throw new Error("Invalid Slack Cloud acceptance time");
  const body = Buffer.from(packet.rawBody, "base64");
  if (body.byteLength > 1_048_576) throw new Error("Slack Cloud receipt is too large");
  const signature = createHmac("sha256", current.signingSecret).update(`v0:${packet.timestamp}:`).update(body).digest();
  if (!timingSafeEqual(signature, Buffer.from(packet.signature.slice(3), "hex")))
    throw new Error("Slack Cloud original signature is invalid");
  const payload: unknown = JSON.parse(body.toString("utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Slack Cloud event");
  const envelope = payload as Record<string, unknown>;
  if (envelope.type !== "event_callback" || envelope.team_id !== current.teamId || envelope.api_app_id !== current.appId
    || typeof envelope.event_id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(envelope.event_id) || envelope.event_id !== packet.eventId
    || event.id !== `slack:${current.bindingId.slice("slack-event:".length)}:${createHash("sha256").update(envelope.event_id).digest("hex")}`)
    throw new Error("Slack Cloud event identity changed");
  const request = new Request("https://paperclip.invalid/slack-cloud-ingress", { method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": packet.timestamp,
      "x-slack-signature": packet.signature }, body: new Uint8Array(body) });
  acceptedTimes.set(request, acceptedAt);
  try {
    const response = await handleWebhook(request);
    await response.body?.cancel();
    if (!response.ok) throw new Error("Slack Cloud event has not been durably accepted");
  } finally { acceptedTimes.delete(request); }
}
