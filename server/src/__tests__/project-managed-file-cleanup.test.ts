import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveManagedProjectWorkspaceDir, resolvePaperclipInstanceRoot } from "../home-paths.ts";
import { removeProjectManagedFiles } from "../services/projects.ts";

describe("project managed-file cleanup", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const tempRoots: string[] = [];

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("removes the managed project root without touching external or sibling workspaces", async () => {
    const paperclipHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-project-cleanup-"));
    tempRoots.push(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;

    const companyId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const managedWorkspace = resolveManagedProjectWorkspaceDir({
      companyId,
      projectId,
      repoName: "repo",
    });
    const externalWorkspace = path.join(paperclipHome, "external-workspace");
    const siblingWorkspace = resolveManagedProjectWorkspaceDir({
      companyId,
      projectId: "33333333-3333-4333-8333-333333333333",
      repoName: "sibling",
    });
    await mkdir(managedWorkspace, { recursive: true });
    await mkdir(externalWorkspace, { recursive: true });
    await mkdir(siblingWorkspace, { recursive: true });
    await writeFile(path.join(managedWorkspace, "managed.txt"), "managed");
    await writeFile(path.join(externalWorkspace, "external.txt"), "external");
    await writeFile(path.join(siblingWorkspace, "sibling.txt"), "sibling");

    await removeProjectManagedFiles({
      companyId,
      projectId,
    });

    await expect(access(managedWorkspace)).rejects.toThrow();
    await expect(access(path.join(externalWorkspace, "external.txt"))).resolves.toBeUndefined();
    await expect(access(path.join(siblingWorkspace, "sibling.txt"))).resolves.toBeUndefined();
  });

  it.each(["projects", "company", "project"])("rejects a symlink at the %s directory", async (level) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-link-"));
    tempRoots.push(home);
    process.env.PAPERCLIP_HOME = home;
    const instanceRoot = resolvePaperclipInstanceRoot();
    const segments = ["projects", "company", "project"];
    const index = segments.indexOf(level);
    const parent = path.join(instanceRoot, ...segments.slice(0, index));
    const external = path.join(home, "external");
    const target = path.join(external, ...segments.slice(index + 1));
    await mkdir(parent, { recursive: true });
    await mkdir(target, { recursive: true });
    const sentinel = path.join(target, "keep.md");
    await writeFile(sentinel, "preserve");
    await symlink(external, path.join(parent, level));
    await expect(removeProjectManagedFiles({ companyId: "company", projectId: "project" }))
      .rejects.toThrow("redirected directory");
    await expect(access(sentinel)).resolves.toBeUndefined();
  });

  it("allows cleanup when the managed directory is absent", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-absent-"));
    tempRoots.push(home);
    process.env.PAPERCLIP_HOME = home;
    await expect(removeProjectManagedFiles({ companyId: "company", projectId: "project" }))
      .resolves.toBeUndefined();
  });

  it("rejects unsafe path segments", async () => {
    await expect(
      removeProjectManagedFiles({
        companyId: "../outside",
        projectId: "project-id",
      }),
    ).rejects.toThrow("Invalid company or project id");
  });
});
