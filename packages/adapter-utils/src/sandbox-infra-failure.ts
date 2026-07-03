// ---------------------------------------------------------------------------
// Sandbox infrastructure failure classification
//
// When the sandbox provider cannot bring a pod up at all (the cluster has no
// capacity for it, or the pod never reports Ready), the failure surfaces to
// the run as an opaque exec failure and is recorded as a generic
// "adapter_failed". That mis-drives recovery: a capacity stall does not
// resolve on the short generic backoff, so retries burn full timeout windows
// back to back.
//
// The kubernetes sandbox provider plugin emits stable marker phrases for
// these conditions (see packages/plugins/sandbox-providers/kubernetes
// plugin.ts / sandbox-cr-orchestrator.ts — keep the regexes below in sync
// with those messages). This module recognizes them wherever the text lands
// (an adapter result's errorMessage, a thrown prep-exec error message) and
// maps them to distinct, stable run error codes so recovery can apply a
// capacity-appropriate backoff and the user sees an honest infrastructure
// error. Mirrors the classifyInferenceFailure pattern in this package.
// ---------------------------------------------------------------------------

/** The sandbox pod cannot be placed on any node (cluster out of capacity). */
export const SANDBOX_UNSCHEDULABLE_ERROR_CODE = "sandbox_unschedulable";

/** The sandbox pod was scheduled but never reported Ready in time. */
export const SANDBOX_NOT_READY_ERROR_CODE = "sandbox_not_ready";

export type SandboxInfraFailureCode =
  | typeof SANDBOX_UNSCHEDULABLE_ERROR_CODE
  | typeof SANDBOX_NOT_READY_ERROR_CODE;

// Marker emitted by the kubernetes plugin when the readiness wait detects a
// persistently Unschedulable pod.
const SANDBOX_UNSCHEDULABLE_RE = /sandbox pod could not be scheduled/i;

// Markers emitted when the readiness wait times out: the plugin's graceful
// exec result ("Sandbox pod did not become Ready within Xms") and the
// orchestrator's SandboxCrTimeoutError ("did not reach Ready phase within").
const SANDBOX_NOT_READY_RE =
  /sandbox pod did not become ready within|did not reach ready phase within/i;

/**
 * Classify a failure message as a sandbox infrastructure failure.
 *
 * Returns null when the text carries no sandbox-infra marker so callers only
 * override genuine capacity/readiness failures and leave every other failure
 * classified as before.
 */
export function classifySandboxInfraFailure(
  text: string | null | undefined,
): SandboxInfraFailureCode | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  // Unschedulable is the more specific diagnosis: a pod that cannot be
  // scheduled also never becomes Ready, so test it first.
  if (SANDBOX_UNSCHEDULABLE_RE.test(text)) return SANDBOX_UNSCHEDULABLE_ERROR_CODE;
  if (SANDBOX_NOT_READY_RE.test(text)) return SANDBOX_NOT_READY_ERROR_CODE;
  return null;
}
