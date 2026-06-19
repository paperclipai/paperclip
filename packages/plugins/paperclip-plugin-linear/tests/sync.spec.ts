import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { STATE_KEYS } from "../src/constants.js";
import {
  createLink,
  createGoalLink,
  createProjectLink,
  createMilestoneLink,
  getGoalLink,
  getLink,
  getGoalLinkByLinear,
  getLinkByLinear,
  getProjectLink,
  getProjectLinkByLinear,
  updateGoalLink,
  syncFromLinear,
  syncToLinear,
  type GoalLink,
  type IssueLink,
  type MilestoneLink,
  type ProjectLink,
} from "../src/sync.js";
import * as linearApi from "../src/linear.js";
import type { LinearIssue } from "../src/linear.js";

function makeLink(overrides: Partial<IssueLink> = {}): IssueLink {
  return {
    paperclipIssueId: "pc-1",
    paperclipCompanyId: "comp-1",
    linearIssueId: "lin-1",
    linearIdentifier: "BLO-1",
    linearUrl: "https://linear.app/blockc/issue/BLO-1",
    syncDirection: "bidirectional",
    lastSyncAt: "2026-06-10T00:00:00.000Z",
    lastLinearStateType: "unstarted",
    lastCommentSyncAt: null,
    ...overrides,
  };
}

function makeLinearIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "lin-1",
    identifier: "BLO-1",
    title: "Linear title",
    description: null,
    state: { name: "In Progress", type: "started" },
    priority: 2,
    url: "https://linear.app/blockc/issue/BLO-1",
    assignee: null,
    labels: { nodes: [] },
    project: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeProjectLink(overrides: Partial<ProjectLink> = {}): ProjectLink {
  return {
    paperclipProjectId: "pc-proj-1",
    paperclipCompanyId: "comp-1",
    linearProjectId: "lin-proj-1",
    linearProjectName: "Linear Project",
    syncDirection: "bidirectional",
    lastSyncAt: "2026-06-10T00:00:00.000Z",
    lastLinearState: "started",
    ...overrides,
  };
}

