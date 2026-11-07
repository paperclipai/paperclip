import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";

export function notifyVoiceReports(tx: object, scope: { kind: "session"; id: string }) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.voiceReports, `${scope.kind}:${scope.id}`);
}
