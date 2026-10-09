// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueFiltersPopover } from "./IssueFiltersPopover";
import { defaultIssueFilterState } from "../lib/issue-filters";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="popover-content" className={className}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked }: { checked?: boolean }) => <input type="checkbox" checked={checked} readOnly />,
}));

vi.mock("./StatusIcon", () => ({
  StatusIcon: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("./PriorityIcon", () => ({
  PriorityIcon: ({ priority }: { priority: string }) => <span>{priority}</span>,
}));

describe("IssueFiltersPopover", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses a scrollable popover and a three-column desktop grid", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueFiltersPopover
          presentation="streamlined"
          state={defaultIssueFilterState}
          onChange={vi.fn()}
          activeFilterCount={0}
          agents={[{ id: "agent-1", name: "Agent One" }]}
          projects={[{ id: "project-1", name: "Project One" }]}
          labels={[{ id: "label-1", name: "Bug", color: "#ff0000" }]}
          workspaces={[{ id: "workspace-1", name: "Workspace One" }]}
          enableRoutineVisibilityFilter
        />,
      );
    });

    const popoverContent = container.querySelector("[data-testid='popover-content']");
    expect(popoverContent).not.toBeNull();
    expect(popoverContent?.className).toContain("overflow-y-auto");
    expect(popoverContent?.className).toContain("max-h-(--sz-calc-9)");
    expect(popoverContent?.querySelectorAll(".overflow-y-auto").length).toBe(0);

    const layoutGrid = Array.from(popoverContent?.querySelectorAll("div") ?? []).find((element) =>
      element.className.includes("md:grid-cols-3"),
    );
    expect(layoutGrid?.className).toContain("grid-cols-1");
    expect(popoverContent?.textContent).toContain("Live runs only");
  });

  it("hides the Priority filter section while priority UI is off (PAP-411)", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueFiltersPopover
          presentation="streamlined"
          state={defaultIssueFilterState}
          onChange={vi.fn()}
          activeFilterCount={0}
          agents={[{ id: "agent-1", name: "Agent One" }]}
          projects={[{ id: "project-1", name: "Project One" }]}
          labels={[{ id: "label-1", name: "Bug", color: "#ff0000" }]}
          workspaces={[{ id: "workspace-1", name: "Workspace One" }]}
          enableRoutineVisibilityFilter
        />,
      );
    });

    const popoverContent = container.querySelector("[data-testid='popover-content']");
    expect(popoverContent).not.toBeNull();
    // Status section still renders, Priority section is gated off (PAP-411).
    expect(popoverContent?.textContent).toContain("Status");
    expect(popoverContent?.textContent).not.toContain("Priority");
  });

  it("searches long option lists while the popover remains the only scroll owner", () => {
    const root = createRoot(container);
    const agents = Array.from({ length: 7 }, (_, index) => ({
      id: `agent-${index + 1}`,
      name: `Agent ${index + 1}`,
    }));

    act(() => {
      root.render(
        <IssueFiltersPopover
          presentation="streamlined"
          state={defaultIssueFilterState}
          onChange={vi.fn()}
          activeFilterCount={0}
          agents={agents}
          enableExternalObjectFilters={false}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search responsible"]');
    expect(input).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, "Agent 7");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const responsibleOptions = container.querySelector('[data-filter-options="responsible"]');
    expect(responsibleOptions?.textContent).toContain("Agent 7");
    expect(responsibleOptions?.textContent).not.toContain("Agent 1");
    expect(container.querySelector('[data-testid="popover-content"]')?.querySelectorAll(".overflow-y-auto").length).toBe(0);

    act(() => root.unmount());
  });

  it("restores per-section scrolling and hides added option searches in legacy presentation", () => {
    const root = createRoot(container);
    const agents = Array.from({ length: 7 }, (_, index) => ({
      id: `agent-${index + 1}`,
      name: `Agent ${index + 1}`,
    }));

    act(() => {
      root.render(
        <IssueFiltersPopover
          state={defaultIssueFilterState}
          onChange={vi.fn()}
          activeFilterCount={0}
          agents={agents}
          projects={Array.from({ length: 7 }, (_, index) => ({
            id: `project-${index + 1}`,
            name: `Project ${index + 1}`,
          }))}
          presentation="legacy"
          enableExternalObjectFilters={false}
        />,
      );
    });

    const popoverContent = container.querySelector("[data-testid='popover-content']");
    expect(popoverContent?.className).not.toContain("overflow-y-auto");
    expect(container.querySelector('input[aria-label="Search responsible"]')).toBeNull();
    expect(container.querySelector('[data-filter-options="responsible"]')?.className).toContain("overflow-y-auto");
    expect(container.querySelector('[data-filter-options="projects"]')?.className).toContain("overflow-y-auto");

    act(() => root.unmount());
  });

  it("integrates Inbox category and approval status into the filter menu", () => {
    const root = createRoot(container);
    const onChange = vi.fn();
    const onCategoryChange = vi.fn();
    const onApprovalStatusChange = vi.fn();
    const onClear = vi.fn();

    act(() => {
      root.render(
        <IssueFiltersPopover
          presentation="streamlined"
          state={defaultIssueFilterState}
          onChange={onChange}
          activeFilterCount={2}
          enableExternalObjectFilters={false}
          inboxScopeFilters={{
            category: "approvals",
            approvalStatus: "actionable",
            showApprovalStatus: true,
            onCategoryChange,
            onApprovalStatusChange,
            onClear,
          }}
        />,
      );
    });

    const categoryOptions = container.querySelector('[data-filter-options="inbox-category"]');
    const approvalOptions = container.querySelector('[data-filter-options="inbox-approval-status"]');
    expect(categoryOptions?.textContent).toContain("All categories");
    expect(categoryOptions?.querySelector('button[aria-pressed="true"]')?.textContent).toContain("Approvals");
    expect(approvalOptions?.querySelector('button[aria-pressed="true"]')?.textContent).toContain("Needs action");

    const allCategoriesButton = Array.from(categoryOptions?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent?.includes("All categories"));
    const resolvedButton = Array.from(approvalOptions?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent?.includes("Resolved"));
    act(() => allCategoriesButton?.click());
    act(() => resolvedButton?.click());
    expect(onCategoryChange).toHaveBeenCalledWith("everything");
    expect(onApprovalStatusChange).toHaveBeenCalledWith("resolved");

    const clearButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Clear");
    act(() => clearButton?.click());
    expect(onChange).toHaveBeenCalledWith(defaultIssueFilterState);
    expect(onClear).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });
});
