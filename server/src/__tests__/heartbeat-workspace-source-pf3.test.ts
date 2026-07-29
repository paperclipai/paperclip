import { describe, expect, it } from "vitest";
import {
  buildProjectWorkspaceUnavailableFallback,
  prioritizeProjectWorkspaceCandidatesForRun,
  type ResolvedWorkspaceForRun,
} from "../services/heartbeat.ts";

// PF-3 contract: when project workspaces exist for an issue's project but
// none of their configured cwds are usable, the resolver must report the
// fallback truthfully — source "agent_home", with project-scoped metadata
// (workspaceId / repoUrl / repoRef) nulled because those candidates were
// NOT used. Pre-fix this branch returned source: "project_primary" with
// stale workspaceId/repoUrl/repoRef, which made fallback invisible to
// session-resume logic, audit logs, and adapter behavior.

describe("PF-3 buildProjectWorkspaceUnavailableFallback", () => {
  const baseHints: ResolvedWorkspaceForRun["workspaceHints"] = [
    {
      workspaceId: "workspace-1",
      cwd: "/missing/dir",
      repoUrl: "git@example.com:org/repo.git",
      repoRef: "main",
    },
  ];

  it("reports source as 'agent_home', not 'project_primary'", () => {
    const result = buildProjectWorkspaceUnavailableFallback({
      fallbackCwd: "/agent/home/abc",
      resolvedProjectId: "project-1",
      workspaceHints: baseHints,
      warnings: ["Project workspace path \"/missing/dir\" is not available yet."],
    });
    expect(result.source).toBe("agent_home");
    expect(result.source).not.toBe("project_primary");
  });

  it("nulls out workspaceId / repoUrl / repoRef so downstream consumers do not see stale project-scoped metadata", () => {
    const result = buildProjectWorkspaceUnavailableFallback({
      fallbackCwd: "/agent/home/abc",
      resolvedProjectId: "project-1",
      workspaceHints: baseHints,
      warnings: [],
    });
    expect(result.workspaceId).toBeNull();
    expect(result.repoUrl).toBeNull();
    expect(result.repoRef).toBeNull();
  });

  it("preserves resolvedProjectId so consumers can still tell which project was attempted", () => {
    const result = buildProjectWorkspaceUnavailableFallback({
      fallbackCwd: "/agent/home/abc",
      resolvedProjectId: "project-1",
      workspaceHints: baseHints,
      warnings: [],
    });
    expect(result.projectId).toBe("project-1");
  });

  it("uses the supplied fallbackCwd as the run cwd", () => {
    const result = buildProjectWorkspaceUnavailableFallback({
      fallbackCwd: "/agent/home/specific/abc",
      resolvedProjectId: null,
      workspaceHints: [],
      warnings: [],
    });
    expect(result.cwd).toBe("/agent/home/specific/abc");
  });

  it("surfaces the candidate workspaces via workspaceHints for diagnostics", () => {
    const hints: ResolvedWorkspaceForRun["workspaceHints"] = [
      {
        workspaceId: "ws-a",
        cwd: "/missing/a",
        repoUrl: "git@x.y:a.git",
        repoRef: "main",
      },
      {
        workspaceId: "ws-b",
        cwd: "/missing/b",
        repoUrl: null,
        repoRef: null,
      },
    ];
    const result = buildProjectWorkspaceUnavailableFallback({
      fallbackCwd: "/agent/home/abc",
      resolvedProjectId: "project-1",
      workspaceHints: hints,
      warnings: [],
    });
    expect(result.workspaceHints).toEqual(hints);
  });

  it("surfaces the fallback-reason warnings unchanged", () => {
    const warnings = [
      "Selected project workspace \"abc\" is not available on this project.",
      "Project workspace path \"/missing/dir\" is not available yet. Using fallback workspace \"/agent/home/abc\" for this run.",
    ];
    const result = buildProjectWorkspaceUnavailableFallback({
      fallbackCwd: "/agent/home/abc",
      resolvedProjectId: "project-1",
      workspaceHints: [],
      warnings,
    });
    expect(result.warnings).toEqual(warnings);
  });
});

// Sanity: keep the existing prioritizeProjectWorkspaceCandidatesForRun
// behavior visible alongside the new helper so the contract pair stays in
// view for future changes to the resolution path.
describe("PF-3 sanity: prioritizeProjectWorkspaceCandidatesForRun", () => {
  it("returns rows unchanged when no preferred id is supplied", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(prioritizeProjectWorkspaceCandidatesForRun(rows, null)).toBe(rows);
    expect(prioritizeProjectWorkspaceCandidatesForRun(rows, undefined)).toBe(rows);
  });

  it("hoists the preferred id to the front when present", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const result = prioritizeProjectWorkspaceCandidatesForRun(rows, "b");
    expect(result.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("returns rows unchanged when the preferred id is not in the list", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(prioritizeProjectWorkspaceCandidatesForRun(rows, "missing")).toBe(rows);
  });
});
