import { describe, expect, it } from "vitest";
import type { Goal, Project } from "@paperclipai/shared";

import {
  buildProjectRoadmapRow,
  groupRoadmap,
  summarizeRoadmap,
} from "./projects-roadmap";

function makeProject(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    id: overrides.id,
    companyId: "company-1",
    urlKey: overrides.urlKey ?? overrides.id,
    goalId: overrides.goalId ?? null,
    goalIds: overrides.goalIds ?? [],
    goals: overrides.goals ?? [],
    name: overrides.name,
    description: overrides.description ?? null,
    status: overrides.status ?? "in_progress",
    leadAgentId: overrides.leadAgentId ?? null,
    targetDate: overrides.targetDate ?? null,
    color: overrides.color ?? null,
    env: overrides.env ?? null,
    pauseReason: overrides.pauseReason ?? null,
    pausedAt: overrides.pausedAt ?? null,
    executionWorkspacePolicy: overrides.executionWorkspacePolicy ?? null,
    codebase: overrides.codebase ?? ({} as Project["codebase"]),
    workspaces: overrides.workspaces ?? [],
    primaryWorkspace: overrides.primaryWorkspace ?? null,
    archivedAt: overrides.archivedAt ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  } as Project;
}

function makeGoal(overrides: Partial<Goal> & { id: string; title: string }): Goal {
  return {
    id: overrides.id,
    companyId: "company-1",
    title: overrides.title,
    description: overrides.description ?? null,
    level: overrides.level ?? "company",
    status: overrides.status ?? "active",
    parentId: overrides.parentId ?? null,
    ownerAgentId: overrides.ownerAgentId ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

describe("buildProjectRoadmapRow", () => {
  it("resolves goal titles from goalIds via the goals map", () => {
    const goals = new Map<string, Goal>([
      ["g-1", makeGoal({ id: "g-1", title: "Ship EAOS shell" })],
      ["g-2", makeGoal({ id: "g-2", title: "Wire mission detail" })],
    ]);
    const row = buildProjectRoadmapRow(
      makeProject({
        id: "p-1",
        name: "EAOS launch",
        goalIds: ["g-1", "g-2", "missing-id"],
      }),
      goals,
    );
    expect(row.goalCount).toBe(3);
    expect(row.goalTitles).toEqual(["Ship EAOS shell", "Wire mission detail"]);
  });

  it("falls back to the deprecated goalId when goalIds is empty", () => {
    const goals = new Map<string, Goal>([
      ["legacy-g", makeGoal({ id: "legacy-g", title: "Legacy goal" })],
    ]);
    const row = buildProjectRoadmapRow(
      makeProject({ id: "p-2", name: "Legacy proj", goalId: "legacy-g", goalIds: [] }),
      goals,
    );
    expect(row.goalCount).toBe(1);
    expect(row.goalTitles).toEqual(["Legacy goal"]);
  });

  it("renders archived projects with a parsed archivedAt Date", () => {
    const row = buildProjectRoadmapRow(
      makeProject({
        id: "p-3",
        name: "Archived proj",
        status: "completed",
        archivedAt: new Date("2026-04-01T00:00:00Z"),
      }),
      new Map(),
    );
    expect(row.archivedAt?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("summarizeRoadmap", () => {
  it("counts each project status, archived, paused, and active goals", () => {
    const counts = summarizeRoadmap(
      [
        makeProject({ id: "1", name: "A", status: "in_progress" }),
        makeProject({ id: "2", name: "B", status: "in_progress", pausedAt: new Date() }),
        makeProject({ id: "3", name: "C", status: "planned" }),
        makeProject({ id: "4", name: "D", status: "backlog" }),
        makeProject({ id: "5", name: "E", status: "completed" }),
        makeProject({ id: "6", name: "F", status: "cancelled" }),
        makeProject({
          id: "7",
          name: "G",
          status: "completed",
          archivedAt: new Date("2026-04-01T00:00:00Z"),
        }),
      ],
      [
        makeGoal({ id: "g-active", title: "Active", status: "active" }),
        makeGoal({ id: "g-planned", title: "Planned", status: "planned" }),
        makeGoal({ id: "g-active-2", title: "Another active", status: "active" }),
      ],
    );
    expect(counts).toEqual({
      total: 7,
      inProgress: 2,
      planned: 1,
      backlog: 1,
      completed: 2,
      cancelled: 1,
      archived: 1,
      paused: 1,
      activeGoals: 2,
    });
  });
});

describe("groupRoadmap", () => {
  it("buckets into in_progress / planned / backlog / shipped / stopped, alphabetically", () => {
    const buckets = groupRoadmap(
      [
        makeProject({ id: "ip-1", name: "Zeta", status: "in_progress" }),
        makeProject({ id: "ip-2", name: "Alpha", status: "in_progress" }),
        makeProject({ id: "p-1", name: "Beta", status: "planned" }),
        makeProject({ id: "b-1", name: "Gamma", status: "backlog" }),
        makeProject({ id: "s-1", name: "Delta", status: "completed" }),
        makeProject({ id: "x-1", name: "Epsilon", status: "cancelled" }),
        makeProject({
          id: "a-1",
          name: "Archive me",
          status: "completed",
          archivedAt: new Date("2026-04-01"),
        }),
      ],
      [],
    );
    expect(buckets.map((b) => b.id)).toEqual([
      "in_progress",
      "planned",
      "backlog",
      "shipped",
      "stopped",
    ]);
    const inProgress = buckets.find((b) => b.id === "in_progress")!;
    expect(inProgress.rows.map((row) => row.name)).toEqual(["Alpha", "Zeta"]);
    const shipped = buckets.find((b) => b.id === "shipped")!;
    expect(shipped.rows.map((row) => row.name)).toEqual(["Delta"]);
    const stopped = buckets.find((b) => b.id === "stopped")!;
    // Archived-completed AND cancelled both land in stopped.
    expect(stopped.rows.map((row) => row.name)).toEqual(["Archive me", "Epsilon"]);
  });
});
