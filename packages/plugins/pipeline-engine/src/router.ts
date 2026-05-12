import { getIncomingEdges, getErrorEdges, getRootStageIds } from "./edge-utils.js";
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
      const fanInStrategy = stageDef.type === "fan_in" ? stageDef.fan_in_strategy : undefined;
      const useFirstComplete = fanInStrategy === "first_complete";

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

        // sourceHandle-based routing: edge satisfied only if source decision matches
        if (edge.sourceHandle) {
          const sourceOutput = sourceRow.output as Record<string, unknown> | null;
          if (sourceOutput?.decision === edge.sourceHandle) {
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

      // Check if any edge is satisfied
      let anySatisfied = false;

      for (const edge of incomingEdges) {
        const sourceRow = stageStatusMap.get(edge.from);
        const sourceCompleted = sourceRow?.status === "completed";

        if (!sourceCompleted) continue;

        if (edge.sourceHandle) {
          const sourceOutput = sourceRow.output as Record<string, unknown> | null;
          if (sourceOutput?.decision === edge.sourceHandle) {
            anySatisfied = true;
            break;
          }
        } else {
          // Unconditional edge from completed source — satisfied
          anySatisfied = true;
          break;
        }
      }

      // Skip if all sources resolved but no edge is satisfied
      if (!anySatisfied) {
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

    // Use first error edge as the goto target
    const errorEdge = errorEdgesFromFailed[0];
    return {
      action: "goto",
      targetStageId: errorEdge.to,
    };
  }

  requiresAgentDispatch(stageDef: StageDefinition): boolean {
    return stageDef.type === "stage" || stageDef.type === "fan_out";
  }
}
