/**
 * Derived `caseType`.
 *
 * A case's "type" is not a field anyone fills in — it is simply *which pipeline
 * the case lives in* (one pipeline per kind of thing). We derive it from the
 * pipeline so it can be used internally for display and ingest sanity-checks
 * without any new user-facing field or lifecycle machinery.
 *
 * The pipeline key is a stable slug and is the canonical type identifier; we
 * fall back to the pipeline id if a key is somehow absent.
 */

export interface CaseTypePipelineRef {
  id: string;
  key?: string | null;
}

export function deriveCaseType(pipeline: CaseTypePipelineRef): string {
  const key = typeof pipeline.key === "string" ? pipeline.key.trim() : "";
  return key || pipeline.id;
}

/**
 * Ingest sanity-check: a case being ingested into a pipeline must match that
 * pipeline's derived type. Returns true when the (optional) declared type is
 * absent or already agrees with the pipeline — i.e. nothing to correct.
 */
export function caseTypeMatchesPipeline(
  declaredCaseType: string | null | undefined,
  pipeline: CaseTypePipelineRef,
): boolean {
  if (declaredCaseType == null || declaredCaseType === "") return true;
  return declaredCaseType === deriveCaseType(pipeline);
}
