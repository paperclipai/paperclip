/**
 * Operator diagnostic wakes such as `claude_reauth_smoke` and
 * `post_restore_smoke`. The suffix is the contract: timer heartbeats and
 * ordinary unscoped runs are not diagnostic smokes and keep the existing
 * cross-issue cap.
 */
const DIAGNOSTIC_SMOKE_WAKE_SUFFIX = "_smoke";

export const DIAGNOSTIC_SMOKE_CAPABILITY_WARNING =
  "This run is an unassigned diagnostic smoke. It cannot check out this task or set up connections. A run id header does not create a task binding. Do not retry checkout. Record the diagnostic in this run's log. Comments and status updates, when the cross-issue cap still allows them, do not grant task ownership.";

export function isDiagnosticSmokeWake(reason: unknown): boolean {
  return typeof reason === "string" && reason.trim().endsWith(DIAGNOSTIC_SMOKE_WAKE_SUFFIX);
}

export function readSnapshotTaskBinding(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const context = snapshot as Record<string, unknown>;
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

/** Persist the capability warning on unbound diagnostic smokes, and clear it once a task is bound. */
export function annotateDiagnosticSmokeSnapshot(snapshot: Record<string, unknown>): void {
  if (readSnapshotTaskBinding(snapshot) || !isDiagnosticSmokeWake(snapshot.wakeReason)) {
    delete snapshot.diagnosticsOnly;
    delete snapshot.diagnosticsOnlyCapability;
    return;
  }
  snapshot.diagnosticsOnly = true;
  snapshot.diagnosticsOnlyCapability = DIAGNOSTIC_SMOKE_CAPABILITY_WARNING;
}

/** Warning when this snapshot must not be granted a writable checkout. Null means checkout may proceed. */
export function diagnosticSmokeCheckoutBlock(snapshot: unknown): string | null {
  if (readSnapshotTaskBinding(snapshot)) return null;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const context = snapshot as Record<string, unknown>;
  const diagnostic = context.diagnosticsOnly === true || isDiagnosticSmokeWake(context.wakeReason);
  if (!diagnostic) return null;
  return typeof context.diagnosticsOnlyCapability === "string" && context.diagnosticsOnlyCapability.trim()
    ? context.diagnosticsOnlyCapability.trim()
    : DIAGNOSTIC_SMOKE_CAPABILITY_WARNING;
}

/**
 * Unbound diagnostic smokes and ordinary wakes both have a null task scope.
 * Folding them into one run either blocks the timer or clears the smoke restriction.
 */
export function diagnosticSmokeCoalesceConflict(existing: unknown, incoming: unknown): boolean {
  return (diagnosticSmokeCheckoutBlock(existing) !== null) !== (diagnosticSmokeCheckoutBlock(incoming) !== null);
}
