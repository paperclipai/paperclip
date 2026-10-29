import { notifyNativeReviewResponse } from "./native-review-response-notifications.js";
import { notifyNativeStatusReassessment, type NativeStatusReassessmentScope } from "./native-status-reassessment-notifications.js";

export async function notifyNativeReviewState(tx: object, scope: NativeStatusReassessmentScope) {
  await notifyNativeReviewResponse(tx, scope);
  await notifyNativeStatusReassessment(tx, scope);
}
