import yaml from "js-yaml";
import type { PipelineDefinition, StageDefinition } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function parsePipeline(yamlContent: string): PipelineDefinition {
  const parsed = yaml.load(yamlContent) as Record<string, unknown>;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid YAML: expected an object");
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

  return {
    name: parsed.name as string,
    description: (parsed.description as string) ?? "",
    trigger: parsed.trigger as PipelineDefinition["trigger"],
    stages: parsed.stages as StageDefinition[],
  };
}

export function validateDAG(pipeline: PipelineDefinition): ValidationResult {
  const errors: string[] = [];
  const stageIds = new Set<string>();
  const allStages = flattenStages(pipeline.stages);

  for (const stage of allStages) {
    if (stageIds.has(stage.id)) {
      errors.push(`duplicate stage id: "${stage.id}"`);
    }
    stageIds.add(stage.id);
  }

  for (const stage of allStages) {
    if (stage.depends_on) {
      for (const dep of stage.depends_on) {
        if (!stageIds.has(dep)) {
          errors.push(`stage "${stage.id}" depends on nonexistent stage "${dep}"`);
        }
      }
    }
  }

  const cycleError = detectCycle(allStages);
  if (cycleError) {
    errors.push(cycleError);
  }

  return { valid: errors.length === 0, errors };
}

function flattenStages(stages: StageDefinition[]): StageDefinition[] {
  const result: StageDefinition[] = [];
  for (const stage of stages) {
    result.push(stage);
    if ("stages" in stage && stage.stages) {
      result.push(...flattenStages(stage.stages));
    }
  }
  return result;
}

function detectCycle(stages: StageDefinition[]): string | null {
  const adjacency = new Map<string, string[]>();
  for (const stage of stages) {
    adjacency.set(stage.id, stage.depends_on ?? []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    inStack.add(nodeId);
    for (const dep of adjacency.get(nodeId) ?? []) {
      if (dfs(dep)) return true;
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
