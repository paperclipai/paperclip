import { describe, expect, it } from "vitest";
import {
  computePipelineHealth,
  type PipelineHealthFailedAutomationInput,
  type PipelineHealthInput,
} from "./pipeline-health.js";

describe("computePipelineHealth", () => {
  const baseInput: PipelineHealthInput = {
    pipelineId: "pipeline-1",
    stages: [],
    agentsById: {},
    pipelinesById: {},
  };

  it("emits one warning per failed automation item and stage", () => {
    const failure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [failure],
    });

    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatchObject({
      code: "automation_failed",
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      href: "/pipelines/pipeline-1/items/case-1",
      hrefLabel: "Open item",
      message: `Automation failed on "Case 1". Open the item to inspect the log and retry it.`,
    });
  });

  it("deduplicates duplicate failed automation rows for the same stage and case", () => {
    const failure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };
    const duplicateFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [failure, duplicateFailure],
    });

    const automationWarnings = report.warnings.filter((warning) => warning.code === "automation_failed");

    expect(automationWarnings).toHaveLength(1);
  });

  it("keeps separate warnings for different case IDs in the same stage", () => {
    const firstFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };
    const secondFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-2",
      caseTitle: "Case 2",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [firstFailure, secondFailure],
    });

    const automationWarnings = report.warnings.filter((warning) => warning.code === "automation_failed");

    expect(automationWarnings).toHaveLength(2);
    expect(automationWarnings.map((warning) => warning.href)).toEqual([
      "/pipelines/pipeline-1/items/case-1",
      "/pipelines/pipeline-1/items/case-2",
    ]);
  });

  it("keeps separate warnings for the same case ID in different stages", () => {
    const firstFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };
    const secondFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-2",
      stageKey: "verify",
      stageName: "Verify",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [firstFailure, secondFailure],
    });

    const automationWarnings = report.warnings.filter((warning) => warning.code === "automation_failed");

    expect(automationWarnings).toHaveLength(2);
    expect(automationWarnings.map((warning) => warning.stageId)).toEqual(["stage-1", "stage-2"]);
  });

  it("keeps separate warnings when stage and case IDs would collide with colon-delimited keys", () => {
    const firstFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage:one",
      stageKey: "build",
      stageName: "Build",
      caseId: "case",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };
    const secondFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage",
      stageKey: "verify",
      stageName: "Verify",
      caseId: "one:case",
      caseTitle: "Case 2",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [firstFailure, secondFailure],
    });

    const automationWarnings = report.warnings.filter((warning) => warning.code === "automation_failed");

    expect(automationWarnings).toHaveLength(2);
    expect(automationWarnings.map((warning) => warning.href)).toEqual([
      "/pipelines/pipeline-1/items/case",
      "/pipelines/pipeline-1/items/one:case",
    ]);
  });
});
