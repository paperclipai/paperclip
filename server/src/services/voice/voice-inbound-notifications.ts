import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";

export type VoiceInboundScope = { kind: "admission" | "session" | "endpoint" | "connection" | "company"; id: string };
export function voiceInboundScope(hint: string): VoiceInboundScope | undefined {
  if (hint === "*") return undefined;
  const [kind, id, extra] = hint.split(":");
  if (!id || extra !== undefined || !["admission", "session", "endpoint", "connection", "company"].includes(kind))
    throw new Error("Invalid inbound voice scope");
  return { kind: kind as VoiceInboundScope["kind"], id };
}
export async function notifyVoiceInbound(tx: object, scope?: VoiceInboundScope) {
  const hint = scope ? `${scope.kind}:${scope.id}` : "*";
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.voiceInboundCleanup, hint);
  if (scope?.kind === "admission") await notifyDeliveryWork(tx, DELIVERY_QUEUES.voiceInboundRetention, hint);
}
