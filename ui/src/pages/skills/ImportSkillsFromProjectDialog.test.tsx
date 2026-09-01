// @vitest-environment jsdom

import type {
  CompanySkillProjectScanCandidate,
  Project,
  ProjectWorktree,
} from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  defaultSelection,
  filterCandidates,
  groupCandidates,
  isScannableWorktree,
  isSelectableCandidate,
  isValidSelectionSlug,
  scannableWorktrees,
  selectAllSelection,
  selectionKey,
  suggestedConflictSlug,
} from "./ImportSkillsFromProjectDialog";

const WS_A = "11111111-1111-1111-1111-111111111111";
const WS_B = "22222222-2222-2222-2222-222222222222";

function candidate(
  overrides: Partial<CompanySkillProjectScanCandidate> &
    Pick<CompanySkillProjectScanCandidate, "slug" | "relativePath" | "status">,
): CompanySkillProjectScanCandidate {
  return {
    name: overrides.slug,
    description: null,
    workspaceId: WS_A,
    workspaceName: "Worktree A",
    projectId: "33333333-3333-3333-3333-333333333333",
    projectName: "Project",
    directoryRoot: ".claude/skills",
    ...overrides,
  } as CompanySkillProjectScanCandidate;
}

/**
 * A mixed candidate set: two new skills, one selectable conflict, and two
 * disabled statuses.
 */
function mixedCandidates(): CompanySkillProjectScanCandidate[] {
  return [
    candidate({ slug: "alpha", relativePath: ".claude/skills/alpha", status: "new" }),
    candidate({ slug: "beta", relativePath: ".claude/skills/beta", status: "new" }),
    candidate({
      slug: "gamma",
      relativePath: ".claude/skills/gamma",
      status: "already_imported",
      existingSkillId: "44444444-4444-4444-4444-444444444444",
    }),
    candidate({
      slug: "delta",
      relativePath: ".claude/skills/delta",
      status: "conflict",
      reason: "Slug delta is already in use.",
    }),
    candidate({
      slug: "epsilon",
      relativePath: ".claude/skills/epsilon",
      status: "skipped",
      reason: "Could not parse SKILL.md.",
    }),
  ];
}

