import jsonata from "jsonata";
import type { ExpressionContext, PipelineStage, StageStatus } from "./types.js";

const BLOCKED_FUNCTIONS = ["$eval", "$string", "$number", "$boolean", "$keys", "$lookup", "$environment"];
const EVALUATION_TIMEOUT_MS = 2000;

export async function evaluateCondition(expression: string, context: ExpressionContext): Promise<boolean> {
  const normalized = normalizeExpression(expression);

  for (const fn of BLOCKED_FUNCTIONS) {
    if (normalized.includes(fn)) {
      throw new Error(`Expression contains blocked function "${fn}": ${expression}`);
    }
  }

  const expr = jsonata(normalized);
  expr.assign("$eval", undefined);
  expr.assign("$environment", undefined);

  const result = await Promise.race([
    expr.evaluate(context),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Expression evaluation timed out after ${EVALUATION_TIMEOUT_MS}ms: ${expression}`)), EVALUATION_TIMEOUT_MS),
    ),
  ]);
  return Boolean(result);
}

function normalizeExpression(expression: string): string {
  let result = expression.replace(/([^!=<>])={2}(?!=)/g, "$1=");
  result = result.replace(
    /(\S+)\.every\(\s*\w+\s*=>\s*\w+\.(\w+)\s*=\s*'([^']+)'\s*\)/g,
    "$count($1[$2 != '$3']) = 0",
  );
  return result;
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

export function buildEdgeExpressionContext(
  sourceStageId: string,
  stages: Pick<PipelineStage, "stageId" | "status" | "output" | "retryCount">[],
  pipelineName: string,
  pipelineVersion: number,
  parentIssueId: string,
  companyId: string,
): ExpressionContext {
  const fullContext = buildExpressionContext(stages, pipelineName, pipelineVersion, parentIssueId, companyId);
  const sourceEntry =
    fullContext.stages[sourceStageId] ?? fullContext.stages[sourceStageId.replace(/-/g, "_")];
  return { ...fullContext, output: sourceEntry?.output ?? null };
}
