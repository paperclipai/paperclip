import { readCompletedAssistantMessageCandidate } from "./heartbeat-run-summary.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeResponsePresentationScope = { companyId: string; issueId?: string; runId?: string; agentId?: string };

export async function notifyNativeResponsePresentation(tx: object, scope: NativeResponsePresentationScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeResponsePresentation,
    JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId, runId: scope.runId, agentId: scope.agentId }));
}

export function isNativeResponseEvidence(eventType: string, prpEvent: unknown): boolean {
  return eventType === "run.result.accepted" || eventType === "item.completed" &&
    readCompletedAssistantMessageCandidate({ seq: 0, prpEvent })?.channel === "final";
}
