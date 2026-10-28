import { hasReviewerAssignmentContinuation } from "../domain/receipt-namespace.js";
import type { DeferredWakeCandidate } from "./ports.js";
import { WakeQueueApplicationError } from "./types.js";

export function admitReleaseDrainCandidate(
  candidate: DeferredWakeCandidate,
  processedWakeIds: Set<string>,
  scope: { companyId: string; issueId: string },
): boolean {
  if (processedWakeIds.has(candidate.id)) {
    throw new WakeQueueApplicationError(
      "deferred_wake_not_advanced",
      "Deferred wake queue read the same wake id twice; the row did not leave the deferred status",
      { ...scope, wakeId: candidate.id },
    );
  }
  processedWakeIds.add(candidate.id);
  return !hasReviewerAssignmentContinuation(candidate.payload);
}
