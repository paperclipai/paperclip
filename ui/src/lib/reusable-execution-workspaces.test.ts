import { describe, expect, it } from "vitest";
import {
  buildReusableExecutionWorkspaceOptionGroups,
  orderReusableExecutionWorkspaces,
  reusableWorkspaceOptionMatches,
  scoreReusableWorkspaceOptionMatch,
  type ReusableExecutionWorkspaceLike,
} from "./reusable-execution-workspaces";

function workspace(overrides: Partial<ReusableExecutionWorkspaceLike>): ReusableExecutionWorkspaceLike {
  return {
    id: overrides.id ?? "workspace-id",
    name: overrides.name ?? "Workspace",
    cwd: overrides.cwd ?? null,
    lastUsedAt: overrides.lastUsedAt ?? "2026-01-01T00:00:00.000Z",
    status: overrides.status,
    branchName: overrides.branchName,
  };
}

describe("orderReusableExecutionWorkspaces", () => {
  it("puts the most recently used workspace first and sorts the rest alphabetically", () => {
    const workspaces = [
      workspace({ id: "charlie", name: "Charlie", lastUsedAt: "2026-01-03T00:00:00.000Z" }),
      workspace({ id: "zulu", name: "Zulu", lastUsedAt: "2026-01-05T00:00:00.000Z" }),
      workspace({ id: "alpha", name: "Alpha", lastUsedAt: "2026-01-01T00:00:00.000Z" }),
      workspace({ id: "bravo", name: "Bravo", lastUsedAt: "2026-01-04T00:00:00.000Z" }),
    ];

    expect(orderReusableExecutionWorkspaces(workspaces).map((item) => item.id)).toEqual([
      "zulu",
      "alpha",
      "bravo",
      "charlie",
    ]);
  });

  it("keeps only the latest used workspace for duplicate paths before sorting", () => {
    const workspaces = [
      workspace({
        id: "older-duplicate",
        name: "Older duplicate",
        cwd: "/tmp/shared",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
      }),
      workspace({ id: "beta", name: "Beta", cwd: "/tmp/beta", lastUsedAt: "2026-01-02T00:00:00.000Z" }),
      workspace({
        id: "newer-duplicate",
        name: "Newer duplicate",
        cwd: "/tmp/shared",
        lastUsedAt: "2026-01-04T00:00:00.000Z",
      }),
      workspace({ id: "alpha", name: "Alpha", cwd: "/tmp/alpha", lastUsedAt: "2026-01-03T00:00:00.000Z" }),
    ];

    expect(orderReusableExecutionWorkspaces(workspaces).map((item) => item.id)).toEqual([
      "newer-duplicate",
      "alpha",
      "beta",
    ]);
  });

  it("does not let updatedAt churn outrank the last used workspace", () => {
    type WorkspaceWithUpdatedAt = ReusableExecutionWorkspaceLike & { updatedAt: Date | string };
    const workspaces: WorkspaceWithUpdatedAt[] = [
      {
        ...workspace({
          id: "recently-used",
          name: "Recently used",
          cwd: "/tmp/shared",
          lastUsedAt: "2026-01-04T00:00:00.000Z",
        }),
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        ...workspace({
          id: "recently-updated",
          name: "Recently updated",
          cwd: "/tmp/shared",
          lastUsedAt: "2026-01-01T00:00:00.000Z",
        }),
        updatedAt: "2026-01-05T00:00:00.000Z",
      },
    ];

    expect(orderReusableExecutionWorkspaces(workspaces).map((item) => item.id)).toEqual([
      "recently-used",
    ]);
  });
});

