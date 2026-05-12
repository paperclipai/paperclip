import type { PipelineDefinition } from "./types.js";

export class TriggerMatcher {
  private labelToPipeline: Map<string, PipelineDefinition>;

  constructor(pipelines: PipelineDefinition[]) {
    this.labelToPipeline = new Map();
    for (const pipeline of pipelines) {
      this.labelToPipeline.set(pipeline.trigger.label, pipeline);
    }
  }

  match(labelNames: string[]): PipelineDefinition | null {
    for (const label of labelNames) {
      const pipeline = this.labelToPipeline.get(label);
      if (pipeline) return pipeline;
    }
    return null;
  }

  hasTriggerLabel(labelName: string): boolean {
    return this.labelToPipeline.has(labelName);
  }

  get triggerLabels(): string[] {
    return [...this.labelToPipeline.keys()];
  }
}
