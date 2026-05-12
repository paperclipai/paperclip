import type { ExpressionContext, PipelineStage, StageStatus } from "./types.js";

export function buildExpressionContext(
  stages: Pick<PipelineStage, "stageId" | "status" | "output" | "retryCount">[],
  pipelineName: string,
  pipelineVersion: number,
  parentIssueId: string,
  companyId: string,
): ExpressionContext {
  const stageMap: ExpressionContext["stages"] = {};
  for (const stage of stages) {
    const entry = {
      output: (stage.output as Record<string, unknown>) ?? null,
      status: stage.status,
      retry_count: stage.retryCount,
    };
    stageMap[stage.stageId] = entry;
    const normalized = stage.stageId.replace(/-/g, "_");
    if (normalized !== stage.stageId) {
      stageMap[normalized] = entry;
    }
  }
  return {
    stages: stageMap,
    pipeline: { name: pipelineName, version: pipelineVersion, parent_issue_id: parentIssueId },
    env: { company_id: companyId },
  };
}
