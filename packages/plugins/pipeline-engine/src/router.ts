import { evaluateCondition, buildExpressionContext } from "./expression-engine.js";
import { renderTemplate } from "./template-engine.js";
import type { PipelineDefinition, PipelineStage, StageDefinition } from "./types.js";

export interface FailureAction {
  action: "goto" | "escalate";
  targetStageId?: string;
  body?: string;
}

export class Router {
  async getReadyStages(
    pipeline: PipelineDefinition,
    stageRows: PipelineStage[],
    companyId: string,
  ): Promise<StageDefinition[]> {
    const stageStatusMap = new Map(stageRows.map((s) => [s.stageId, s]));
    const ready: StageDefinition[] = [];

    for (const stageDef of pipeline.stages) {
      const row = stageStatusMap.get(stageDef.id);
      if (!row || row.status !== "pending") continue;

      if (stageDef.type === "sub-pipeline") continue;

      const depsComplete = (stageDef.depends_on ?? []).every((dep) => {
        const depRow = stageStatusMap.get(dep);
        return depRow?.status === "completed";
      });
      if (!depsComplete) continue;

      const blockedByCheckpoint = (stageDef.depends_on ?? []).some((dep) => {
        const depDef = pipeline.stages.find((s) => s.id === dep);
        if (!depDef?.checkpoint) return false;
        const depRow = stageStatusMap.get(dep);
        return depRow?.status !== "completed";
      });
      if (blockedByCheckpoint) continue;

      if (stageDef.skip_if) {
        const context = buildExpressionContext(
          stageRows.map((s) => ({ stageId: s.stageId, status: s.status, output: s.output, retryCount: s.retryCount })),
          pipeline.name,
          1,
          "",
          companyId,
        );
        const shouldSkip = await evaluateCondition(stageDef.skip_if, context);
        if (shouldSkip) continue;
      }

      if (stageDef.condition) {
        const context = buildExpressionContext(
          stageRows.map((s) => ({ stageId: s.stageId, status: s.status, output: s.output, retryCount: s.retryCount })),
          pipeline.name,
          1,
          "",
          companyId,
        );
        const conditionMet = await evaluateCondition(stageDef.condition, context);
        if (!conditionMet) continue;
      }

      ready.push(stageDef);
    }

    return ready;
  }

  async getSkippedStages(
    pipeline: PipelineDefinition,
    stageRows: PipelineStage[],
    companyId: string,
  ): Promise<StageDefinition[]> {
    const stageStatusMap = new Map(stageRows.map((s) => [s.stageId, s]));
    const skipped: StageDefinition[] = [];

    for (const stageDef of pipeline.stages) {
      const row = stageStatusMap.get(stageDef.id);
      if (!row || row.status !== "pending") continue;
      if (!stageDef.skip_if) continue;

      const depsComplete = (stageDef.depends_on ?? []).every((dep) => {
        const depRow = stageStatusMap.get(dep);
        return depRow?.status === "completed" || depRow?.status === "skipped";
      });
      if (!depsComplete) continue;

      const context = buildExpressionContext(
        stageRows.map((s) => ({ stageId: s.stageId, status: s.status, output: s.output, retryCount: s.retryCount })),
        pipeline.name,
        1,
        "",
        companyId,
      );
      const shouldSkip = await evaluateCondition(stageDef.skip_if, context);
      if (shouldSkip) skipped.push(stageDef);
    }

    return skipped;
  }

  evaluateFailure(
    stageDef: StageDefinition,
    stageRow: PipelineStage,
    targetStageRow?: PipelineStage,
  ): FailureAction {
    const onFailure = stageDef.on_failure;
    if (!onFailure?.retry_with) {
      return { action: "escalate" };
    }

    const { goto, body, max_retries } = onFailure.retry_with;

    const retryCount = targetStageRow?.retryCount ?? stageRow.retryCount;
    if (retryCount >= max_retries) {
      return { action: "escalate" };
    }

    const renderedBody = renderTemplate(body, { output: stageRow.output ?? {} });
    return { action: "goto", targetStageId: goto, body: renderedBody };
  }

  requiresAgentDispatch(stageDef: StageDefinition): boolean {
    return stageDef.type === "worker" || stageDef.type === "classifier" || stageDef.type === "parallel_fan_out";
  }
}
