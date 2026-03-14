import { describe, expect, it } from "vitest";
import type { Project } from "@paperclipai/shared";
import { filterProjectRows, parseNullableCliValue, resolveGoalIds } from "../commands/client/project.js";

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    companyId: "company-1",
    urlKey: "core-foundation",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Core Foundation",
    description: "Primary workspace for Rainwater",
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#8b5cf6",
    executionWorkspacePolicy: null,
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("resolveGoalIds", () => {
  it("prefers comma-separated goalIds when provided", () => {
    expect(resolveGoalIds({ goalId: "old-goal", goalIds: "goal-a, goal-b" })).toEqual(["goal-a", "goal-b"]);
  });

  it("maps legacy single goalId to a one-item array", () => {
    expect(resolveGoalIds({ goalId: "goal-a" })).toEqual(["goal-a"]);
  });

  it("returns empty array when legacy goalId is intentionally blank", () => {
    expect(resolveGoalIds({ goalId: "   " })).toEqual([]);
  });

  it("returns undefined when no goal flags are provided", () => {
    expect(resolveGoalIds({})).toBeUndefined();
  });
});

describe("parseNullableCliValue", () => {
  it("returns undefined when omitted", () => {
    expect(parseNullableCliValue(undefined)).toBeUndefined();
  });

  it("maps literal null to null", () => {
    expect(parseNullableCliValue("null")).toBeNull();
    expect(parseNullableCliValue(" NULL ")).toBeNull();
  });

  it("preserves non-null strings", () => {
    expect(parseNullableCliValue("main")).toBe("main");
  });
});

describe("filterProjectRows", () => {
  const rows: Project[] = [
    makeProject({
      id: "11111111-1111-1111-1111-111111111111",
      urlKey: "core-foundation",
      name: "Core Foundation",
      status: "in_progress",
      goalIds: ["goal-a"],
      leadAgentId: "agent-1",
      primaryWorkspace: {
        id: "workspace-1",
        companyId: "company-1",
        projectId: "11111111-1111-1111-1111-111111111111",
        name: "rainwater",
        cwd: "/Users/example/rainwater",
        repoUrl: null,
        repoRef: null,
        metadata: null,
        isPrimary: true,
        runtimeServices: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    }),
    makeProject({
      id: "22222222-2222-2222-2222-222222222222",
      urlKey: "ops-cadence",
      name: "Ops Cadence",
      description: "Execution rhythm and review loops for Tomorrow Capital",
      status: "planned",
      goalIds: ["goal-b"],
      leadAgentId: "agent-2",
    }),
  ];

  it("filters by status", () => {
    const result = filterProjectRows(rows, { status: "planned" });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Ops Cadence");
  });

  it("filters by lead agent id", () => {
    const result = filterProjectRows(rows, { leadAgentId: "agent-1" });
    expect(result).toHaveLength(1);
    expect(result[0]?.urlKey).toBe("core-foundation");
  });

  it("filters by goal id", () => {
    const result = filterProjectRows(rows, { goalId: "goal-b" });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Ops Cadence");
  });

  it("matches against workspace paths and metadata text", () => {
    const result = filterProjectRows(rows, { match: "rainwater" });
    expect(result).toHaveLength(1);
    expect(result[0]?.urlKey).toBe("core-foundation");
  });
});
