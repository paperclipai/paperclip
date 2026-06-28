import { describe, expect, it } from "vitest";
import {
  isPipelineSettingsStageSectionAvailable,
  resolvePipelineSettingsFallbackStageId,
} from "./PipelineSettings";

const stages = [{ id: "first-stage" }, { id: "break-assets" }];

describe("resolvePipelineSettingsFallbackStageId", () => {
  it("does not default to the first stage when the URL requested a valid stage", () => {
    expect(resolvePipelineSettingsFallbackStageId(stages, null, "break-assets")).toBeNull();
  });

  it("defaults to the first stage when no stage is selected or requested", () => {
    expect(resolvePipelineSettingsFallbackStageId(stages, null, null)).toBe("first-stage");
  });

  it("keeps the current selected stage when one is already selected", () => {
    expect(resolvePipelineSettingsFallbackStageId(stages, "break-assets", null)).toBeNull();
  });
});

describe("isPipelineSettingsStageSectionAvailable", () => {
  it("accepts deep-linked stage config sections", () => {
    expect(isPipelineSettingsStageSectionAvailable("working", "instructions")).toBe(true);
    expect(isPipelineSettingsStageSectionAvailable("working", "advanced")).toBe(true);
    expect(isPipelineSettingsStageSectionAvailable("working", "secrets")).toBe(true);
    expect(isPipelineSettingsStageSectionAvailable("working", "activity")).toBe(true);
    expect(isPipelineSettingsStageSectionAvailable("working", "history")).toBe(true);
  });
});
