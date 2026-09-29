/** Automatic replacement requires positive evidence at every boundary. */
export interface NativeReplacementEvidence {
  failedSession: boolean;
  failureMeaningKnown: boolean;
  predecessorFenced: boolean;
  providerStopped: boolean;
  workspacePreserved: boolean;
  historyComplete: boolean;
  effectInventoryComplete: boolean;
  attempts: number;
  invocations: Array<{
    id: string;
    toolName: string;
    riskLevel: string | null;
    status: string;
    completedAt: Date | null;
    resultHash: string | null;
  }>;
  apiReceipts: Record<string, unknown>;
  uncertainProviderActions: string[];
}
export type NativeReplacementDecision =
  | { allowed: true; remainingAttempts: number }
  | { allowed: false; cause: string; nextAction: string };
export function decideNativeReplacement(
  evidence: NativeReplacementEvidence,
): NativeReplacementDecision {
  const stop = (
    cause: string,
    nextAction: string,
  ): NativeReplacementDecision => ({ allowed: false, cause, nextAction });
  if (!evidence.failedSession)
    return stop(
      "session_replacement_not_required",
      "Resume the established session if its checkpoint remains usable.",
    );
  if (!evidence.failureMeaningKnown)
    return stop(
      "provider_failure_meaning_unverified",
      "Inspect the original provider failure and reconcile its action history. An unclassified transport failure cannot prove that a fresh session is safe.",
    );
  if (evidence.attempts >= 3)
    return stop(
      "execution_recovery_budget_exhausted",
      "Inspect the original failure and choose a recovery action; three execution attempts have been used.",
    );
  if (!evidence.predecessorFenced || !evidence.providerStopped)
    return stop(
      "provider_ownership_unverified",
      "Verify the previous provider has stopped and revoke its execution authority before continuing.",
    );
  if (!evidence.effectInventoryComplete)
    return stop(
      "provider_effect_inventory_unavailable",
      "Inspect the provider's complete action history and reconcile outcomes before continuing; this run did not record a verified action inventory.",
    );
  if (!evidence.workspacePreserved || !evidence.historyComplete)
    return stop(
      "continuation_evidence_incomplete",
      "Restore the task workspace and required conversation history before continuing.",
    );
  const incompleteReceipt = Object.entries(evidence.apiReceipts).find(
    ([, receipt]) =>
      !receipt ||
      typeof receipt !== "object" ||
      !("state" in receipt) ||
      receipt.state !== "completed",
  );
  if (incompleteReceipt)
    return stop(
      "uncertain_control_plane_action",
      `Reconcile the outcome of control-plane action ${incompleteReceipt[0]} before replaying it.`,
    );
  // Older receipts identify a request only by its hash. A fresh provider cannot
  // tell which completed action that hash represents, so it cannot safely use
  // the receipt to avoid repeating the action under a new call id.
  const unidentifiedReceipt = Object.entries(evidence.apiReceipts).find(
    ([, receipt]) => {
      const value = receipt as Record<string, unknown>;
      return typeof value.operationId !== "string" || !("result" in value);
    },
  );
  if (unidentifiedReceipt)
    return stop(
      "completed_action_context_missing",
      `Identify completed control-plane action ${unidentifiedReceipt[0]} and preserve its result in the continuation before proceeding.`,
    );
  const invocation = evidence.invocations.find(
    (row) =>
      row.riskLevel !== "read" ||
      row.status !== "succeeded" ||
      !row.completedAt ||
      !row.resultHash,
  );
  if (invocation)
    return stop(
      "uncertain_external_action",
      `Reconcile ${invocation.toolName} (invocation ${invocation.id}) and preserve its result before continuing. Do not repeat it automatically.`,
    );
  if (evidence.uncertainProviderActions.length)
    return stop(
      "uncertain_provider_action",
      `Reconcile provider action ${evidence.uncertainProviderActions[0]} before continuing. Provider-native commands have no reliable outcome receipt.`,
    );
  return { allowed: true, remainingAttempts: 3 - evidence.attempts };
}
