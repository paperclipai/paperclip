// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueProperties } from "./IssueProperties";

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listLabels: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
  }),
}));

vi.mock("../lib/recent-assignees", () => ({
  getRecentAssigneeIds: () => [],
  sortAgentsByRecency: (agents: unknown[]) => agents,
  trackRecentAssignee: vi.fn(),
}));

vi.mock("../lib/assignees", () => ({
  formatAssigneeUserLabel: () => "Me",
}));

vi.mock("./StatusIcon", () => ({
  StatusIcon: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("./PriorityIcon", () => ({
  PriorityIcon: ({ priority }: { priority: string }) => <span>{priority}</span>,
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Parent issue",
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
    createdByUserId: "user-1",
    issueNumber: 1,
    identifier: "PAP-1",
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
    blockedBy: [],
    blocks: [],
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:05:00.000Z"),
    ...overrides,
  };
}

function createExecutionPolicy(overrides: Partial<IssueExecutionPolicy> = {}): IssueExecutionPolicy {
  return {
    mode: "normal",
    commentRequired: true,
    stages: [],
    ...overrides,
  };
}

function createExecutionState(overrides: Partial<IssueExecutionState> = {}): IssueExecutionState {
  return {
    status: "changes_requested",
    currentStageId: "stage-1",
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: "agent-1", userId: null },
    returnAssignee: { type: "agent", agentId: "agent-2", userId: null },
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: "changes_requested",
    ...overrides,
  };
}

function renderProperties(container: HTMLDivElement, props: ComponentProps<typeof IssueProperties>) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IssueProperties {...props} />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("IssueProperties", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listLabels.mockResolvedValue([]);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("always exposes the add sub-issue action", async () => {
    const onAddSubIssue = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onAddSubIssue,
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).toContain("Sub-issues");
    expect(container.textContent).toContain("Add sub-issue");

    const addButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Add sub-issue"));
    expect(addButton).not.toBeUndefined();

    await act(async () => {
      addButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAddSubIssue).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("shows an add-label button when labels already exist and opens the picker", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        labels: [{ id: "label-1", companyId: "company-1", name: "Bug", color: "#ef4444", createdAt: new Date("2026-04-06T12:00:00.000Z"), updatedAt: new Date("2026-04-06T12:00:00.000Z") }],
        labelIds: ["label-1"],
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    const addLabelButton = container.querySelector('button[aria-label="Add label"]');
    expect(addLabelButton).not.toBeNull();
    expect(container.querySelector('input[placeholder="Search labels..."]')).toBeNull();

    await act(async () => {
      addLabelButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('input[placeholder="Search labels..."]')).not.toBeNull();
    expect(container.querySelector('button[title="Delete Bug"]')).toBeNull();

    act(() => root.unmount());
  });

  it("allows setting and clearing a parent issue from the properties pane", async () => {
    const onUpdate = vi.fn();
    mockIssuesApi.list.mockResolvedValue([
      createIssue({ id: "issue-2", identifier: "PAP-2", title: "Candidate parent", status: "in_progress" }),
    ]);

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const parentTrigger = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("No parent"));
    expect(parentTrigger).not.toBeUndefined();

    await act(async () => {
      parentTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const candidateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-2 Candidate parent"));
    expect(candidateButton).not.toBeUndefined();

    await act(async () => {
      candidateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ parentId: "issue-2" });

    onUpdate.mockClear();
    const rerenderedIssue = createIssue({
      parentId: "issue-2",
      ancestors: [
        {
          id: "issue-2",
          identifier: "PAP-2",
          title: "Candidate parent",
          description: null,
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
          projectId: null,
          goalId: null,
          project: null,
          goal: null,
        },
      ],
    });

    act(() => root.unmount());

    const rerenderedRoot = renderProperties(container, {
      issue: rerenderedIssue,
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const selectedParentTrigger = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-2 Candidate parent"));
    expect(selectedParentTrigger).not.toBeUndefined();
    const parentLink = container.querySelector('a[href="/issues/PAP-2"]');
    expect(parentLink).not.toBeNull();
    expect(selectedParentTrigger!.contains(parentLink)).toBe(false);

    await act(async () => {
      selectedParentTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const clearParentButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("No parent"));
    expect(clearParentButton).not.toBeUndefined();

    await act(async () => {
      clearParentButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ parentId: null });

    act(() => rerenderedRoot.unmount());
  });

  it("shows a run review action after reviewers are configured and starts execution explicitly when clicked", async () => {
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({
        executionPolicy: createExecutionPolicy({
          stages: [
            {
              id: "review-stage",
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: "participant-1", type: "agent", agentId: "agent-1", userId: null }],
            },
          ],
        }),
      }),
      childIssues: [],
      onUpdate,
    });
    await flush();

    const runReviewButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Run review now"));
    expect(runReviewButton).not.toBeUndefined();

    await act(async () => {
      runReviewButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ status: "in_review" });

    act(() => root.unmount());
  });

  it("shows a run approval action when approval is the next runnable stage", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        executionPolicy: createExecutionPolicy({
          stages: [
            {
              id: "approval-stage",
              type: "approval",
              approvalsNeeded: 1,
              participants: [{ id: "participant-2", type: "user", agentId: null, userId: "user-1" }],
            },
          ],
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).toContain("Run approval now");
    expect(container.textContent).not.toContain("Run review now");

    act(() => root.unmount());
  });

  it("keeps the run review action available after changes are requested", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        status: "in_progress",
        executionPolicy: createExecutionPolicy({
          stages: [
            {
              id: "review-stage",
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: "participant-1", type: "agent", agentId: "agent-1", userId: null }],
            },
          ],
        }),
        executionState: createExecutionState(),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).toContain("Run review now");

    act(() => root.unmount());
  });

  it("hides the run action while an execution stage is already pending", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        status: "in_review",
        executionPolicy: createExecutionPolicy({
          stages: [
            {
              id: "review-stage",
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: "participant-1", type: "agent", agentId: "agent-1", userId: null }],
            },
          ],
        }),
        executionState: createExecutionState({
          status: "pending",
          currentStageType: "review",
          lastDecisionOutcome: null,
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).not.toContain("Run review now");
    expect(container.textContent).not.toContain("Run approval now");

    act(() => root.unmount());
  });
});
