import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  mirrorDirectory,
  prepareSandboxManagedRuntime,
  type SandboxManagedRuntimeClient,
} from "./sandbox-managed-runtime.js";

const execFile = promisify(execFileCallback);

describe("sandbox managed runtime", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("preserves excluded local workspace artifacts during restore mirroring", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-restore-"));
    cleanupDirs.push(rootDir);
    const sourceDir = path.join(rootDir, "source");
    const targetDir = path.join(rootDir, "target");
    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    await mkdir(path.join(targetDir, ".claude"), { recursive: true });
    await mkdir(path.join(targetDir, ".paperclip-runtime"), { recursive: true });
    await writeFile(path.join(sourceDir, "src", "app.ts"), "export const value = 2;\n", "utf8");
    await writeFile(path.join(targetDir, "stale.txt"), "remove me\n", "utf8");
    await writeFile(path.join(targetDir, ".claude", "settings.json"), "{\"keep\":true}\n", "utf8");
    await writeFile(path.join(targetDir, ".claude.json"), "{\"keep\":true}\n", "utf8");
    await writeFile(path.join(targetDir, ".paperclip-runtime", "state.json"), "{}\n", "utf8");

    await mirrorDirectory(sourceDir, targetDir, {
      preserveAbsent: [".paperclip-runtime", ".claude", ".claude.json"],
    });

    await expect(readFile(path.join(targetDir, "src", "app.ts"), "utf8")).resolves.toBe("export const value = 2;\n");
    await expect(readFile(path.join(targetDir, ".claude", "settings.json"), "utf8")).resolves.toBe("{\"keep\":true}\n");
    await expect(readFile(path.join(targetDir, ".claude.json"), "utf8")).resolves.toBe("{\"keep\":true}\n");
    await expect(readFile(path.join(targetDir, ".paperclip-runtime", "state.json"), "utf8")).resolves.toBe("{}\n");
    await expect(readFile(path.join(targetDir, "stale.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("syncs workspace and assets through a provider-neutral sandbox client", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-managed-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localAssetsDir = path.join(rootDir, "local-assets");
    const linkedAssetPath = path.join(rootDir, "linked-skill.md");
    await mkdir(path.join(localWorkspaceDir, ".claude"), { recursive: true });
    await mkdir(localAssetsDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "local workspace\n", "utf8");
    await writeFile(path.join(localWorkspaceDir, "._README.md"), "appledouble\n", "utf8");
    await writeFile(path.join(localWorkspaceDir, ".claude", "settings.json"), "{\"local\":true}\n", "utf8");
    await writeFile(linkedAssetPath, "skill body\n", "utf8");
    await symlink(linkedAssetPath, path.join(localAssetsDir, "skill.md"));

    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async (remotePath) => {
        const entries = await readdir(remotePath, { withFileTypes: true }).catch(() => []);
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort((left, right) => left.localeCompare(right));
      },
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], {
          maxBuffer: 32 * 1024 * 1024,
        });
      },
    };

    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      workspaceExclude: [".claude"],
      preserveAbsentOnRestore: [".claude"],
      assets: [{
        key: "skills",
        localDir: localAssetsDir,
        followSymlinks: true,
      }],
    });

    await expect(readFile(path.join(remoteWorkspaceDir, "README.md"), "utf8")).resolves.toBe("local workspace\n");
    await expect(readFile(path.join(remoteWorkspaceDir, "._README.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(remoteWorkspaceDir, ".claude", "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(prepared.assetDirs.skills, "skill.md"), "utf8")).resolves.toBe("skill body\n");
    expect((await lstat(path.join(prepared.assetDirs.skills, "skill.md"))).isFile()).toBe(true);

    await writeFile(path.join(remoteWorkspaceDir, "README.md"), "remote workspace\n", "utf8");
    await writeFile(path.join(remoteWorkspaceDir, "remote-only.txt"), "sync back\n", "utf8");
    await mkdir(path.join(localWorkspaceDir, ".paperclip-runtime"), { recursive: true });
    await writeFile(path.join(localWorkspaceDir, ".paperclip-runtime", "state.json"), "{}\n", "utf8");
    await writeFile(path.join(localWorkspaceDir, "local-stale.txt"), "remove\n", "utf8");
    await prepared.restoreWorkspace();

    await expect(readFile(path.join(localWorkspaceDir, "README.md"), "utf8")).resolves.toBe("remote workspace\n");
    await expect(readFile(path.join(localWorkspaceDir, "remote-only.txt"), "utf8")).resolves.toBe("sync back\n");
    await expect(readFile(path.join(localWorkspaceDir, "local-stale.txt"), "utf8")).resolves.toBe("remove\n");
    await expect(readFile(path.join(localWorkspaceDir, ".claude", "settings.json"), "utf8")).resolves.toBe("{\"local\":true}\n");
    await expect(readFile(path.join(localWorkspaceDir, ".paperclip-runtime", "state.json"), "utf8")).resolves.toBe("{}\n");
  });

  it("builds workspace/asset tarballs without a './' self-entry (so untar does not chmod/utime an unowned target dir)", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-tarself-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localAssetsDir = path.join(rootDir, "local-assets");
    await mkdir(path.join(localWorkspaceDir, "src"), { recursive: true });
    await mkdir(localAssetsDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "ws\n", "utf8");
    await writeFile(path.join(localWorkspaceDir, "src", "main.ts"), "x\n", "utf8");
    await writeFile(path.join(localAssetsDir, "asset.txt"), "a\n", "utf8");

    // Capture every tar uploaded to the sandbox so we can inspect its members.
    const uploadedTars: { remotePath: string; bytes: Buffer }[] = [];
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        const buffer = Buffer.from(bytes);
        if (remotePath.endsWith("-upload.tar")) uploadedTars.push({ remotePath, bytes: buffer });
        await writeFile(remotePath, buffer);
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };

    await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "skills", localDir: localAssetsDir }],
    });

    expect(uploadedTars.length).toBeGreaterThanOrEqual(2);
    for (const { remotePath, bytes } of uploadedTars) {
      const listPath = path.join(rootDir, `list-${path.basename(remotePath)}`);
      await writeFile(listPath, bytes);
      const { stdout } = await execFile("tar", ["-tf", listPath], { maxBuffer: 32 * 1024 * 1024 });
      const members = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      // The archive must NOT contain a self-entry for the root directory; that is
      // what makes tar try to mutate the (possibly unowned) extraction target.
      expect(members).not.toContain(".");
      expect(members).not.toContain("./");
    }

    // And the workspace still extracts correctly into an existing target dir.
    await expect(readFile(path.join(remoteWorkspaceDir, "README.md"), "utf8")).resolves.toBe("ws\n");
    await expect(readFile(path.join(remoteWorkspaceDir, "src", "main.ts"), "utf8")).resolves.toBe("x\n");
  });

  it("tolerates a tar exit code 1 (benign 'file changed as we read it') when restoring the workspace", async () => {
    // GNU/busybox tar returns exit code 1 for benign warnings — most commonly
    // "file changed as we read it" when archiving a live workspace whose files
    // mutate during the `tar -c`. That is guaranteed for an active agent run and
    // must NOT abort the run; only exit code 2 (a real archive error) is fatal.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-tarexit1-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const fakeBinDir = path.join(rootDir, "fakebin");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "ws\n", "utf8");

    // A `tar` shim that does the real work via the system tar, then exits 1 to
    // simulate the benign warning. Used only for the remote (client.run) tar
    // invocations; the local helper tars still use the real system tar.
    const realTar = (await execFile("sh", ["-c", "command -v tar"]))
      .stdout.trim();
    const tarShimPath = path.join(fakeBinDir, "tar");
    await writeFile(
      tarShimPath,
      `#!/bin/sh\n${realTar} "$@"\nstatus=$?\nif [ "$status" -eq 0 ]; then exit 1; fi\nexit "$status"\n`,
      "utf8",
    );
    await chmod(tarShimPath, 0o755);

    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      // Mirror command-managed-runtime semantics: throw on any non-zero exit so
      // the test exercises the real fatality contract. With the tar shim on PATH
      // (so the scripts' bare `tar` resolves to it) the restore script must still
      // exit 0 — proving the tar exit-1 tolerance is baked into the script.
      run: async (command) => {
        await execFile("sh", ["-c", command], {
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH ?? ""}` },
        }).catch((err: NodeJS.ErrnoException & { code?: number }) => {
          throw new Error(`run failed with exit code ${err.code ?? "null"}`);
        });
      },
    };

    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
    });

    await writeFile(path.join(remoteWorkspaceDir, "README.md"), "remote\n", "utf8");
    // The restore tar exits 1 via the shim; the script must swallow that and the
    // workspace must still round-trip back to the local dir.
    await expect(prepared.restoreWorkspace()).resolves.toBeUndefined();
    await expect(readFile(path.join(localWorkspaceDir, "README.md"), "utf8")).resolves.toBe("remote\n");
  });

  it("creates a valid empty workspace tarball when the local workspace is empty", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-empty-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });

    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };

    await expect(
      prepareSandboxManagedRuntime({
        spec: {
          transport: "sandbox",
          provider: "test",
          sandboxId: "sandbox-1",
          remoteCwd: remoteWorkspaceDir,
          timeoutMs: 30_000,
          apiKey: null,
        },
        adapterKey: "test-adapter",
        client,
        workspaceLocalDir: localWorkspaceDir,
      }),
    ).resolves.toBeDefined();
  });
});
