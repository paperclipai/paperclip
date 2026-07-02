// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CustomDashboardBuilder,
  DEFAULT_WORK_HUB_WIDGETS,
} from "./CustomDashboardBuilder";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function issue(overrides: Partial<Issue>): Issue {
  const now = new Date("2026-07-01T00:00:00Z");
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue",
    description: null,
    status: "todo",
    workMode: "standard",
    workItemType: "human_task",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: "user-1",
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    dueDate: null,
    workLeadDays: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    visibility: "company",
    hiddenAt: null,
    storyPoints: null,
    estimateHours: null,
    actualAiSeconds: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("CustomDashboardBuilder", () => {
  let root: Root | null = null;
  let host: HTMLDivElement;

  beforeEach(() => {
    window.localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host.remove();
    window.localStorage.clear();
  });

  function render() {
    const storageKey = "paperclip:test-dashboard";
    act(() => {
      root = createRoot(host);
      root.render(
        <CustomDashboardBuilder
          storageKey={storageKey}
          title="Dashboard widgets"
          subtitle="Customize project metrics."
          issues={[
            issue({ id: "human-1", storyPoints: 3, estimateHours: 5 }),
            issue({ id: "blocked-1", status: "blocked", storyPoints: 8, estimateHours: 13 }),
            issue({
              id: "ai-1",
              workItemType: "ai_task",
              assigneeUserId: null,
              assigneeAgentId: "agent-1",
              actualAiSeconds: 7200,
            }),
          ]}
          defaultWidgets={DEFAULT_WORK_HUB_WIDGETS.slice(0, 2)}
        />,
      );
    });
    return storageKey;
  }

  it("renders live metrics and persists selected widgets", () => {
    const storageKey = render();

    expect(host.textContent).toContain("Dashboard widgets");
    expect(host.textContent).toContain("11");
    expect(host.textContent).toContain("Story points");

    const customize = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Metrics"));
    expect(customize).toBeTruthy();
    act(() => {
      customize!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const metricToggle = host.querySelector('input[value="actual_ai_hours"]') as HTMLInputElement;
    expect(metricToggle).toBeTruthy();
    act(() => {
      metricToggle.click();
    });

    expect(window.localStorage.getItem(storageKey)).toContain("actual_ai_hours");
  });
});
