import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { resolveDefaultBaseRef } from "../src/worker.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function createGitWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-diff-plugin-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "paperclip@example.com"]);
  await git(root, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(root, "src/app.ts"), "export const value = 1;\n");
  await git(root, ["add", "src/app.ts"]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["branch", "-M", "main"]);
  return root;
}

describe("workspace diff plugin", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("declares workspace Changes tabs and workspace read capabilities", () => {
    expect(manifest.capabilities).toContain("ui.detailTab.register");
    expect(manifest.capabilities).toContain("execution.workspaces.read");
    expect(manifest.capabilities).toContain("project.workspaces.read");
    expect(manifest.ui?.slots).toContainEqual(expect.objectContaining({
      type: "detailTab",
      displayName: "Changes",
      entityTypes: ["execution_workspace", "project_workspace"],
    }));
  });

  it("fetches changed execution workspace diffs from host metadata", async () => {
    const root = await createGitWorkspace();
    await fs.writeFile(path.join(root, "src/app.ts"), "export const value = 2;\n");
    const harness = createTestHarness({ manifest });
    harness.seed({
      executionWorkspaces: [{
        id: "workspace-1",
        companyId: "company-1",
        projectId: "project-1",
        projectWorkspaceId: null,
        path: root,
        cwd: root,
        repoUrl: null,
        baseRef: "HEAD",
        branchName: "main",
        providerType: "git_worktree",
        providerMetadata: null,
      }],
    });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.getData("workspace-diff", {
      workspaceId: "workspace-1",
      companyId: "company-1",
      view: "working-tree",
      includeUntracked: false,
      paths: ["src/app.ts"],
    });

    expect(result).toMatchObject({
      stats: { fileCount: 1 },
      files: [expect.objectContaining({ path: "src/app.ts" })],
    });
  });

  it("returns an empty diff when the workspace has no changes", async () => {
    const root = await createGitWorkspace();
    const harness = createTestHarness({ manifest });
    harness.seed({
      executionWorkspaces: [{
        id: "workspace-1",
        companyId: "company-1",
        projectId: "project-1",
        projectWorkspaceId: null,
        path: root,
        cwd: root,
        repoUrl: null,
        baseRef: "HEAD",
        branchName: "main",
        providerType: "git_worktree",
        providerMetadata: null,
      }],
    });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("workspace-diff", {
      workspaceId: "workspace-1",
      companyId: "company-1",
    })).resolves.toMatchObject({ files: [], truncated: false });
  });

  it("fetches project workspace diffs from generic project workspace metadata", async () => {
    const root = await createGitWorkspace();
    await git(root, ["checkout", "-b", "feature"]);
    await fs.writeFile(path.join(root, "src/app.ts"), "export const value = 3;\n");
    await git(root, ["add", "src/app.ts"]);
    await git(root, ["commit", "-m", "project workspace change"]);
    const harness = createTestHarness({ manifest });
    harness.ctx.projects.listWorkspaces = async (projectId, companyId) => {
      expect(projectId).toBe("project-1");
      expect(companyId).toBe("company-1");
      return [{
        id: "workspace-1",
        projectId: "project-1",
        name: "Primary",
        path: root,
        repoUrl: null,
        repoRef: "feature",
        defaultRef: "main",
        isPrimary: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }];
    };
    await plugin.definition.setup(harness.ctx);

    const result = await harness.getData("workspace-diff", {
      workspaceId: "workspace-1",
      companyId: "company-1",
      projectId: "project-1",
      entityType: "project_workspace",
      view: "head",
      includeUntracked: false,
    });

    expect(result).toMatchObject({
      baseRef: "main",
      defaultBaseRef: "main",
      stats: { fileCount: 1 },
      files: [expect.objectContaining({ path: "src/app.ts" })],
    });
  });

  it("resolves the default base ref from workspace and project workspace metadata", () => {
    expect(resolveDefaultBaseRef({
      workspaceBaseRef: " release/main ",
      projectWorkspaceDefaultRef: "origin/main",
      projectWorkspaceRepoRef: "feature",
    })).toBe("release/main");
    expect(resolveDefaultBaseRef({
      workspaceBaseRef: null,
      projectWorkspaceDefaultRef: " origin/main ",
      projectWorkspaceRepoRef: "feature",
    })).toBe("origin/main");
    expect(resolveDefaultBaseRef({
      workspaceBaseRef: "",
      projectWorkspaceDefaultRef: null,
      projectWorkspaceRepoRef: " feature ",
    })).toBe("feature");
    expect(resolveDefaultBaseRef({
      workspaceBaseRef: "",
      projectWorkspaceDefaultRef: null,
      projectWorkspaceRepoRef: "",
    })).toBeNull();
  });

  it("uses project workspace default refs for execution workspace head diffs", async () => {
    const root = await createGitWorkspace();
    await git(root, ["checkout", "-b", "feature"]);
    await fs.writeFile(path.join(root, "src/app.ts"), "export const value = 4;\n");
    await git(root, ["add", "src/app.ts"]);
    await git(root, ["commit", "-m", "feature change"]);
    const harness = createTestHarness({ manifest });
    harness.seed({
      executionWorkspaces: [{
        id: "workspace-1",
        companyId: "company-1",
        projectId: "project-1",
        projectWorkspaceId: "project-workspace-1",
        path: root,
        cwd: root,
        repoUrl: null,
        baseRef: null,
        branchName: "feature",
        providerType: "git_worktree",
        providerMetadata: null,
      }],
    });
    harness.ctx.projects.listWorkspaces = async (projectId, companyId) => {
      expect(projectId).toBe("project-1");
      expect(companyId).toBe("company-1");
      return [{
        id: "project-workspace-1",
        projectId: "project-1",
        name: "Primary",
        path: root,
        repoUrl: null,
        repoRef: "feature",
        defaultRef: "main",
        isPrimary: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }];
    };
    await plugin.definition.setup(harness.ctx);

    const result = await harness.getData("workspace-diff", {
      workspaceId: "workspace-1",
      companyId: "company-1",
      view: "head",
      includeUntracked: false,
    });

    expect(result).toMatchObject({
      baseRef: "main",
      defaultBaseRef: "main",
      stats: { fileCount: 1 },
      files: [expect.objectContaining({ path: "src/app.ts" })],
    });
  });

  it("uses the primary project workspace default ref when execution workspace has no workspace link", async () => {
    const root = await createGitWorkspace();
    await git(root, ["checkout", "-b", "feature"]);
    await fs.writeFile(path.join(root, "src/app.ts"), "export const value = 5;\n");
    await git(root, ["add", "src/app.ts"]);
    await git(root, ["commit", "-m", "feature change"]);
    const harness = createTestHarness({ manifest });
    harness.seed({
      executionWorkspaces: [{
        id: "workspace-1",
        companyId: "company-1",
        projectId: "project-1",
        projectWorkspaceId: null,
        path: root,
        cwd: root,
        repoUrl: null,
        baseRef: null,
        branchName: "feature",
        providerType: "git_worktree",
        providerMetadata: null,
      }],
    });
    harness.ctx.projects.listWorkspaces = async (projectId, companyId) => {
      expect(projectId).toBe("project-1");
      expect(companyId).toBe("company-1");
      return [{
        id: "project-workspace-1",
        projectId: "project-1",
        name: "Primary",
        path: root,
        repoUrl: null,
        repoRef: "feature",
        defaultRef: "main",
        isPrimary: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }];
    };
    await plugin.definition.setup(harness.ctx);

    const result = await harness.getData("workspace-diff", {
      workspaceId: "workspace-1",
      companyId: "company-1",
      projectId: "project-1",
      view: "head",
      baseRef: null,
      includeUntracked: false,
    });

    expect(result).toMatchObject({
      baseRef: "main",
      defaultBaseRef: "main",
      stats: { fileCount: 1 },
      files: [expect.objectContaining({ path: "src/app.ts" })],
    });
  });

  it("infers the default base ref from the execution workspace branch upstream", async () => {
    const root = await createGitWorkspace();
    await git(root, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
    await git(root, ["checkout", "-b", "feature"]);
    await git(root, ["config", "branch.feature.remote", "origin"]);
    await git(root, ["config", "branch.feature.merge", "refs/heads/master"]);
    await fs.writeFile(path.join(root, "src/app.ts"), "export const value = 6;\n");
    await git(root, ["add", "src/app.ts"]);
    await git(root, ["commit", "-m", "feature change"]);
    const harness = createTestHarness({ manifest });
    harness.seed({
      executionWorkspaces: [{
        id: "workspace-1",
        companyId: "company-1",
        projectId: "project-1",
        projectWorkspaceId: null,
        path: root,
        cwd: root,
        repoUrl: null,
        baseRef: null,
        branchName: "feature",
        providerType: "git_worktree",
        providerMetadata: null,
      }],
    });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("workspace-diff", {
      workspaceId: "workspace-1",
      companyId: "company-1",
      view: "working-tree",
      includeUntracked: false,
    })).resolves.toMatchObject({
      baseRef: null,
      defaultBaseRef: "origin/master",
      stats: { fileCount: 0 },
    });

    await expect(harness.getData("workspace-diff", {
      workspaceId: "workspace-1",
      companyId: "company-1",
      view: "head",
      baseRef: null,
      includeUntracked: false,
    })).resolves.toMatchObject({
      baseRef: "origin/master",
      defaultBaseRef: "origin/master",
      stats: { fileCount: 1 },
      files: [expect.objectContaining({ path: "src/app.ts" })],
    });
  });

  it("returns a clear bridge error when required context is missing", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("workspace-diff", {
      workspaceId: "workspace-1",
    })).rejects.toThrow("workspaceId and companyId are required");
  });
});
