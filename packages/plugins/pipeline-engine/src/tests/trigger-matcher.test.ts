import { describe, it, expect } from "vitest";
import { TriggerMatcher } from "../trigger-matcher.js";
import type { PipelineDefinition } from "../types.js";

describe("trigger-matcher", () => {
  const pipelines: PipelineDefinition[] = [
    { name: "feature", description: "", trigger: { label: "pipeline:feature" }, stages: [] },
    { name: "bug", description: "", trigger: { label: "pipeline:bug" }, stages: [] },
  ];

  it("matches a trigger label to a pipeline", () => {
    const matcher = new TriggerMatcher(pipelines);
    const result = matcher.match(["pipeline:feature", "priority:high"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("feature");
  });

  it("returns null when no label matches", () => {
    const matcher = new TriggerMatcher(pipelines);
    const result = matcher.match(["priority:high", "team:backend"]);
    expect(result).toBeNull();
  });

  it("returns first match when multiple labels match", () => {
    const matcher = new TriggerMatcher(pipelines);
    const result = matcher.match(["pipeline:bug", "pipeline:feature"]);
    expect(result).not.toBeNull();
  });

  it("handles empty label array", () => {
    const matcher = new TriggerMatcher(pipelines);
    const result = matcher.match([]);
    expect(result).toBeNull();
  });
});
