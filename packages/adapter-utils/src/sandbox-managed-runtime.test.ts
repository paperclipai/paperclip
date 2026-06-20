import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

  it("emits throttled, labeled upload and restore progress with direction and percentages", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-progress-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localAssetsDir = path.join(rootDir, "local-assets");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(localAssetsDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "workspace\n", "utf8");
    await writeFile(path.join(localAssetsDir, "skill.md"), "skill\n", "utf8");

    // Drive byte progress in 100 fine (1%) increments so the throttle has many
    // chances to emit; the reporter must collapse them to ~one line per 10% step.
    const driveProgress = async (
      total: number,
      onProgress: ((done: number, total: number | null) => void | Promise<void>) | undefined,
    ) => {
      if (!onProgress) return;
      for (let i = 1; i <= 100; i++) {
        await onProgress(Math.floor((total * i) / 100), total);
      }
    };

    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes, options) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        const buffer = Buffer.from(bytes);
        await writeFile(remotePath, buffer);
        await driveProgress(buffer.byteLength, options?.onProgress);
      },
      readFile: async (remotePath, options) => {
        const buffer = await readFile(remotePath);
        await driveProgress(buffer.byteLength, options?.onProgress);
        return buffer;
      },
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };

    const lines: string[] = [];
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
      assets: [{ key: "skills", localDir: localAssetsDir }],
      onProgress: (line) => {
        lines.push(line);
      },
    });

    const uploadWorkspaceLines = lines.filter((line) => line.includes("Syncing workspace to sandbox"));
    const uploadAssetLines = lines.filter((line) => line.includes("Syncing skills to sandbox"));
    expect(uploadWorkspaceLines.length).toBeGreaterThan(0);
    expect(uploadAssetLines.length).toBeGreaterThan(0);
    // 100 reported increments must be throttled to at most ~one line per 10% step.
    expect(uploadWorkspaceLines.length).toBeLessThanOrEqual(11);
    // Reaches 100% and shows the MB breakdown.
    expect(uploadWorkspaceLines.some((line) => line.includes("100%"))).toBe(true);
    expect(uploadWorkspaceLines.every((line) => /\(\d+\.\d\/\d+\.\d MB\)/.test(line))).toBe(true);

    await prepared.restoreWorkspace();
    const restoreLines = lines.filter((line) => line.includes("Restoring workspace from sandbox"));
    expect(restoreLines.length).toBeGreaterThan(0);
    expect(restoreLines.length).toBeLessThanOrEqual(11);
    expect(restoreLines.some((line) => line.includes("100%"))).toBe(true);
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
