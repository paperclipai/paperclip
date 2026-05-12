import type { EdgeDefinition, PipelineDefinition, StageDefinition } from "./types.js";
import { buildAdjacencyFromEdges, getForwardEdges, getLoopEdges } from "./edge-utils.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function parsePipeline(content: string): PipelineDefinition {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid pipeline: expected an object");
  }
  if (!parsed.name || typeof parsed.name !== "string") {
    throw new Error("Pipeline must have a 'name' field");
  }
  if (!parsed.trigger || typeof parsed.trigger !== "object") {
    throw new Error("Pipeline must have a 'trigger' field");
  }
  if (!Array.isArray(parsed.stages) || parsed.stages.length === 0) {
    throw new Error("Pipeline must have at least one stage");
  }
  if (!Array.isArray(parsed.edges)) {
    throw new Error("Pipeline must have an 'edges' array");
  }

  return {
    name: parsed.name as string,
    description: (parsed.description as string) ?? "",
    trigger: parsed.trigger as PipelineDefinition["trigger"],
    stages: parsed.stages as StageDefinition[],
    edges: parsed.edges as EdgeDefinition[],
    positions: (parsed.positions as Record<string, { x: number; y: number }>) ?? {},
  };
}

export function validateDAG(pipeline: PipelineDefinition): ValidationResult {
  const errors: string[] = [];
  const stageIds = new Set<string>();
  const edgeIds = new Set<string>();

  // Check for duplicate stage IDs
  for (const stage of pipeline.stages) {
    if (stageIds.has(stage.id)) {
      errors.push(`duplicate stage id: "${stage.id}"`);
    }
    stageIds.add(stage.id);
  }

  // Check for duplicate edge IDs and dangling references
  for (const edge of pipeline.edges) {
    if (edgeIds.has(edge.id)) {
      errors.push(`duplicate edge id: "${edge.id}"`);
    }
    edgeIds.add(edge.id);

    if (!stageIds.has(edge.from)) {
      errors.push(`edge "${edge.id}" references nonexistent source stage "${edge.from}"`);
    }
    if (!stageIds.has(edge.to)) {
      errors.push(`edge "${edge.id}" references nonexistent target stage "${edge.to}"`);
    }
  }

  // Cycle detection using forward edges only (loop edges excluded)
  const cycleError = detectCycle(pipeline.stages, pipeline.edges);
  if (cycleError) {
    errors.push(cycleError);
  }

  // Validate loop edges
  for (const edge of getLoopEdges(pipeline.edges)) {
    if (!edge.max_iterations || edge.max_iterations <= 0) {
      errors.push(`loop edge "${edge.id}" must have max_iterations > 0`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function detectCycle(stages: StageDefinition[], edges: EdgeDefinition[]): string | null {
  const adjacency = buildAdjacencyFromEdges(getForwardEdges(edges));

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    inStack.add(nodeId);
    for (const successor of adjacency.get(nodeId) ?? []) {
      if (dfs(successor)) return true;
    }
    inStack.delete(nodeId);
    return false;
  }

  for (const stage of stages) {
    if (dfs(stage.id)) {
      return `cycle detected involving stage "${stage.id}"`;
    }
  }
  return null;
}
