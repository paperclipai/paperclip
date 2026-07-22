// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowListItem } from "@paperclipai/shared";
import { ArchiveConfirmation, filterWorkflowItems, getWorkflowEmptyStateMessage, WorkflowCard } from "./Workflows";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

  it("renders inline archive confirmation and exposes confirm/cancel actions", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      root.render(<ArchiveConfirmation title="Social" onConfirm={onConfirm} onCancel={onCancel} />);
    });

    expect(container.textContent).toContain("Runs and history remain available.");
    const buttons = Array.from(container.querySelectorAll("button"));
    await act(async () => {
      buttons.find((button) => button.textContent === "Cancel")?.click();
      buttons.find((button) => button.textContent === "Archive workflow")?.click();
    });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
    await act(async () => {
      root.unmount();
    });
  });

  it("renders lifecycle actions and shared status treatment by workflow state", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onArchive = vi.fn();
    const onRestore = vi.fn();

    await act(async () => {
      root.render(
        <WorkflowCard
          item={workflow("active", "active-1")}
          archiveConfirmationOpen={false}
          onArchive={onArchive}
          onConfirmArchive={vi.fn()}
          onCancelArchive={vi.fn()}
          onRestore={onRestore}
        />,
      );
    });

    expect(container.textContent).toContain("active");
    expect(container.textContent).toContain("Archive");
    expect(container.textContent).not.toContain("Restore");
    expect(container.querySelector('[data-slot="card"]')?.className).toContain("rounded-xl");
    container.querySelector("button")?.click();
    expect(onArchive).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(
        <WorkflowCard
          item={workflow("archived", "archived-1")}
          archiveConfirmationOpen={false}
          onArchive={onArchive}
          onConfirmArchive={vi.fn()}
          onCancelArchive={vi.fn()}
          onRestore={onRestore}
        />,
      );
    });

    expect(container.textContent).toContain("archived");
    expect(container.textContent).toContain("Restore");
    expect(Array.from(container.querySelectorAll("button")).map((button) => button.textContent)).not.toContain("Archive");
    container.querySelector("button")?.click();
    expect(onRestore).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
    });
  });
});
