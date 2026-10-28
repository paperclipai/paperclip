import { notifyVoiceInbound } from "./voice-inbound-notifications.js";
import { notifyVoiceReplies } from "./voice-reply-notifications.js";
import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";

export type VoiceRecoveryScope = { kind: "session" | "endpoint" | "connection" | "company"; id: string };
export function voiceRecoveryScope(hint: string): VoiceRecoveryScope | undefined {
  if (hint === "*") return undefined;
  const [kind, id, extra] = hint.split(":");
  if (!id || extra !== undefined || !["session", "endpoint", "connection", "company"].includes(kind))
    throw new Error("Invalid voice recovery scope");
  return { kind: kind as VoiceRecoveryScope["kind"], id };
}
export function notifyVoiceRecovery(tx: object, scope?: VoiceRecoveryScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.voiceSessionRecovery, scope ? `${scope.kind}:${scope.id}` : "*");
}
/** A committed authority, configuration, or session transition can change both
 * live-call recovery and reply eligibility. Passive provider inspection does not. */
export async function notifyVoiceChange(tx: object, scope?: VoiceRecoveryScope) {
  await notifyVoiceRecovery(tx, scope);
  await notifyVoiceReplies(tx, scope);
  await notifyVoiceInbound(tx, scope);
}
export function withVoiceSessionChange<T>(db: Db, id: string, write: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => PromiseLike<T>, options: { replyDelivery?: boolean } = {}): Promise<T> {
  return db.transaction(async tx => {
    if (options.replyDelivery === false) await notifyVoiceRecovery(tx, { kind: "session", id });
    else await notifyVoiceChange(tx, { kind: "session", id });
    return write(tx);
  });
}
