import { describe, expect, it } from "vitest";
import { PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE } from "@paperclipai/shared";
import {
  buildStageAutomationForSave,
  isPipelineSettingsStageSectionAvailable,
  pipelineAutomationTitleTemplate,
  resolvePipelineSettingsFallbackStageId,
  syncPipelineStageAutomationVariables,
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

describe("pipeline automation issue title templates", () => {
  it("defaults blank title templates for saved stage automation", () => {
    expect(pipelineAutomationTitleTemplate("")).toBe(PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE);
    expect(pipelineAutomationTitleTemplate("  ")).toBe(PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE);
  });

  it("includes a custom issue title template in the stage automation save payload", () => {
    expect(
      buildStageAutomationForSave({
        assigneeAgentId: "agent-1",
        titleTemplate: "Review {{case_key}} for {{market}}",
        instructionsBody: "Score {{market}} and move the item forward.",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        executionWorkspaceId: "execution-workspace-1",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      }),
    ).toEqual({
      assigneeAgentId: "agent-1",
      titleTemplate: "Review {{case_key}} for {{market}}",
      instructionsBody: "Score {{market}} and move the item forward.",
      projectId: "project-1",
      projectWorkspaceId: "workspace-1",
      executionWorkspaceId: "execution-workspace-1",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  it("detects variables from the issue title template and instructions", () => {
    const variables = syncPipelineStageAutomationVariables(
      "{{pipeline_name}} / {{stage_name}}: {{case_title}} for {{market}}",
      "Summarize {{case_summary}} by {{dueDate}}.",
      [],
    );

    expect(variables.map((variable) => [variable.name, variable.type])).toEqual([
      ["pipeline_name", "text"],
      ["stage_name", "text"],
      ["case_title", "text"],
      ["market", "text"],
      ["case_summary", "text"],
      ["dueDate", "date"],
    ]);
  });
});
