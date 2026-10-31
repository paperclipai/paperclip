export const REVIEWER_ASSIGNMENT_CONTINUATION_KEY = "_paperclipReviewerAssignmentContinuation";

export function hasReviewerAssignmentContinuation(payload: unknown): boolean {
  if (typeof payload === "string") return payload === REVIEWER_ASSIGNMENT_CONTINUATION_KEY;
  if (Array.isArray(payload)) return payload.includes(REVIEWER_ASSIGNMENT_CONTINUATION_KEY);
  return payload !== null && typeof payload === "object" &&
    Object.prototype.hasOwnProperty.call(payload, REVIEWER_ASSIGNMENT_CONTINUATION_KEY);
}
