import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.ts";
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
      workspaceCwds: [externalWorkspace, siblingWorkspace],
    });

    await expect(access(managedWorkspace)).rejects.toThrow();
    await expect(access(path.join(externalWorkspace, "external.txt"))).resolves.toBeUndefined();
    await expect(access(path.join(siblingWorkspace, "sibling.txt"))).resolves.toBeUndefined();
  });

  it("rejects unsafe path segments", async () => {
    await expect(
      removeProjectManagedFiles({
        companyId: "../outside",
        projectId: "project-id",
        workspaceCwds: [],
      }),
    ).rejects.toThrow("Invalid company or project id");
  });
});
