/** A server-recorded run-only Stop must not manufacture a recovery incident. */
export function hasAcknowledgedNativeStopIntent(run: {
  id: string; companyId: string; status: string; nativeIssueId: string | null;
  resultJson: Record<string, unknown> | null;
}): boolean {
  const result = run.resultJson;
  const intent = result?.nativeCancellation as Record<string, unknown> | undefined;
  return result?.cancelledByActorType === "user" &&
    typeof result.cancelledByUserId === "string" && Boolean(result.cancelledByUserId) &&
    intent?.schema === "paperclip.native-cancellation.v1" && intent.runId === run.id &&
    intent.companyId === run.companyId && intent.issueId === run.nativeIssueId &&
    intent.scope === "run" && intent.reasonCode === "cancellation_run_only" &&
    intent.dispatchState === "acknowledged" && intent.dispatched === true &&
    typeof intent.intentAuditId === "string" && typeof intent.acknowledgementAuditId === "string";
}

export function isAcknowledgedNativeStop(run: Parameters<typeof hasAcknowledgedNativeStopIntent>[0]): boolean {
  return run.status === "cancelled" && hasAcknowledgedNativeStopIntent(run);
}
