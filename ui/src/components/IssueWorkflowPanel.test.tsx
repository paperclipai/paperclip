// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ComponentProps } from "react";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueWorkflowPanel } from "./IssueWorkflowPanel";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => <button {...props}>{children}</button>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-101",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue title",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 101,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    createdAt: new Date("2026-04-18T00:00:00.000Z"),
    updatedAt: new Date("2026-04-18T00:00:00.000Z"),
    ...overrides,
  };
}

describe("IssueWorkflowPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the apply button for root issues without a workflow", () => {
    const root = createRoot(container);
    const onApply = vi.fn();

    act(() => {
      root.render(<IssueWorkflowPanel issue={createIssue()} onApplyEngineeringDeliveryWorkflow={onApply} />);
    });

    const applyButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Apply engineering workflow"));
    expect(applyButton).toBeTruthy();

    act(() => {
      applyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onApply).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("renders lane summaries for workflow parents", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueWorkflowPanel
          issue={createIssue({
            workflowTemplateKey: "engineering_delivery_v1",
            workflowSummary: {
              templateKey: "engineering_delivery_v1",
              isBlocked: true,
              blockingReasons: ["SECURITY: Lane has no assigned owner."],
              activeRoles: ["pm"],
              waitingRoles: ["security"],
              ownerNeededRoles: ["qa"],
              lanes: [
                {
                  issueId: "issue-pm",
                  role: "pm",
                  title: "PM: Issue title",
                  status: "done",
                  phase: "done",
                  assigneeAgentId: "agent-pm",
                  assigneeUserId: null,
                  workspaceMode: null,
                  blockedByRoles: [],
                  ready: false,
                  unresolvedOwnership: false,
                  artifactStatuses: [
                    {
                      key: "plan",
                      label: "Plan document",
                      kind: "document",
                      blocking: true,
                      satisfied: true,
                      stale: false,
                      detail: null,
                    },
                  ],
                  blockingReasons: [],
                },
                {
                  issueId: "issue-security",
                  role: "security",
                  title: "Security: Issue title",
                  status: "todo",
                  phase: "waiting",
                  assigneeAgentId: null,
                  assigneeUserId: null,
                  workspaceMode: "isolated_workspace",
                  blockedByRoles: ["engineer"],
                  ready: false,
                  unresolvedOwnership: true,
                  artifactStatuses: [],
                  blockingReasons: ["Lane has no assigned owner."],
                },
                {
                  issueId: "issue-qa",
                  role: "qa",
                  title: "QA: Issue title",
                  status: "todo",
                  phase: "ready",
                  assigneeAgentId: null,
                  assigneeUserId: null,
                  workspaceMode: "isolated_workspace",
                  blockedByRoles: [],
                  ready: true,
                  unresolvedOwnership: true,
                  artifactStatuses: [],
                  blockingReasons: ["Workflow QA lane requires an authorized release-gate QA owner."],
                },
              ],
            },
          })}
          agentNamesById={new Map([["agent-pm", "PM Agent"]])}
        />,
      );
    });

    expect(container.textContent).toContain("Specialist delivery lanes");
    expect(container.textContent).toContain("PM: Issue title");
    expect(container.textContent).toContain("Security: Issue title");
    expect(container.textContent).toContain("QA: Issue title");
    expect(container.textContent).toContain("SECURITY: Lane has no assigned owner.");
    expect(container.textContent).toContain("Actionable now");
    expect(container.textContent).toContain("PM");
    expect(container.textContent).toContain("QA");
    expect(container.textContent).toContain("Waiting on dependencies");
    expect(container.textContent).toContain("Security");
    expect(container.textContent).toContain("Needs owner");
    expect(container.textContent).toContain("Waiting on Build");
    const laneLink = Array.from(container.querySelectorAll("a")).find((node) => node.textContent?.includes("PM: Issue title"));
    expect(laneLink?.getAttribute("href")).toBe("/issues/issue-pm");

    act(() => {
      root.unmount();
    });
  });

  it("renders required artifact states for workflow lane issues", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueWorkflowPanel
          issue={createIssue({
            workflowTemplateKey: "engineering_delivery_v1",
            workflowLaneRole: "security",
            workflowArtifactStatus: [
              {
                key: "threat-review",
                label: "Threat review document",
                kind: "document",
                blocking: true,
                satisfied: false,
                stale: true,
                detail: "Threat review document is stale and must be refreshed after upstream changes.",
              },
            ],
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Security lane requirements");
    expect(container.textContent).toContain("Threat review document");
    expect(container.textContent).toContain("Stale");

    act(() => {
      root.unmount();
    });
  });
});
