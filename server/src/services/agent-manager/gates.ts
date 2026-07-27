import type { ShouldEvaluateInput } from "./types.js";

export function shouldEvaluateRun(input: ShouldEvaluateInput): boolean {
  if (!input.settings?.enabled) return false;
  if (input.supervisedAgentExcluded) return false;
  if (input.issueWorkMode !== "standard") return false;
  if (input.hasActiveRecovery) return false;
  if (input.assigneeBudgetBlocked) return false;
  if (input.hasExistingEvaluation) return false;

  if (input.trigger === "run_failed" && !input.settings.evaluateFailedRuns) return false;
  if (input.trigger === "needs_followup" && !input.settings.evaluateNeedsFollowup) return false;

  return true;
}
