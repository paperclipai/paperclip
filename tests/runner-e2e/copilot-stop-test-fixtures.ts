import { readFileSync } from "node:fs";
import { readCopilotStopAcknowledgement } from "./copilot-stop-acknowledgement.js";

// Synthetic scope/times over a retained, sanitized current-mainline API response.
// This helper calibrates fixture assertions; it provides no live qualification.
export const retainedMainlineStop = JSON.parse(readFileSync(new URL("./fixtures/copilot-mainline-stop-ack-v15.json", import.meta.url), "utf8"));
export function applyMainlineStopMetadata(run: Record<string, any>) {
  const existing = run.resultJson ?? {}, template = structuredClone(retainedMainlineStop.run.resultJson);
  const requestedAt = existing.startupCancellation?.requestedAt ?? template.startupCancellation.requestedAt;
  run.runtimeMode = "native";
  run.resultJson = { ...existing, cancelledByActorType: "user", cancelledByUserId: "local-board",
    cancellation: { ...template.cancellation, recordedAt: requestedAt },
    startupCancellation: { requestedAt, beforeNativeSelection: false },
    nativeCancellation: { ...template.nativeCancellation, ...existing.nativeCancellation,
      intentId: template.nativeCancellation.intentId, companyId: run.companyId, runId: run.id, issueId: run.nativeIssueId } };
}
export function stopAcknowledgementForTest(run: Record<string, any>, fixtureCorrelationId: string, dispatchMonotonicNs: string) {
  return readCopilotStopAcknowledgement(run, { companyId: run.companyId, runId: run.id, issueId: run.nativeIssueId, callerUserId: "local-board" },
    fixtureCorrelationId, dispatchMonotonicNs, (BigInt(dispatchMonotonicNs) + 1n).toString());
}
