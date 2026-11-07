import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
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

import { syncDirectoryFromSsh } from "./ssh.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("syncDirectoryFromSsh symlinks", () => {
  it("keeps relative symlink targets as written", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ssh-restore-symlink-"));
    roots.push(root);
    const remoteDir = path.join(root, "remote");
    const localDir = path.join(root, "local");
    await mkdir(path.join(remoteDir, "docs"), { recursive: true });
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(remoteDir, "CLAUDE.md"), "hi\n");
    await symlink("CLAUDE.md", path.join(remoteDir, "AGENTS.md"));
    await symlink("../CLAUDE.md", path.join(remoteDir, "docs", "AGENTS.md"));

    await syncDirectoryFromSsh({
      spec: {
        host: "fixture.invalid", username: "fixture", port: 22,
        remoteCwd: remoteDir, remoteWorkspacePath: remoteDir,
        privateKey: null, knownHosts: null, strictHostKeyChecking: true,
      },
      remoteDir,
      localDir,
    });

    await expect(readlink(path.join(localDir, "AGENTS.md"))).resolves.toBe("CLAUDE.md");
    await expect(readlink(path.join(localDir, "docs", "AGENTS.md"))).resolves.toBe("../CLAUDE.md");
  });
});
