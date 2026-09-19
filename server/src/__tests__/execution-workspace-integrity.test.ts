import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  auditExecutionWorkspaceRow,
  type ProjectWorkspaceRef,
} from "../services/execution-workspace-integrity.js";

// The exact shape of LUN-7697: project `bangerz-army.com` carries a git
// checkout and an assets folder, and an execution workspace ended up naming the
// first while running in the second.
const gitWorkspace: ProjectWorkspaceRef = {
  id: "ws-git",
  name: "bangerzarmy-homepage",
  sourceType: "git_repo",
  cwd: "/Users/dev/bangerzarmy-homepage",
};
const assetsWorkspace: ProjectWorkspaceRef = {
  id: "ws-assets",
  name: "BANGERZ MERCH DESIGN assets",
  sourceType: "non_git_path",
  cwd: "/Users/Desktop/BANGERZ-MERCH-DESIGN",
};

function buildRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "exec-1",
    projectId: "project-1",
    projectWorkspaceId: gitWorkspace.id,
    issueId: "issue-1",
    cwd: gitWorkspace.cwd,
    ...overrides,
  };
}

describe("auditExecutionWorkspaceRow", () => {
  it("names the crossed workspaces, not the missing git metadata", async () => {
    const finding = await auditExecutionWorkspaceRow({
      row: buildRow({ cwd: assetsWorkspace.cwd }),
      linkedWorkspace: gitWorkspace,
      projectWorkspaces: [gitWorkspace, assetsWorkspace],
    });

    expect(finding?.kind).toBe("sibling_cwd");
    expect(finding?.detail).toContain('names workspace "bangerzarmy-homepage"');
    expect(finding?.detail).toContain('runs in "BANGERZ MERCH DESIGN assets"');
  });

  it("reports a git workspace whose cwd is gone as a missing path", async () => {
    const cwd = path.join(os.tmpdir(), "pc-audit-never-created-7697");
    await fs.rm(cwd, { recursive: true, force: true });

    const finding = await auditExecutionWorkspaceRow({
      row: buildRow({ cwd }),
      linkedWorkspace: { ...gitWorkspace, cwd },
      projectWorkspaces: [{ ...gitWorkspace, cwd }],
    });

    expect(finding?.kind).toBe("missing_workspace_path");
  });

  it("reports a git workspace whose disk is unplugged as an unmounted volume", async () => {
    const absentVolume = `${path.sep}Volumes${path.sep}pc-absent-volume-audit-7697`;
    const cwd = path.join(absentVolume, "dev", "repo");
    expect(
      await fs
        .stat(absentVolume)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);

    const finding = await auditExecutionWorkspaceRow({
      row: buildRow({ cwd }),
      linkedWorkspace: { ...gitWorkspace, cwd },
      projectWorkspaces: [{ ...gitWorkspace, cwd }],
    });

    expect(finding?.kind).toBe("workspace_volume_not_mounted");
    expect(finding?.detail).toContain(absentVolume);
  });

  it("passes a git workspace that really is a checkout", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pc-audit-repo-"));
    try {
      await fs.mkdir(path.join(cwd, ".git"));
      const finding = await auditExecutionWorkspaceRow({
        row: buildRow({ cwd }),
        linkedWorkspace: { ...gitWorkspace, cwd },
        projectWorkspaces: [{ ...gitWorkspace, cwd }],
      });

      expect(finding).toBeNull();
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("holds a non_git_path workspace to existence only, never to git", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pc-audit-assets-"));
    try {
      const finding = await auditExecutionWorkspaceRow({
        row: buildRow({ projectWorkspaceId: assetsWorkspace.id, cwd }),
        linkedWorkspace: { ...assetsWorkspace, cwd },
        projectWorkspaces: [{ ...assetsWorkspace, cwd }],
      });

      expect(finding).toBeNull();
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("leaves Paperclip-managed default folders alone", async () => {
    const finding = await auditExecutionWorkspaceRow({
      row: buildRow({
        projectWorkspaceId: null,
        cwd: "/Users/paperclip/_default",
      }),
      linkedWorkspace: null,
      projectWorkspaces: [],
    });

    expect(finding).toBeNull();
  });
});
