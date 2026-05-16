import { describe, expect, it } from "vitest";
import { orderReusableExecutionWorkspaces, type ReusableExecutionWorkspaceLike } from "./reusable-execution-workspaces";

function workspace(overrides: Partial<ReusableExecutionWorkspaceLike>): ReusableExecutionWorkspaceLike {
  return {
    id: overrides.id ?? "workspace-id",
    name: overrides.name ?? "Workspace",
    cwd: overrides.cwd ?? null,
    lastUsedAt: overrides.lastUsedAt ?? "2026-01-01T00:00:00.000Z",
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
