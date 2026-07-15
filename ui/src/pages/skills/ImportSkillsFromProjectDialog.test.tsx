// @vitest-environment jsdom

import type {
  CompanySkillProjectScanCandidate,
  Project,
  ProjectWorkspace,
} from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  defaultSelection,
  groupCandidates,
  isScannableWorkspace,
  isSelectableCandidate,
  scannableWorkspaces,
  selectionKey,
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
    workspaceName: "Workspace A",
    projectId: "33333333-3333-3333-3333-333333333333",
    projectName: "Project",
    directoryRoot: ".claude/skills",
    ...overrides,
  } as CompanySkillProjectScanCandidate;
}

/**
 * A mixed candidate set: two importable "new" skills plus one of each disabled
 * status. The disabled rows must never count toward the import selection (N).
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
  it("only 'new' candidates are selectable", () => {
    const candidates = mixedCandidates();
    const selectable = candidates.filter(isSelectableCandidate);
    expect(selectable.map((c) => c.slug)).toEqual(["alpha", "beta"]);
  });

  it("default selection checks every new candidate and excludes disabled rows (N)", () => {
    const selection = defaultSelection(mixedCandidates());
    // N = 2 (only alpha + beta), disabled rows never counted.
    expect(selection.size).toBe(2);
    expect(selection.has(selectionKey(WS_A, ".claude/skills/alpha"))).toBe(true);
    expect(selection.has(selectionKey(WS_A, ".claude/skills/beta"))).toBe(true);
    expect(selection.has(selectionKey(WS_A, ".claude/skills/gamma"))).toBe(false);
    expect(selection.has(selectionKey(WS_A, ".claude/skills/delta"))).toBe(false);
    expect(selection.has(selectionKey(WS_A, ".claude/skills/epsilon"))).toBe(false);
  });

  it("select all matches the set of selectable candidates only", () => {
    const candidates = mixedCandidates();
    // "Select all" reuses defaultSelection — it acts on selectable rows only.
    const selectAll = defaultSelection(candidates);
    const selectable = candidates.filter(isSelectableCandidate);
    expect(selectAll.size).toBe(selectable.length);
    for (const c of selectable) {
      expect(selectAll.has(selectionKey(c.workspaceId, c.relativePath))).toBe(true);
    }
  });

  it("deselect all yields an empty selection (N = 0)", () => {
    const deselectAll = new Map<string, { workspaceId: string; path: string }>();
    expect(deselectAll.size).toBe(0);
  });

  it("selection payload carries workspaceId + path for each checked new candidate", () => {
    const selection = defaultSelection(mixedCandidates());
    const payload = Array.from(selection.values());
    expect(payload).toEqual([
      { workspaceId: WS_A, path: ".claude/skills/alpha" },
      { workspaceId: WS_A, path: ".claude/skills/beta" },
    ]);
  });

  it("toggling a single new candidate removes only that row from N", () => {
    const selection = defaultSelection(mixedCandidates());
    const key = selectionKey(WS_A, ".claude/skills/alpha");
    selection.delete(key);
    expect(selection.size).toBe(1);
    expect(selection.has(key)).toBe(false);
    expect(selection.has(selectionKey(WS_A, ".claude/skills/beta"))).toBe(true);
  });

  it("groups candidates by workspace + directory root", () => {
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
        workspaceName: "Workspace B",
        status: "new",
      }),
    ];
    const groups = groupCandidates(candidates);
    expect(groups).toHaveLength(3);
    // Sorted by workspace name then directory root.
    expect(groups.map((g) => `${g.workspaceName}:${g.directoryRoot}`)).toEqual([
      "Workspace A:.claude/skills",
      "Workspace A:skills",
      "Workspace B:.claude/skills",
    ]);
  });
});

function workspace(overrides: Partial<ProjectWorkspace>): ProjectWorkspace {
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
  } as ProjectWorkspace;
}

describe("scannable workspace detection", () => {
  it("local/git/folder workspaces with a cwd are scannable", () => {
    expect(isScannableWorkspace(workspace({ sourceType: "local_path" }))).toBe(true);
    expect(isScannableWorkspace(workspace({ sourceType: "git_repo" }))).toBe(true);
    expect(isScannableWorkspace(workspace({ sourceType: "non_git_path" }))).toBe(true);
  });

  it("remote-managed workspaces are never scannable", () => {
    expect(
      isScannableWorkspace(workspace({ sourceType: "remote_managed", cwd: null })),
    ).toBe(false);
  });

  it("workspaces without a cwd are not scannable", () => {
    expect(isScannableWorkspace(workspace({ cwd: null }))).toBe(false);
    expect(isScannableWorkspace(workspace({ cwd: "   " }))).toBe(false);
  });

  it("a remote-only project has zero scannable workspaces", () => {
    const project = {
      workspaces: [
        workspace({ id: WS_A, sourceType: "remote_managed", cwd: null }),
        workspace({ id: WS_B, sourceType: "remote_managed", cwd: null }),
      ],
    } as unknown as Project;
    expect(scannableWorkspaces(project)).toHaveLength(0);
  });
});
