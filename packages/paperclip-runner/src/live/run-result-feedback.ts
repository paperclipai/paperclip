import { PRP_BLOCK_TOOL_NAME, PRP_COMPLETION_TOOL_NAME } from "../contracts/completion-result.js";
import { validatePrpStructuredRunResult } from "../protocol/replay-contract.js";

/** Accept a provider run report without mutating or grading the mock task. */
export function liveRunResultFeedback(operation: string, value: unknown, revision: string) {
  if (operation !== PRP_COMPLETION_TOOL_NAME && operation !== PRP_BLOCK_TOOL_NAME) return null;
  const parsed = validatePrpStructuredRunResult(value);
  if (!parsed.ok) return { ok: false, denial: { code: "invalid_run_result", message: "Run result does not satisfy the completion schema." } };
  const result = parsed.result;
  if ((operation === PRP_BLOCK_TOOL_NAME) !== (result.reportedWorkDisposition === "blocked")) {
    return { ok: false, denial: { code: "invalid_run_result", message: "Run disposition does not match the selected tool." } };
  }
  if (result.completionClaim.contractRevision !== revision ||
      result.completionClaim.criteria.length !== 1 || result.completionClaim.criteria[0]?.criterionId !== "objective") {
    return { ok: false, denial: { code: "stale_completion_contract", message: `Use completion contract ${revision} with criterion objective.` } };
  }
  return { ok: true, result: { reportedWorkDisposition: result.reportedWorkDisposition, accepted: true, taskStateChanged: false } };
}
