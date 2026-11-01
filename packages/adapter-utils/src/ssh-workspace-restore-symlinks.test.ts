import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (file === "ssh") return actual.spawn("sh", ["-c", args.at(-1)!], options);
      return actual.spawn(file, args, options);
    }),
  };
});

import { restoreWorkspaceFromSshExecution } from "./ssh.js";
import { PROJECT_REPOSITORIES_DIR } from "./git-workspace-sync.js";
import { captureDirectorySnapshot, disposeDirectorySnapshot } from "./workspace-restore-merge.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("SSH workspace restore symlinks", () => {
  it.each([
    { withBaseline: false, secondary: false },
    { withBaseline: true, secondary: false },
    { withBaseline: false, secondary: true },
    { withBaseline: true, secondary: true },
  ])("preserves link targets with baseline=$withBaseline and secondary=$secondary", async ({ withBaseline, secondary }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-symlinks-"));
    roots.push(root);
    const localDir = path.join(root, "local");
    const remoteDir = path.join(root, "remote");
    const repositoryPath = `${PROJECT_REPOSITORIES_DIR}/secondary`;
    const relativeDir = secondary ? repositoryPath : "";
    const localRepository = path.join(localDir, relativeDir);
    const remoteRepository = path.join(remoteDir, relativeDir);
    await fs.mkdir(localRepository, { recursive: true });
    await fs.mkdir(path.join(remoteRepository, "nested"), { recursive: true });
    const baselineSnapshot = withBaseline
      ? await captureDirectorySnapshot(localDir, { exclude: secondary ? [PROJECT_REPOSITORIES_DIR] : [] })
      : undefined;
    const repositoryBaseline = withBaseline && secondary
      ? await captureDirectorySnapshot(localRepository)
      : undefined;
    await fs.writeFile(path.join(remoteRepository, "instructions.md"), "instructions");
    const links = [
      ["agent.md", "instructions.md"],
      ["nested/agent.md", "../instructions.md"],
      ["dangling", "missing"],
      ["absolute", path.join(remoteRepository, "instructions.md")],
    ];
    for (const [name, target] of links) await fs.symlink(target, path.join(remoteRepository, name));
    try {
      await restoreWorkspaceFromSshExecution({
        spec: {
          host: "fixture.invalid", username: "fixture", port: 22,
          remoteCwd: remoteDir, remoteWorkspacePath: remoteDir,
          privateKey: null, knownHosts: null, strictHostKeyChecking: true,
        },
        localDir,
        baselineSnapshot,
        repositories: secondary ? [{ path: repositoryPath, baselineSnapshot: repositoryBaseline }] : undefined,
      });
      for (const [name, target] of links) {
        expect(await fs.readlink(path.join(localRepository, name))).toBe(target);
      }
      expect(await fs.readFile(path.join(localRepository, "agent.md"), "utf8")).toBe("instructions");
      expect(await fs.readFile(path.join(localRepository, "nested/agent.md"), "utf8")).toBe("instructions");
    } finally {
      if (repositoryBaseline) await disposeDirectorySnapshot(repositoryBaseline);
      if (baselineSnapshot) await disposeDirectorySnapshot(baselineSnapshot);
    }
  });
});
