import jsonata from "jsonata";
import type { ExpressionContext, PipelineStage, StageStatus } from "./types.js";

export async function evaluateCondition(expression: string, context: ExpressionContext): Promise<boolean> {
  const expr = jsonata(expression);
  const result = await expr.evaluate(context);
  return Boolean(result);
}

export function buildExpressionContext(
  stages: Pick<PipelineStage, "stageId" | "status" | "output" | "retryCount">[],
  pipelineName: string,
  pipelineVersion: number,
  parentIssueId: string,
  companyId: string,
): ExpressionContext {
  const stageMap: ExpressionContext["stages"] = {};
  for (const stage of stages) {
    stageMap[stage.stageId] = {
      output: (stage.output as Record<string, unknown>) ?? null,
      status: stage.status,
      retry_count: stage.retryCount,
    };
  }
  return {
    stages: stageMap,
    pipeline: { name: pipelineName, version: pipelineVersion, parent_issue_id: parentIssueId },
    env: { company_id: companyId },
  };
}
