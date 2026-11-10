import { withholdPrivateScreenshots } from "./screenshot-privacy.js";
import type { RunnerE2EResult } from "./types.js";

/** Evidence failure must retain the original startup/work verdict. A generated
 * fallback remains a failed harness result, never proof that a browser ran. */
export function abnormalFinalizationResult(original: RunnerE2EResult, error: unknown): RunnerE2EResult {
  const detail = error instanceof Error ? error.message : String(error);
  return { ...withholdPrivateScreenshots(original), status: "failed", failureClass: original.status === "failed" ? original.failureClass : "permanent_infrastructure",
    error: `${original.error ? `${original.error}; ` : ""}Abnormal attempt finalization: ${detail}` };
}