describe("buildReusableExecutionWorkspaceOptionGroups", () => {
  const now = "2026-01-10T12:00:00.000Z";

  it("deduplicates by cwd and keeps the latest used workspace", () => {
    const groups = buildReusableExecutionWorkspaceOptionGroups([
      workspace({
        id: "older",
        name: "Older",
        cwd: "/repo/shared",
        lastUsedAt: "2026-01-09T00:00:00.000Z",
      }),
      workspace({
        id: "newer",
        name: "Newer",
        cwd: "/repo/shared",
        lastUsedAt: "2026-01-10T00:00:00.000Z",
      }),
      workspace({
        id: "other",
        name: "Other",
        cwd: "/repo/other",
        lastUsedAt: "2026-01-08T00:00:00.000Z",
      }),
    ], { now });

    expect(groups.flatMap((group) => group.options.map((option) => option.workspaceId))).toEqual([
      "newer",
      "other",
      "newer",
      "other",
    ]);
  });

  it("orders recent by last used and all workspaces by name", () => {
    const groups = buildReusableExecutionWorkspaceOptionGroups([
      workspace({ id: "charlie", name: "Charlie", lastUsedAt: "2026-01-09T00:00:00.000Z" }),
      workspace({ id: "alpha", name: "Alpha", lastUsedAt: "2026-01-07T13:00:00.000Z" }),
      workspace({ id: "bravo", name: "Bravo", lastUsedAt: "2026-01-10T00:00:00.000Z" }),
    ], { now });

    expect(groups.find((group) => group.id === "recent")?.options.map((option) => option.workspaceId)).toEqual([
      "bravo",
      "charlie",
      "alpha",
    ]);
    expect(groups.find((group) => group.id === "all")?.options.map((option) => option.workspaceId)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
  });

  it("includes workspaces used exactly at the 3-day cutoff and excludes older workspaces", () => {
    const groups = buildReusableExecutionWorkspaceOptionGroups([
      workspace({
        id: "boundary",
        name: "Boundary",
        lastUsedAt: "2026-01-07T12:00:00.000Z",
      }),
      workspace({
        id: "older",
        name: "Older",
        lastUsedAt: "2026-01-07T11:59:59.999Z",
      }),
    ], { now });

    expect(groups.find((group) => group.id === "recent")?.options.map((option) => option.workspaceId)).toEqual([
      "boundary",
    ]);
    expect(groups.find((group) => group.id === "all")?.options.map((option) => option.workspaceId)).toEqual([
      "boundary",
      "older",
    ]);
  });

  it("keys duplicate recent and all appearances by group while keeping the selected value as workspace id", () => {
    const groups = buildReusableExecutionWorkspaceOptionGroups([
      workspace({
        id: "workspace-1",
        name: "Workspace 1",
        lastUsedAt: "2026-01-10T00:00:00.000Z",
      }),
    ], { now });

    expect(groups.flatMap((group) => group.options.map((option) => [option.key, option.value]))).toEqual([
      ["recent:workspace-1", "workspace-1"],
      ["all:workspace-1", "workspace-1"],
    ]);
  });

  it("builds stable display and search metadata", () => {
    const groups = buildReusableExecutionWorkspaceOptionGroups([
      workspace({
        id: "workspace-1",
        name: "Paperclip app",
        cwd: "/repo/paperclip",
        branchName: "feature/workspaces",
        status: "active",
        lastUsedAt: "2026-01-10T00:00:00.000Z",
      }),
    ], { now });

    const option = groups[0]!.options[0]!;
    expect(option.label).toBe("Paperclip app");
    expect(option.description).toBe("feature/workspaces");
    expect(option.searchText).toBe("Paperclip app active feature/workspaces /repo/paperclip workspace-1");
  });

  it("matches workspace options with fuzzy query tokens", () => {
    const groups = buildReusableExecutionWorkspaceOptionGroups([
      workspace({
        id: "workspace-1",
        name: "Paperclip app",
        cwd: "/srv/paperclip",
        branchName: "feature/reusable-workspaces",
        status: "active",
        lastUsedAt: "2026-01-10T00:00:00.000Z",
      }),
    ], { now });

    const option = groups[0]!.options[0]!;
    expect(reusableWorkspaceOptionMatches(option, "pclip reusable")).toBe(true);
    expect(reusableWorkspaceOptionMatches(option, "inactive")).toBe(false);
  });

  it("does not match query letters spread across unrelated workspace text", () => {
    const groups = buildReusableExecutionWorkspaceOptionGroups([
      workspace({
        id: "routine-bodies",
        name: "PAP-11694-editing-routine-bodies-should-have-revision-tracking",
        cwd: "/srv/paperclip/home/paperclipai/paperclip/.paperclip/worktrees/PAP-11694-editing-routine-bodies",
        branchName: "PAP-11694-editing-routine-bodies-should-have-revision-tracking",
        status: "active",
        lastUsedAt: "2026-01-10T00:00:00.000Z",
      }),
      workspace({
        id: "mobile-agent-chat",
        name: "PAP-11446-on-mobile-the-agent-chat-shouldn-t-hone-indented",
        cwd: "/srv/paperclip/home/paperclipai/paperclip/.paperclip/worktrees/PAP-11446-on-mobile-agent-chat",
        branchName: "PAP-11446-on-mobile-the-agent-chat-shouldnt-hone-indented",
        status: "active",
        lastUsedAt: "2026-01-09T00:00:00.000Z",
      }),
      workspace({
        id: "simultaneous-work",
        name: "PAP-11429-why-are-these-live-simultaneously",
        cwd: "/srv/paperclip/home/paperclipai/paperclip/.paperclip/worktrees/PAP-11429-live-simultaneously",
        branchName: "PAP-11429-why-are-these-live-simultaneously",
        status: "active",
        lastUsedAt: "2026-01-08T00:00:00.000Z",
      }),
    ], { now });

    const options = groups.flatMap((group) => group.options);
    const unrelated = options.find((option) => option.workspaceId === "routine-bodies")!;
    const mobile = options.find((option) => option.workspaceId === "mobile-agent-chat")!;
    const simultaneous = options.find((option) => option.workspaceId === "simultaneous-work")!;

    expect(reusableWorkspaceOptionMatches(unrelated, "mobile")).toBe(false);
    expect(reusableWorkspaceOptionMatches(unrelated, "simultan")).toBe(false);
    expect(reusableWorkspaceOptionMatches(mobile, "mobile")).toBe(true);
    expect(reusableWorkspaceOptionMatches(simultaneous, "simultan")).toBe(true);
  });

  it("scores visible label matches ahead of hidden path matches", () => {
    const groups = buildReusableExecutionWorkspaceOptionGroups([
      workspace({
        id: "path-only-mobile",
        name: "Paperclip app",
        cwd: "/srv/paperclip/mobile-checkout",
        branchName: "feature/workspace-reuse",
        lastUsedAt: "2026-01-10T00:00:00.000Z",
      }),
      workspace({
        id: "label-mobile",
        name: "Mobile agent chat",
        cwd: "/srv/paperclip/agent-chat",
        branchName: "feature/agent-chat",
        lastUsedAt: "2026-01-09T00:00:00.000Z",
      }),
    ], { now });

    const options = groups.flatMap((group) => group.options);
    const pathOnly = options.find((option) => option.workspaceId === "path-only-mobile")!;
    const label = options.find((option) => option.workspaceId === "label-mobile")!;

    expect(scoreReusableWorkspaceOptionMatch(label, "mobile")).toBeLessThan(
      scoreReusableWorkspaceOptionMatch(pathOnly, "mobile")!,
    );
  });
});
