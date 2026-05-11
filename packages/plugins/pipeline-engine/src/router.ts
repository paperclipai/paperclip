import { buildEdgeExpressionContext } from "./expression-engine.js";
import { evaluateCondition } from "./expression-engine.js";
import { getIncomingEdges, getOutgoingEdges, getErrorEdges, getRootStageIds } from "./edge-utils.js";
import type { EdgeDefinition, FailureAction, PipelineDefinition, PipelineStage, StageDefinition } from "./types.js";

export class Router {
  async getReadyStages(
    pipeline: PipelineDefinition,
    stageRows: PipelineStage[],
    companyId: string,
  ): Promise<StageDefinition[]> {
    const stageStatusMap = new Map(stageRows.map((s) => [s.stageId, s]));
    const ready: StageDefinition[] = [];
    const edges = pipeline.edges ?? [];
    const stageIds = pipeline.stages.map((s) => s.id);
    const rootIds = new Set(getRootStageIds(stageIds, edges));

    for (const stageDef of pipeline.stages) {
      const row = stageStatusMap.get(stageDef.id);
      if (!row || row.status !== "pending") continue;

      // Skip sub-pipeline stages (they need dynamic materialization)
      if (stageDef.type === "sub-pipeline") continue;

      if (rootIds.has(stageDef.id)) {
        // Root stages are ready immediately
        ready.push(stageDef);
        continue;
      }

      const incomingEdges = getIncomingEdges(stageDef.id, edges);
      if (incomingEdges.length === 0) continue;

      // Determine fan_in strategy
      const fanIn = "fan_in" in stageDef ? stageDef.fan_in : undefined;
      const useFirstComplete = fanIn === "first_complete";

      // Evaluate which source stages have completed and which edges are satisfied
      const satisfiedEdges: EdgeDefinition[] = [];
      let allSourcesResolved = true;

      for (const edge of incomingEdges) {
        const sourceRow = stageStatusMap.get(edge.from);
        if (!sourceRow) {
          allSourcesResolved = false;
          continue;
        }

        const sourceCompleted = sourceRow.status === "completed" || sourceRow.status === "skipped";

        if (!sourceCompleted) {
          allSourcesResolved = false;
          continue;
        }

        // Evaluate edge `when` condition if present
        if (edge.when) {
          const context = buildEdgeExpressionContext(
            edge.from,
            stageRows.map((s) => ({ stageId: s.stageId, status: s.status, output: s.output, retryCount: s.retryCount })),
            pipeline.name,
            1,
            "",
            companyId,
          );
          let conditionMet: boolean;
          try {
            conditionMet = await evaluateCondition(edge.when, context);
          } catch {
            conditionMet = false;
          }
          if (conditionMet) {
            satisfiedEdges.push(edge);
          }
        } else {
          // Unconditional edge with completed source
          satisfiedEdges.push(edge);
        }
      }

      if (useFirstComplete) {
        // Ready if any satisfied edge exists
        if (satisfiedEdges.length > 0) {
          ready.push(stageDef);
        }
      } else {
        // all_complete (default): all incoming edges must be satisfied
        if (allSourcesResolved && satisfiedEdges.length === incomingEdges.length) {
          ready.push(stageDef);
        }
      }
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
    const edges = pipeline.edges ?? [];
    const stageIds = pipeline.stages.map((s) => s.id);
    const rootIds = new Set(getRootStageIds(stageIds, edges));

    for (const stageDef of pipeline.stages) {
      const row = stageStatusMap.get(stageDef.id);
      if (!row || row.status !== "pending") continue;
      if (rootIds.has(stageDef.id)) continue;

      const incomingEdges = getIncomingEdges(stageDef.id, edges);
      if (incomingEdges.length === 0) continue;

      // All sources must be resolved (completed or skipped) before we can declare skip
      const allSourcesResolved = incomingEdges.every((edge) => {
        const sourceRow = stageStatusMap.get(edge.from);
        return sourceRow?.status === "completed" || sourceRow?.status === "skipped";
      });
      if (!allSourcesResolved) continue;

      // Evaluate conditional edges
      let hasUnsatisfiedConditional = false;
      let hasUnconditionalWithCompletedSource = false;

      for (const edge of incomingEdges) {
        const sourceRow = stageStatusMap.get(edge.from);
        const sourceCompleted = sourceRow?.status === "completed";

        if (!edge.when) {
          if (sourceCompleted) {
            hasUnconditionalWithCompletedSource = true;
          }
        } else {
          if (sourceCompleted) {
            const context = buildEdgeExpressionContext(
              edge.from,
              stageRows.map((s) => ({ stageId: s.stageId, status: s.status, output: s.output, retryCount: s.retryCount })),
              pipeline.name,
              1,
              "",
              companyId,
            );
            let conditionMet: boolean;
            try {
              conditionMet = await evaluateCondition(edge.when, context);
            } catch {
              conditionMet = false;
            }
            if (!conditionMet) {
              hasUnsatisfiedConditional = true;
            }
          }
        }
      }

      // Skip if all conditional edges from completed sources evaluated false, and no unconditional completed source
      if (hasUnsatisfiedConditional && !hasUnconditionalWithCompletedSource) {
        skipped.push(stageDef);
      }
    }

    return skipped;
  }

  evaluateFailure(
    pipeline: PipelineDefinition,
    failedStageId: string,
    stageRow: PipelineStage,
    targetStageRow?: PipelineStage,
  ): FailureAction {
    const edges = pipeline.edges ?? [];
    const errorEdgesFromFailed = getErrorEdges(edges).filter((e) => e.from === failedStageId);

    if (errorEdgesFromFailed.length === 0) {
      return { action: "escalate" };
    }

    // Find first error edge that targets a stage with retry config
    for (const errorEdge of errorEdgesFromFailed) {
      const targetStageDef = pipeline.stages.find((s) => s.id === errorEdge.to);
      if (!targetStageDef) continue;

      const retry = targetStageDef.retry;
      if (!retry) continue;

      const retryRow = targetStageRow ?? stageRow;
      if (retryRow.retryCount >= retry.max_retries) {
        return { action: "escalate" };
      }

      return {
        action: "goto",
        targetStageId: errorEdge.to,
        body: retry.body,
      };
    }

    return { action: "escalate" };
  }

  requiresAgentDispatch(stageDef: StageDefinition): boolean {
    return stageDef.type === "worker" || stageDef.type === "classifier" || stageDef.type === "parallel_fan_out";
  }
}
