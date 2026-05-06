import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceFileBrowserError,
  listWorkspaceFiles,
  readWorkspaceFileContent,
} from "./workspace-file-browser.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-browser-"));
  tempDirs.push(workspacePath);
  return workspacePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("workspace file browser", () => {
  it("lists workspace entries with directories first", async () => {
    const workspacePath = await createTempWorkspace();
    await fs.mkdir(path.join(workspacePath, "src"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "README.md"), "# hello\n");

    const listing = await listWorkspaceFiles({
      workspaceKind: "project_workspace",
      workspaceId: "workspace-1",
      workspaceName: "Primary workspace",
      rootPath: workspacePath,
    });

    expect(listing.currentPath).toBe("");
    expect(listing.parentPath).toBeNull();
    expect(listing.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["dir:src", "file:README.md"]);
    expect(listing.entries[1]).toMatchObject({
      contentType: "text/markdown",
      previewable: true,
    });
  });

  it("rejects path traversal", async () => {
    const workspacePath = await createTempWorkspace();

    await expect(
      listWorkspaceFiles({
        workspaceKind: "project_workspace",
        workspaceId: "workspace-1",
        workspaceName: "Primary workspace",
        rootPath: workspacePath,
        relativePath: "../secrets",
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Path traversal is not allowed.",
    });
  });

  it("reads text previews and truncates large files", async () => {
    const workspacePath = await createTempWorkspace();
    const content = `${"abc123\n".repeat(25_000)}`;
    await fs.writeFile(path.join(workspacePath, "server.log"), content);

    const preview = await readWorkspaceFileContent({
      workspaceKind: "execution_workspace",
      workspaceId: "workspace-2",
      workspaceName: "Run workspace",
      rootPath: workspacePath,
      relativePath: "server.log",
    });

    expect(preview.previewable).toBe(true);
    expect(preview.truncated).toBe(true);
    expect(preview.content.startsWith("abc123")).toBe(true);
    expect(preview.content.length).toBeLessThan(content.length);
  });
});