describe("ImportSkillsFromProjectDialog selection logic", () => {
  it("new and conflict candidates are selectable", () => {
    const candidates = mixedCandidates();
    const selectable = candidates.filter(isSelectableCandidate);
    expect(selectable.map((c) => c.slug)).toEqual(["alpha", "beta", "delta"]);
  });

  it("default selection leaves every candidate unchecked", () => {
    expect(defaultSelection(mixedCandidates())).toEqual(new Map());
  });

  it("select all checks new candidates and leaves conflicts unchecked", () => {
    const candidates = mixedCandidates();
    const selectAll = selectAllSelection(candidates);
    const defaultChecked = candidates.filter((candidate) => candidate.status === "new");
    expect(selectAll.size).toBe(defaultChecked.length);
    for (const c of defaultChecked) {
      expect(selectAll.has(selectionKey(c.workspaceId, c.relativePath))).toBe(true);
    }
    expect(selectAll.has(selectionKey(WS_A, ".claude/skills/delta"))).toBe(false);
  });

  it("deselect all yields an empty selection (N = 0)", () => {
    const deselectAll = new Map<string, { workspaceId: string; path: string }>();
    expect(deselectAll.size).toBe(0);
  });

  it("selection payload carries workspaceId + path for each checked new candidate", () => {
    const selection = selectAllSelection(mixedCandidates());
    const payload = Array.from(selection.values());
    expect(payload).toEqual([
      { workspaceId: WS_A, path: ".claude/skills/alpha" },
      { workspaceId: WS_A, path: ".claude/skills/beta" },
    ]);
  });

  it("toggling a single new candidate removes only that row from N", () => {
    const selection = selectAllSelection(mixedCandidates());
    const key = selectionKey(WS_A, ".claude/skills/alpha");
    selection.delete(key);
    expect(selection.size).toBe(1);
    expect(selection.has(key)).toBe(false);
    expect(selection.has(selectionKey(WS_A, ".claude/skills/beta"))).toBe(true);
  });

  it("groups folders beneath each worktree and sorts the primary worktree first", () => {
    const candidates = [
      candidate({ slug: "a", relativePath: ".claude/skills/a", status: "new" }),
      candidate({
        slug: "b",
        relativePath: "skills/b",
        directoryRoot: "skills",
        status: "new",
      }),
      candidate({
        slug: "c",
        relativePath: ".claude/skills/c",
        workspaceId: WS_B,
        workspaceName: "Worktree B",
        status: "new",
      }),
    ];
    const groups = groupCandidates(candidates, [
      worktree({ id: WS_A, name: "Worktree A", isPrimary: false }),
      worktree({ id: WS_B, name: "Worktree B", isPrimary: true }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.workspaceName)).toEqual(["Worktree B", "Worktree A"]);
    expect(groups[1]?.directories.map((directory) => directory.directoryRoot)).toEqual([
      ".claude/skills",
      "skills",
    ]);
  });

  it("filters candidates by name, slug, path, workspace, and status", () => {
    const candidates = mixedCandidates();
    expect(filterCandidates(candidates, "DELTA").map((entry) => entry.slug)).toEqual(["delta"]);
    expect(filterCandidates(candidates, "already_imported").map((entry) => entry.slug)).toEqual(["gamma"]);
    expect(filterCandidates(candidates, ".claude/skills/epsilon").map((entry) => entry.slug)).toEqual(["epsilon"]);
    expect(filterCandidates(candidates, "worktree a")).toHaveLength(candidates.length);
  });

  it("suggests and validates a URL-safe rename for conflicts", () => {
    const conflict = mixedCandidates().find((entry) => entry.status === "conflict")!;
    expect(suggestedConflictSlug(conflict)).toBe("delta-copy");
    expect(isValidSelectionSlug({ workspaceId: WS_A, path: conflict.relativePath, slug: "delta-copy" })).toBe(true);
    expect(isValidSelectionSlug({ workspaceId: WS_A, path: conflict.relativePath, slug: "Delta Copy" })).toBe(false);
    expect(isValidSelectionSlug({ workspaceId: WS_A, path: conflict.relativePath, slug: "" })).toBe(false);
  });
});

function worktree(overrides: Partial<ProjectWorktree>): ProjectWorktree {
  return {
    id: WS_A,
    companyId: "c",
    projectId: "p",
    name: "ws",
    sourceType: "local_path",
    cwd: "/srv/project",
    repoUrl: null,
    repoRef: null,
    defaultRef: null,
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    runtimeConfig: null,
    isPrimary: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ProjectWorktree;
}

describe("scannable worktree detection", () => {
  it("local/git/folder worktrees with a cwd are scannable", () => {
    expect(isScannableWorktree(worktree({ sourceType: "local_path" }))).toBe(true);
    expect(isScannableWorktree(worktree({ sourceType: "git_repo" }))).toBe(true);
    expect(isScannableWorktree(worktree({ sourceType: "non_git_path" }))).toBe(true);
  });

  it("remote-managed worktrees are never scannable", () => {
    expect(
      isScannableWorktree(worktree({ sourceType: "remote_managed", cwd: null })),
    ).toBe(false);
  });

  it("worktrees without a cwd are not scannable", () => {
    expect(isScannableWorktree(worktree({ cwd: null }))).toBe(false);
    expect(isScannableWorktree(worktree({ cwd: "   " }))).toBe(false);
  });

  it("a remote-only project has zero scannable worktrees", () => {
    const project = {
      workspaces: [
        worktree({ id: WS_A, sourceType: "remote_managed", cwd: null }),
        worktree({ id: WS_B, sourceType: "remote_managed", cwd: null }),
      ],
    } as unknown as Project;
    expect(scannableWorktrees(project)).toHaveLength(0);
  });
});
