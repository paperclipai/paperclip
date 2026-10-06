// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueFiltersPopover } from "./IssueFiltersPopover";
import { defaultIssueFilterState } from "../lib/issue-filters";
import { i18n } from "@/i18n";

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
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    await i18n.changeLanguage("en");
  });

  it("uses a scrollable popover and a three-column desktop grid", () => {

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

  });

  it("restores per-section scrolling and hides added option searches in legacy presentation", () => {
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

  });

  it("integrates Inbox category and approval status into the filter menu", () => {
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

  });
  it("updates an open filter menu from ru to en to ru while retaining search and selections", async () => {
    const onChange = vi.fn();
    await act(async () => { await i18n.changeLanguage("ru"); });
    act(() => {
      root.render(
        <IssueFiltersPopover
          presentation="streamlined"
          state={{ ...defaultIssueFilterState, statuses: ["in_progress"] }}
          onChange={onChange}
          activeFilterCount={1}
          agents={Array.from({ length: 7 }, (_, index) => ({ id: `agent-${index}`, name: `Agent ${index}` }))}
          inboxScopeFilters={{
            category: "approvals", approvalStatus: "actionable", showApprovalStatus: true,
            onCategoryChange: vi.fn(), onApprovalStatusChange: vi.fn(), onClear: vi.fn(),
          }}
        />,
      );
    });
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Поиск ответственных"]')!;
    expect(search).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "Agent 6");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    for (const locale of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.textContent).toContain(locale === "ru" ? "Быстрые фильтры" : "Quick filters");
      expect(container.textContent).toContain(locale === "ru" ? "Все категории" : "All categories");
      expect(container.textContent).toContain(locale === "ru" ? "Любые с ошибкой" : "Any failed");
      expect(search.getAttribute("aria-label")).toBe(locale === "ru" ? "Поиск ответственных" : "Search responsible");
      expect(search.value).toBe("Agent 6");
      expect(container.querySelector('[data-filter-options="responsible"]')?.textContent).toContain("Agent 6");
      expect(container.querySelector('[data-filter-options="responsible"]')?.textContent).not.toContain("Agent 1");
      const selectedStatus = container.querySelector<HTMLInputElement>('input[type="checkbox"]:checked');
      expect(selectedStatus?.closest("label")?.textContent).toContain(locale === "ru" ? "В работе" : "In Progress");
    }
    const activePreset = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Активные");
    act(() => activePreset?.click());
    expect(onChange).toHaveBeenLastCalledWith({ statuses: ["todo", "in_progress", "in_review", "blocked"] });
  });

});
