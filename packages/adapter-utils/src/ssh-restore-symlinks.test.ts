import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) => {
      if (file !== "ssh") return actual.execFile(file, args, options, callback);
      return actual.execFile("sh", ["-c", args.at(-1)!], options, callback);
    }),
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (file !== "ssh") return actual.spawn(file, args, options ?? {});
      return actual.spawn("sh", ["-c", args.at(-1)!], options ?? {});
    }),
  };
});

import { restoreWorkspaceFromSshExecution, syncDirectoryFromSsh } from "./ssh.js";
import { captureDirectorySnapshot, disposeDirectorySnapshot } from "./workspace-restore-merge.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ssh-restore-symlinks-"));
  roots.push(root);
  const remoteDir = path.join(root, "remote");
  const localDir = path.join(root, "local");
  for (const dir of [remoteDir, localDir]) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "CLAUDE.md"), "instructions\n", "utf8");
    await symlink("CLAUDE.md", path.join(dir, "AGENTS.md"));
  }
  const spec = {
    host: "fixture.invalid", username: "fixture", port: 22,
    remoteCwd: remoteDir, remoteWorkspacePath: remoteDir,
    privateKey: null, knownHosts: null, strictHostKeyChecking: true,
  };
  return { remoteDir, localDir, spec };
}

describe("SSH restore symlinks", () => {
  it("keeps relative symlink targets when syncing a directory back from SSH", async () => {
    const { remoteDir, localDir, spec } = await fixture();
    await rm(path.join(localDir, "AGENTS.md"));

    await syncDirectoryFromSsh({ spec, remoteDir, localDir });

    await expect(readlink(path.join(localDir, "AGENTS.md"))).resolves.toBe("CLAUDE.md");
    await expect(readFile(path.join(localDir, "AGENTS.md"), "utf8")).resolves.toBe("instructions\n");
  });

  it("keeps relative symlink targets when restoring without a baseline", async () => {
    const { remoteDir, localDir, spec } = await fixture();
    await writeFile(path.join(remoteDir, "remote.txt"), "remote\n", "utf8");

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir });

    await expect(readlink(path.join(localDir, "AGENTS.md"))).resolves.toBe("CLAUDE.md");
    await expect(readFile(path.join(localDir, "remote.txt"), "utf8")).resolves.toBe("remote\n");
  });

  it("keeps relative symlink targets when restoring against a baseline", async () => {
    const { remoteDir, localDir, spec } = await fixture();
    const baselineSnapshot = await captureDirectorySnapshot(localDir, { exclude: [".paperclip-runtime"] });
    await writeFile(path.join(remoteDir, "remote.txt"), "remote\n", "utf8");

    try {
      await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir, baselineSnapshot });
    } finally {
      await disposeDirectorySnapshot(baselineSnapshot);
    }

    await expect(readlink(path.join(localDir, "AGENTS.md"))).resolves.toBe("CLAUDE.md");
    await expect(readFile(path.join(localDir, "remote.txt"), "utf8")).resolves.toBe("remote\n");
  });
});