function makeGoalLink(overrides: Partial<GoalLink> = {}): GoalLink {
  return {
    paperclipGoalId: "pc-goal-1",
    paperclipCompanyId: "comp-1",
    linearIssueId: "lin-goal-1",
    linearIdentifier: "lin-goal-1",
    linearUrl: "https://linear.app/initiatives/lin-goal-1",
    linearProjectId: null,
    lastSyncAt: "2026-06-10T00:00:00.000Z",
    lastTitle: "Goal title",
    lastStatus: "active",
    lastTargetDate: null,
    lastLevel: "task",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("link lookup", () => {
  it("ignores malformed issue forward link state", async () => {
    const harness = createTestHarness({ manifest });
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}pc-1` },
      JSON.stringify(makeLink({ paperclipIssueId: "pc-1", linearIssueId: "lin-1" })),
    );

    await expect(getLink(harness.ctx, "pc-1")).resolves.toBeNull();
  });

  it("ignores stale Linear issue reverse keys that point at a different forward link", async () => {
    const harness = createTestHarness({ manifest });
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}pc-1` },
      makeLink({ paperclipIssueId: "pc-1", linearIssueId: "lin-current" }),
    );
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.linearPrefix}lin-stale` },
      "pc-1",
    );
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.linearPrefix}lin-current` },
      "pc-1",
    );

    await expect(getLinkByLinear(harness.ctx, "lin-stale")).resolves.toBeNull();
    await expect(getLinkByLinear(harness.ctx, "lin-current")).resolves.toMatchObject({
      paperclipIssueId: "pc-1",
      linearIssueId: "lin-current",
    });
  });

  it("writes the host Linear issue link when creating plugin link state", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "Paperclip-originated issue",
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
    });

    await createLink(harness.ctx, {
      paperclipIssueId: "pc-1",
      paperclipCompanyId: "comp-1",
      linearIssueId: "lin-1",
      linearIdentifier: "BLO-1",
      linearUrl: "https://linear.app/blockc/issue/BLO-1",
      linearStateType: "unstarted",
      syncDirection: "bidirectional",
    });

    await expect(harness.ctx.issues.getByLinearIssueId({
      companyId: "comp-1",
      linearIssueId: "lin-1",
    })).resolves.toMatchObject({ id: "pc-1" });
    await expect(getLinkByLinear(harness.ctx, "lin-1")).resolves.toMatchObject({
      paperclipIssueId: "pc-1",
      linearIssueId: "lin-1",
    });
  });

  it("repairs plugin link state when the host Linear link already points at the same issue", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "Host-originated mirror",
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
      linearIssueLinks: [
        {
          companyId: "comp-1",
          paperclipIssueId: "pc-1",
          linearIssueId: "lin-1",
        },
      ],
    });
    vi.spyOn(harness.ctx.issues, "linkLinearIssue")
      .mockRejectedValueOnce({ error: "Linear issue link conflict" });

    await createLink(harness.ctx, {
      paperclipIssueId: "pc-1",
      paperclipCompanyId: "comp-1",
      linearIssueId: "lin-1",
      linearIdentifier: "BLO-1",
      linearUrl: "https://linear.app/blockc/issue/BLO-1",
      linearStateType: "unstarted",
      syncDirection: "bidirectional",
    });

    await expect(getLinkByLinear(harness.ctx, "lin-1")).resolves.toMatchObject({
      paperclipIssueId: "pc-1",
      linearIssueId: "lin-1",
      linearIdentifier: "BLO-1",
    });
  });

  it("replaces a stale host link for the same Paperclip issue when requested", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "Paperclip mirror with stale host link",
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
      linearIssueLinks: [
        {
          companyId: "comp-1",
          paperclipIssueId: "pc-1",
          linearIssueId: "lin-stale",
        },
      ],
    });

    await createLink(harness.ctx, {
      paperclipIssueId: "pc-1",
      paperclipCompanyId: "comp-1",
      linearIssueId: "lin-current",
      linearIdentifier: "BLO-1005",
      linearUrl: "https://linear.app/blockc/issue/BLO-1005",
      linearStateType: "unstarted",
      syncDirection: "bidirectional",
      replaceExisting: true,
    });

    await expect(harness.ctx.issues.getByLinearIssueId({
      companyId: "comp-1",
      linearIssueId: "lin-stale",
    })).resolves.toBeNull();
    await expect(harness.ctx.issues.getByLinearIssueId({
      companyId: "comp-1",
      linearIssueId: "lin-current",
    })).resolves.toMatchObject({ id: "pc-1" });
    await expect(getLinkByLinear(harness.ctx, "lin-current")).resolves.toMatchObject({
      paperclipIssueId: "pc-1",
      linearIssueId: "lin-current",
      linearIdentifier: "BLO-1005",
    });
  });

  it("does not repair plugin link state when a host conflict points at another issue", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "Target issue",
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
        {
          id: "pc-2",
          companyId: "comp-1",
          title: "Existing linked issue",
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
      linearIssueLinks: [
        {
          companyId: "comp-1",
          paperclipIssueId: "pc-2",
          linearIssueId: "lin-1",
        },
      ],
    });
    vi.spyOn(harness.ctx.issues, "linkLinearIssue")
      .mockRejectedValueOnce(new Error("Linear issue link conflict"));

    await expect(createLink(harness.ctx, {
      paperclipIssueId: "pc-1",
      paperclipCompanyId: "comp-1",
      linearIssueId: "lin-1",
      linearIdentifier: "BLO-1",
      linearUrl: "https://linear.app/blockc/issue/BLO-1",
      linearStateType: "unstarted",
      syncDirection: "bidirectional",
    })).rejects.toThrow("Linear issue link conflict");

    await expect(getLinkByLinear(harness.ctx, "lin-1")).resolves.toBeNull();
  });

  it("ignores malformed project forward link state", async () => {
    const harness = createTestHarness({ manifest });
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.projectLinkPrefix}pc-proj-1` },
      JSON.stringify(makeProjectLink({ paperclipProjectId: "pc-proj-1", linearProjectId: "lin-proj-1" })),
    );

    await expect(getProjectLink(harness.ctx, "pc-proj-1")).resolves.toBeNull();
  });

  it("ignores stale Linear project reverse keys that point at a different forward link", async () => {
    const harness = createTestHarness({ manifest });
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.projectLinkPrefix}pc-proj-1` },
      makeProjectLink({ paperclipProjectId: "pc-proj-1", linearProjectId: "lin-proj-current" }),
    );
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.projectLinearPrefix}lin-proj-stale` },
      "pc-proj-1",
    );
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.projectLinearPrefix}lin-proj-current` },
      "pc-proj-1",
    );

    await expect(getProjectLinkByLinear(harness.ctx, "lin-proj-stale")).resolves.toBeNull();
    await expect(getProjectLinkByLinear(harness.ctx, "lin-proj-current")).resolves.toMatchObject({
      paperclipProjectId: "pc-proj-1",
      linearProjectId: "lin-proj-current",
    });
  });

  it("ignores stale Linear goal reverse keys that point at a different forward link", async () => {
    const harness = createTestHarness({ manifest });
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.goalLinkPrefix}pc-goal-1` },
      makeGoalLink({ paperclipGoalId: "pc-goal-1", linearIssueId: "lin-goal-current" }),
    );
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.goalLinearPrefix}lin-goal-stale` },
      "pc-goal-1",
    );
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.goalLinearPrefix}lin-goal-current` },
      "pc-goal-1",
    );

    await expect(getGoalLinkByLinear(harness.ctx, "lin-goal-stale")).resolves.toBeNull();
    await expect(getGoalLinkByLinear(harness.ctx, "lin-goal-current")).resolves.toMatchObject({
      paperclipGoalId: "pc-goal-1",
      linearIssueId: "lin-goal-current",
    });
  });

  it("repoints Linear goal reverse keys when an existing goal link moves to an initiative", async () => {
    const harness = createTestHarness({ manifest });
    const existing = makeGoalLink({
      paperclipGoalId: "pc-goal-1",
      linearIssueId: "lin-goal-old",
      linearProjectId: "company-goals-project",
    });
    await createGoalLink(harness.ctx, existing);

    const persisted = await getGoalLink(harness.ctx, "pc-goal-1");
    expect(persisted).not.toBeNull();
    persisted!.linearIssueId = "lin-goal-new";
    persisted!.linearIdentifier = "lin-goal-new";
    persisted!.linearUrl = "https://linear.app/initiatives/lin-goal-new";
    persisted!.linearProjectId = null;
    await updateGoalLink(harness.ctx, persisted!);

    await expect(getGoalLinkByLinear(harness.ctx, "lin-goal-old")).resolves.toBeNull();
    await expect(getGoalLinkByLinear(harness.ctx, "lin-goal-new")).resolves.toMatchObject({
      paperclipGoalId: "pc-goal-1",
      linearIssueId: "lin-goal-new",
      linearProjectId: null,
    });
  });
});

describe("syncFromLinear", () => {
  it("does not push in_progress to an unassigned Paperclip issue", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "Paperclip title",
          status: "todo",
          priority: "low",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
    });

    const update = vi.spyOn(harness.ctx.issues, "update");

    await syncFromLinear(harness.ctx, makeLink(), makeLinearIssue());

    expect(update).toHaveBeenCalledWith(
      "pc-1",
      expect.not.objectContaining({ status: "in_progress" }),
      "comp-1",
    );
    const issue = await harness.ctx.issues.get("pc-1", "comp-1");
    expect(issue).toMatchObject({
      title: "Linear title",
      status: "todo",
      priority: "high",
    });
    expect(harness.getState({
      scopeKind: "instance",
      stateKey: `${STATE_KEYS.linkPrefix}pc-1`,
    })).toMatchObject({ lastLinearStateType: "unstarted" });
  });

  it("retries a skipped in_progress sync when the Linear assignee later maps", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "Paperclip title",
          status: "todo",
          priority: "low",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
    });

    await syncFromLinear(harness.ctx, makeLink(), makeLinearIssue());
    const skippedLink = harness.getState({
      scopeKind: "instance",
      stateKey: `${STATE_KEYS.linkPrefix}pc-1`,
    }) as IssueLink;
    vi.spyOn(harness.ctx.users, "findByEmail").mockResolvedValue({
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
    });

    await syncFromLinear(
      harness.ctx,
      skippedLink,
      makeLinearIssue({ assignee: { name: "Alice", email: "alice@example.com" } }),
    );

    const issue = await harness.ctx.issues.get("pc-1", "comp-1");
    expect(issue).toMatchObject({
      assigneeUserId: "user-1",
      status: "in_progress",
    });
    expect(harness.getState({
      scopeKind: "instance",
      stateKey: `${STATE_KEYS.linkPrefix}pc-1`,
    })).toMatchObject({ lastLinearStateType: "started" });
  });

  it("pushes in_progress when the Linear assignee maps to a Paperclip user", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "Paperclip title",
          status: "todo",
          priority: "low",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
    });
    vi.spyOn(harness.ctx.users, "findByEmail").mockResolvedValue({
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
    });

    const update = vi.spyOn(harness.ctx.issues, "update");

    await syncFromLinear(
      harness.ctx,
      makeLink(),
      makeLinearIssue({ assignee: { name: "Alice", email: "alice@example.com" } }),
    );

    expect(update).toHaveBeenCalledWith(
      "pc-1",
      expect.objectContaining({ assigneeUserId: "user-1", status: "in_progress" }),
      "comp-1",
    );
    const issue = await harness.ctx.issues.get("pc-1", "comp-1");
    expect(issue).toMatchObject({
      assigneeUserId: "user-1",
      status: "in_progress",
    });
  });

  it("maps Linear In Review to Paperclip in_review when the state type is still started", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "Paperclip title",
          status: "in_progress",
          priority: "low",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
    });

    const update = vi.spyOn(harness.ctx.issues, "update");

    await syncFromLinear(
      harness.ctx,
      makeLink({
        lastLinearStateType: "started",
        lastLinearStateName: "In Progress",
      }),
      makeLinearIssue({ state: { name: "In Review", type: "started" } }),
    );

    expect(update).toHaveBeenCalledWith(
      "pc-1",
      expect.objectContaining({ status: "in_review" }),
      "comp-1",
    );
    expect(harness.getState({
      scopeKind: "instance",
      stateKey: `${STATE_KEYS.linkPrefix}pc-1`,
    })).toMatchObject({
      lastLinearStateType: "started",
      lastLinearStateName: "In Review",
    });
  });

  it("moves an already-linked Paperclip issue to the mapped Linear project", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      projects: [
        {
          id: "old-proj",
          companyId: "comp-1",
          name: "Old Project",
          status: "active",
        } as never,
        {
          id: "pc-proj-1",
          companyId: "comp-1",
          name: "Canonical Project",
          status: "active",
        } as never,
      ],
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          projectId: "old-proj",
          title: "Paperclip title",
          status: "todo",
          priority: "low",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
    });
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.projectLinkPrefix}pc-proj-1` },
      makeProjectLink(),
    );
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.projectLinearPrefix}lin-proj-1` },
      "pc-proj-1",
    );

    const update = vi.spyOn(harness.ctx.issues, "update");

    await syncFromLinear(
      harness.ctx,
      makeLink(),
      makeLinearIssue({
        state: { name: "Backlog", type: "backlog" },
        project: {
          id: "lin-proj-1",
          name: "Canonical Project",
          description: null,
          state: "started",
        },
      }),
    );

    expect(update).toHaveBeenCalledWith(
      "pc-1",
      expect.objectContaining({ projectId: "pc-proj-1" }),
      "comp-1",
    );
    const issue = await harness.ctx.issues.get("pc-1", "comp-1");
    expect(issue).toMatchObject({ projectId: "pc-proj-1" });
  });

  it("retries the Linear sync without projectId when Paperclip rejects the project move", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "Paperclip title",
          status: "todo",
          priority: "low",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
    });
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.projectLinkPrefix}pc-proj-1` },
      makeProjectLink(),
    );
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.projectLinearPrefix}lin-proj-1` },
      "pc-proj-1",
    );

    const update = vi.spyOn(harness.ctx.issues, "update");
    update.mockRejectedValueOnce(new Error("HTTP 422"));

    await syncFromLinear(
      harness.ctx,
      makeLink(),
      makeLinearIssue({
        state: { name: "Backlog", type: "backlog" },
        project: {
          id: "lin-proj-1",
          name: "Canonical Project",
          description: null,
          state: "started",
        },
      }),
    );

    expect(update).toHaveBeenNthCalledWith(
      1,
      "pc-1",
      expect.objectContaining({ projectId: "pc-proj-1" }),
      "comp-1",
    );
    expect(update).toHaveBeenNthCalledWith(
      2,
      "pc-1",
      expect.not.objectContaining({ projectId: expect.anything() }),
      "comp-1",
    );
  });
});

describe("syncToLinear", () => {
  it("maps Paperclip backlog status to the Linear Backlog state", async () => {
    const harness = createTestHarness({ manifest });
    vi.spyOn(linearApi, "getWorkflowStates").mockResolvedValue([
      { id: "state-backlog", name: "Backlog", type: "backlog" },
      { id: "state-todo", name: "Todo", type: "unstarted" },
    ]);
    const updateIssue = vi.spyOn(linearApi, "updateIssue").mockResolvedValue(makeLinearIssue());

    await syncToLinear(
      harness.ctx,
      makeLink({
        lastSyncAt: "2020-01-01T00:00:00.000Z",
        lastLinearStateType: "unstarted",
      }),
      { status: "backlog" },
      "lin-token",
      "team-1",
    );

    expect(updateIssue).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      "lin-1",
      { stateId: "state-backlog" },
    );
  });

  it("maps Paperclip started statuses to exact Linear workflow state names", async () => {
    const harness = createTestHarness({ manifest });
    vi.spyOn(linearApi, "getWorkflowStates").mockResolvedValue([
      { id: "state-review", name: "In Review", type: "started" },
      { id: "state-progress", name: "In Progress", type: "started" },
      { id: "state-todo", name: "Todo", type: "unstarted" },
    ]);
    const updateIssue = vi.spyOn(linearApi, "updateIssue").mockResolvedValue(makeLinearIssue());

    await syncToLinear(
      harness.ctx,
      makeLink({
        lastSyncAt: "2020-01-01T00:00:00.000Z",
        lastLinearStateType: "started",
        lastLinearStateName: "In Review",
      }),
      { status: "in_progress" },
      "lin-token",
      "team-1",
    );

    await syncToLinear(
      harness.ctx,
      makeLink({
        lastSyncAt: "2020-01-01T00:00:00.000Z",
        lastLinearStateType: "started",
        lastLinearStateName: "In Progress",
      }),
      { status: "in_review" },
      "lin-token",
      "team-1",
    );

    expect(updateIssue).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      "lin-token",
      "lin-1",
      { stateId: "state-progress" },
    );
    expect(updateIssue).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      "lin-token",
      "lin-1",
      { stateId: "state-review" },
    );
  });

  it("moves the Linear issue to the bound Linear project when Paperclip projectId changes", async () => {
    const harness = createTestHarness({ manifest });
    await createProjectLink(harness.ctx, {
      paperclipProjectId: "pc-proj-2",
      paperclipCompanyId: "comp-1",
      linearProjectId: "lin-proj-2",
      linearProjectName: "Target Project",
      linearState: "started",
      syncDirection: "bidirectional",
    });
    const updateIssue = vi.spyOn(linearApi, "updateIssue").mockResolvedValue(makeLinearIssue());

    await syncToLinear(
      harness.ctx,
      makeLink({ lastSyncAt: "2020-01-01T00:00:00.000Z" }),
      { projectId: "pc-proj-2" },
      "lin-token",
      "team-1",
    );

    expect(updateIssue).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      "lin-1",
      { projectId: "lin-proj-2" },
    );
  });

  it("does not update Linear when the issue is already in the target project", async () => {
    const harness = createTestHarness({ manifest });
    await createProjectLink(harness.ctx, {
      paperclipProjectId: "pc-proj-2",
      paperclipCompanyId: "comp-1",
      linearProjectId: "lin-proj-2",
      linearProjectName: "Target Project",
      linearState: "started",
      syncDirection: "bidirectional",
    });
    const updateIssue = vi.spyOn(linearApi, "updateIssue").mockResolvedValue(makeLinearIssue());

    await syncToLinear(
      harness.ctx,
      makeLink({ lastSyncAt: "2020-01-01T00:00:00.000Z" }),
      { projectId: "pc-proj-2" },
      "lin-token",
      "team-1",
      {
        baseUrl: null,
        currentLinearIssue: makeLinearIssue({
          project: { id: "lin-proj-2", name: "Target Project", description: null, state: "started" },
        }),
      },
    );

    expect(updateIssue).not.toHaveBeenCalled();
  });


  it("clears the Linear project when Paperclip projectId is removed", async () => {
    const harness = createTestHarness({ manifest });
    const updateIssue = vi.spyOn(linearApi, "updateIssue").mockResolvedValue(makeLinearIssue());

    await syncToLinear(
      harness.ctx,
      makeLink({ lastSyncAt: "2020-01-01T00:00:00.000Z" }),
      { projectId: null },
      "lin-token",
      "team-1",
    );

    expect(updateIssue).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      "lin-1",
      { projectId: null },
    );
  });

  it("skips only the project move when the target Paperclip project is not linked", async () => {
    const harness = createTestHarness({ manifest });
    const updateIssue = vi.spyOn(linearApi, "updateIssue").mockResolvedValue(makeLinearIssue());
    const warn = vi.spyOn(harness.ctx.logger, "warn");

    await syncToLinear(
      harness.ctx,
      makeLink({ lastSyncAt: "2020-01-01T00:00:00.000Z" }),
      { title: "Keep syncing other changes", projectId: "missing-project" },
      "lin-token",
      "team-1",
    );

    expect(updateIssue).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      "lin-1",
      { title: "Keep syncing other changes" },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("is not linked to Linear"),
    );
  });

  it("maps Paperclip label ids to Linear label ids and creates missing Linear labels", async () => {
    const harness = createTestHarness({ manifest });
    vi.spyOn(harness.ctx.labels, "list").mockResolvedValue([
      {
        id: "pc-label-existing",
        companyId: "comp-1",
        name: "scope:legacy",
        color: "#14b8a6",
      },
      {
        id: "pc-label-new",
        companyId: "comp-1",
        name: "source:moved",
        color: "#f59e0b",
      },
    ]);
    vi.spyOn(linearApi, "listIssueLabels").mockResolvedValue([
      {
        id: "lin-label-existing",
        name: "scope:legacy",
        color: "#14b8a6",
        team: { id: "team-1", name: "Blockcast", key: "BLO" },
      },
    ]);
    const createIssueLabel = vi.spyOn(linearApi, "createIssueLabel").mockResolvedValue({
      id: "lin-label-new",
      name: "source:moved",
      color: "#f59e0b",
      team: { id: "team-1", name: "Blockcast", key: "BLO" },
    });
    const updateIssue = vi.spyOn(linearApi, "updateIssue").mockResolvedValue(makeLinearIssue());

    await syncToLinear(
      harness.ctx,
      makeLink({ lastSyncAt: "2020-01-01T00:00:00.000Z" }),
      { labelIds: ["pc-label-existing", "pc-label-new"] },
      "lin-token",
      "team-1",
    );

    expect(createIssueLabel).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      { name: "source:moved", color: "#f59e0b", teamId: "team-1" },
    );
    expect(updateIssue).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      "lin-1",
      { labelIds: ["lin-label-existing", "lin-label-new"] },
    );
  });

  it("reuses an existing Linear label when create reports a duplicate name", async () => {
    const harness = createTestHarness({ manifest });
    vi.spyOn(harness.ctx.labels, "list").mockResolvedValue([
      {
        id: "pc-label-infra",
        companyId: "comp-1",
        name: "infra",
        color: "#0ea5e9",
      },
    ]);
    const listIssueLabels = vi.spyOn(linearApi, "listIssueLabels")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "lin-label-infra",
          name: "infra",
          color: "#0ea5e9",
          team: null,
        },
      ]);
    vi.spyOn(linearApi, "createIssueLabel").mockRejectedValue(
      new Error("Linear GraphQL error: duplicate label name"),
    );
    const updateIssue = vi.spyOn(linearApi, "updateIssue").mockResolvedValue(makeLinearIssue());

    await syncToLinear(
      harness.ctx,
      makeLink({ lastSyncAt: "2020-01-01T00:00:00.000Z" }),
      { labelIds: ["pc-label-infra"] },
      "lin-token",
      "team-1",
    );

    expect(listIssueLabels).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      "lin-token",
      { teamId: "team-1", query: "infra", limit: 500 },
    );
    expect(updateIssue).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      "lin-1",
      { labelIds: ["lin-label-infra"] },
    );
  });

  it("clears Linear issue labels when Paperclip labelIds is empty", async () => {
    const harness = createTestHarness({ manifest });
    const listIssueLabels = vi.spyOn(linearApi, "listIssueLabels");
    const updateIssue = vi.spyOn(linearApi, "updateIssue").mockResolvedValue(makeLinearIssue());

    await syncToLinear(
      harness.ctx,
      makeLink({ lastSyncAt: "2020-01-01T00:00:00.000Z" }),
      { labelIds: [] },
      "lin-token",
      "team-1",
    );

    expect(listIssueLabels).not.toHaveBeenCalled();
    expect(updateIssue).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      "lin-1",
      { labelIds: [] },
    );
  });

  it("does not clear Linear issue labels when the current issue is already unlabeled", async () => {
    const harness = createTestHarness({ manifest });
    const listIssueLabels = vi.spyOn(linearApi, "listIssueLabels");
    const updateIssue = vi.spyOn(linearApi, "updateIssue").mockResolvedValue(makeLinearIssue());

    await syncToLinear(
      harness.ctx,
      makeLink({ lastSyncAt: "2020-01-01T00:00:00.000Z" }),
      { labelIds: [] },
      "lin-token",
      "team-1",
      {
        baseUrl: null,
        currentLinearIssue: makeLinearIssue({ labels: { nodes: [] } }),
      },
    );

    expect(listIssueLabels).not.toHaveBeenCalled();
    expect(updateIssue).not.toHaveBeenCalled();
  });
});

function makeMilestoneLink(overrides: Partial<MilestoneLink> = {}): MilestoneLink {
  return {
    paperclipMilestoneId: "pc-ms-1",
    paperclipCompanyId: "comp-1",
    paperclipProjectId: "pc-proj-1",
    linearMilestoneId: "lin-ms-1",
    linearMilestoneName: "M1",
    lastSyncAt: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("milestone sync — syncToLinear", () => {
  it("sets projectMilestoneId on the Linear issue when a MilestoneLink exists", async () => {
    const harness = createTestHarness({ manifest });
    await createMilestoneLink(harness.ctx, makeMilestoneLink());
    const updateIssue = vi.spyOn(linearApi, "updateIssue").mockResolvedValue(makeLinearIssue());

    await syncToLinear(
      harness.ctx,
      makeLink({ lastSyncAt: "2020-01-01T00:00:00.000Z" }),
      { milestoneId: "pc-ms-1" },
      "lin-token",
      "team-1",
    );

    expect(updateIssue).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      "lin-1",
      { projectMilestoneId: "lin-ms-1" },
    );
  });

  it("clears projectMilestoneId when milestoneId is null", async () => {
    const harness = createTestHarness({ manifest });
    const updateIssue = vi.spyOn(linearApi, "updateIssue").mockResolvedValue(makeLinearIssue());

    await syncToLinear(
      harness.ctx,
      makeLink({ lastSyncAt: "2020-01-01T00:00:00.000Z" }),
      { milestoneId: null },
      "lin-token",
      "team-1",
    );

    expect(updateIssue).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      "lin-1",
      { projectMilestoneId: null },
    );
  });

  it("skips the milestone update (but not other changes) when no MilestoneLink exists", async () => {
    const harness = createTestHarness({ manifest });
    const updateIssue = vi.spyOn(linearApi, "updateIssue").mockResolvedValue(makeLinearIssue());
    const warn = vi.spyOn(harness.ctx.logger, "warn");

    await syncToLinear(
      harness.ctx,
      makeLink({ lastSyncAt: "2020-01-01T00:00:00.000Z" }),
      { title: "Keep this change", milestoneId: "unmapped-ms" },
      "lin-token",
      "team-1",
    );

    expect(updateIssue).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      "lin-1",
      { title: "Keep this change" },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("unmapped-ms"),
    );
  });
});

describe("milestone sync — syncFromLinear", () => {
  it("patches milestoneId when the Linear projectMilestone is mapped", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "T",
          status: "todo",
          priority: "low",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
    });
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.milestoneLinkPrefix}pc-ms-1` },
      makeMilestoneLink(),
    );
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `${STATE_KEYS.milestoneLinearPrefix}lin-ms-1` },
      "pc-ms-1",
    );

    const update = vi.spyOn(harness.ctx.issues, "update");

    await syncFromLinear(
      harness.ctx,
      makeLink(),
      makeLinearIssue({ projectMilestone: { id: "lin-ms-1", name: "M1" } }),
    );

    expect(update).toHaveBeenCalledWith(
      "pc-1",
      expect.objectContaining({ milestoneId: "pc-ms-1" }),
      "comp-1",
    );
  });

  it("clears milestoneId when the Linear issue has no projectMilestone", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "T",
          status: "todo",
          priority: "low",
          milestoneId: "pc-ms-1",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
    });

    const update = vi.spyOn(harness.ctx.issues, "update");

    await syncFromLinear(
      harness.ctx,
      makeLink(),
      makeLinearIssue({ projectMilestone: null }),
    );

    expect(update).toHaveBeenCalledWith(
      "pc-1",
      expect.objectContaining({ milestoneId: null }),
      "comp-1",
    );
  });
});
