import { describe, expect, it } from "vitest";
import type { WorkflowListItem } from "@paperclipai/shared";
import { filterWorkflowItems, getWorkflowEmptyStateMessage } from "./Workflows";

function workflow(status: string, id: string): WorkflowListItem {
  return {
    id,
    companyId: "company-1",
    title: id,
    description: null,
    status,
    runnerType: "google_adk",
    runnerConfig: {},
    pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
    pipelineSourceHash: null,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    latestRun: null,
    currentPhase: null,
    latestDeliverable: null,
  };
}

describe("workflow list archival filter", () => {
  const items = [workflow("active", "active-1"), workflow("paused", "paused-1"), workflow("archived", "archived-1")];

  it("excludes archived workflows from default active view", () => {
    expect(filterWorkflowItems(items, "active").map((item) => item.id)).toEqual(["active-1", "paused-1"]);
  });

  it("shows only archived workflows in archived view", () => {
    expect(filterWorkflowItems(items, "archived").map((item) => item.id)).toEqual(["archived-1"]);
  });

  it("shows all workflows in all view", () => {
    expect(filterWorkflowItems(items, "all").map((item) => item.id)).toEqual(["active-1", "paused-1", "archived-1"]);
  });

  it("explains when active view contains only archived workflows", () => {
    expect(getWorkflowEmptyStateMessage([workflow("archived", "archived-1")], "active"))
      .toBe("All workflows are archived. Switch to the Archived view to see them.");
    expect(getWorkflowEmptyStateMessage([], "active"))
      .toContain("No workflows yet.");
  });
});
