import { REUSABLE_SANDBOX_RESUME_FAILED_CODE } from "../reusable-sandbox-resume-error.js";
import { isPersonOwnedFailureCode } from "../fresh-continuation-fallback.js";

export const STRANDED_CONTINUATION_MAX_AGE_MS = 24 * 60 * 60_000;
export const STRANDED_KIND = "stranded_assigned_issue";

const TRANSIENT_SANDBOX_CAUSES = new Set([
  "transport_timeout", "transport_closed", "sandbox_state_transition", "provider_rate_limited", "provider_unavailable",
]);

export type StrandedHoldRun = {
  agentId: string;
  status: string;
  errorCode: string | null;
  error: string | null;
  finishedAt: Date | null;
  executionRecovery: { kind?: unknown; providerWorkStarted?: unknown } | null;
};

export function strandedHoldContinuesAutomatically(
  hold: { kind: string; ownerType: string },
  run: StrandedHoldRun | null,
  assigneeAgentId: string | null,
  now: Date,
): boolean {
  if (hold.kind !== STRANDED_KIND || hold.ownerType !== "board") return false;
  if (!run || !assigneeAgentId || run.agentId !== assigneeAgentId || !run.finishedAt) return false;
  if (now.getTime() - run.finishedAt.getTime() > STRANDED_CONTINUATION_MAX_AGE_MS) return false;
  return strandedRunCauseIsTemporary(run);
}

export function strandedRunCauseIsTemporary(
  run: Pick<StrandedHoldRun, "status" | "errorCode" | "error" | "executionRecovery">,
): boolean {
  if (!["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)) return false;
  const code = run.errorCode ?? "";
  if (!code || isPersonOwnedFailureCode(code)) return false;
  if (code !== REUSABLE_SANDBOX_RESUME_FAILED_CODE) return true;
  const cause = /\(cause=([a-z_]+)/.exec(run.error ?? "")?.[1];
  return cause !== undefined && TRANSIENT_SANDBOX_CAUSES.has(cause);
}
