import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupExecutionWorkspaceArtifacts } from "../services/workspace-runtime.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

async function localWorkspace(createdByRuntime: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-retained-dir-")); dirs.push(root);
  const cwd = path.join(root, "task-directory");
  await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, "website-fixture.txt"), "saved\n");
  return { cwd, workspace: { id: "workspace-1", companyId: "company-1", cwd, providerType: "local_fs", providerRef: null,
    branchName: null, repoUrl: null, baseRef: null, projectId: null, projectWorkspaceId: null, sourceIssueId: "issue-1",
    metadata: { createdByRuntime } } };
}

describe("closing a local workspace directory", () => {
  it("reports a retained directory the runtime did not create as cleaned and keeps its files", async () => {
    const { cwd, workspace } = await localWorkspace(false);
    const cleanup = await cleanupExecutionWorkspaceArtifacts({ workspace });
    expect(cleanup).toMatchObject({ cleaned: true, warnings: [] });
    await expect(fs.readFile(path.join(cwd, "website-fixture.txt"), "utf8")).resolves.toBe("saved\n");
  });

  it("still removes a runtime-created directory", async () => {
    const { cwd, workspace } = await localWorkspace(true);
    const cleanup = await cleanupExecutionWorkspaceArtifacts({ workspace });
    expect(cleanup.cleaned).toBe(true);
    await expect(fs.stat(cwd)).rejects.toThrow();
  });
});
