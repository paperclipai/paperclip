import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertSyncOperationsConfined,
  prepareSandboxManagedRuntime,
  type SandboxManagedRuntimeClient,
  type SandboxSyncOperation,
} from "./sandbox-managed-runtime.js";

const execFile = promisify(execFileCallback);

interface RecordingClient {
  client: SandboxManagedRuntimeClient;
  syncInOps: SandboxSyncOperation[][];
  syncOutOps: SandboxSyncOperation[][];
}

// A filesystem-backed client that additionally exposes native syncIn/syncOut,
// mirroring a provider that opted into the sync verbs. The native transfer is a
// faithful destroy-then-replace directory copy honoring followSymlinks.
function makeNativeClient(): RecordingClient {
  const syncInOps: SandboxSyncOperation[][] = [];
  const syncOutOps: SandboxSyncOperation[][] = [];

  const transferDirectory = async (
    sourcePath: string,
    targetPath: string,
    followSymlinks: boolean | undefined,
  ): Promise<number> => {
    await rm(targetPath, { recursive: true, force: true });
    await mkdir(targetPath, { recursive: true });
    // followSymlinks true dereferences to bytes (like tar -h); falsy preserves links.
    const copyArgs = followSymlinks ? ["-RL"] : ["-a"];
    await execFile("cp", [...copyArgs, `${sourcePath}/.`, targetPath]);
    const entries = await readdir(targetPath, { withFileTypes: true }).catch(() => []);
    return entries.length;
  };

  const applyOperations = async (operations: SandboxSyncOperation[]) => ({
    operations: await Promise.all(operations.map(async (operation) => {
      let filesTransferred = 0;
      for (const mapping of operation.files) {
        if (mapping.kind === "directory") {
          filesTransferred += await transferDirectory(mapping.sourcePath, mapping.targetPath, mapping.followSymlinks);
        } else {
          await mkdir(path.dirname(mapping.targetPath), { recursive: true });
          await writeFile(mapping.targetPath, await readFile(mapping.sourcePath));
          filesTransferred += 1;
        }
      }
      return { operationId: operation.operationId, filesTransferred, bytesTransferred: 0 };
    })),
  });

  const client: SandboxManagedRuntimeClient = {
    makeDir: async (remotePath) => { await mkdir(remotePath, { recursive: true }); },
    writeFile: async (remotePath, bytes) => {
      await mkdir(path.dirname(remotePath), { recursive: true });
      await writeFile(remotePath, Buffer.from(bytes));
    },
    readFile: async (remotePath) => await readFile(remotePath),
    listFiles: async (remotePath) => {
      const entries = await readdir(remotePath, { withFileTypes: true }).catch(() => []);
      return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
    },
    remove: async (remotePath) => { await rm(remotePath, { recursive: true, force: true }); },
    run: async (command) => { await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 }); },
    syncIn: async (operations) => { syncInOps.push(operations); return applyOperations(operations); },
    syncOut: async (operations) => { syncOutOps.push(operations); return applyOperations(operations); },
  };

  return { client, syncInOps, syncOutOps };
}

describe("sandbox native file sync", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("prefers the native path for default-provision asset inbound and workspace outbound", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-native-sync-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localAssetsDir = path.join(rootDir, "local-assets");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(localAssetsDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "local workspace\n", "utf8");
    await writeFile(path.join(localAssetsDir, "skill.md"), "skill body\n", "utf8");

    const { client, syncInOps, syncOutOps } = makeNativeClient();
    const prepared = await prepareSandboxManagedRuntime({
      spec: { transport: "sandbox", provider: "test", sandboxId: "s1", remoteCwd: remoteWorkspaceDir, timeoutMs: 30_000, apiKey: null },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "skills", localDir: localAssetsDir }],
    });

    // The default-provision asset was transferred through syncIn as a single
    // directory mapping with an opaque operationId; the file landed in place.
    const inboundOps = syncInOps.flat();
    expect(inboundOps.length).toBe(1);
    const assetOp = inboundOps[0];
    expect(assetOp.operationId).toMatch(/^sync-op-\d+$/);
    expect(assetOp.operationId).not.toContain("skills");
    expect(assetOp.files).toEqual([
      { sourcePath: localAssetsDir, targetPath: prepared.assetDirs.skills, kind: "directory", exclude: undefined, followSymlinks: undefined },
    ]);
    expect(await readFile(path.join(prepared.assetDirs.skills, "skill.md"), "utf8")).toBe("skill body\n");

    // Mutate the sandbox workspace, then restore through the native outbound path.
    await writeFile(path.join(remoteWorkspaceDir, "README.md"), "remote workspace\n", "utf8");
    await writeFile(path.join(remoteWorkspaceDir, "new.txt"), "added\n", "utf8");
    await prepared.restoreWorkspace();

    const outboundOps = syncOutOps.flat();
    expect(outboundOps.length).toBe(1);
    expect(outboundOps[0].files[0]).toMatchObject({ sourcePath: remoteWorkspaceDir, kind: "directory" });
    expect(await readFile(path.join(localWorkspaceDir, "README.md"), "utf8")).toBe("remote workspace\n");
    expect(await readFile(path.join(localWorkspaceDir, "new.txt"), "utf8")).toBe("added\n");
  });

  it("keeps a custom-provision asset on the tar fallback even when native sync is available", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-native-custom-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localAssetsDir = path.join(rootDir, "local-assets");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(localAssetsDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "ws\n", "utf8");
    await writeFile(path.join(localAssetsDir, "cred.txt"), "secret\n", "utf8");

    const { client, syncInOps } = makeNativeClient();
    const prepared = await prepareSandboxManagedRuntime({
      spec: { transport: "sandbox", provider: "test", sandboxId: "s1", remoteCwd: remoteWorkspaceDir, timeoutMs: 30_000, apiKey: null },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      assets: [{
        key: "creds",
        localDir: localAssetsDir,
        // A bespoke extract command (e.g. a credential merge) cannot be a generic
        // file mapping, so the orchestrator keeps it on the tar path.
        provision: { extractCommand: ({ assetTarPath, assetDir }) =>
          `rm -rf ${assetDir} && mkdir -p ${assetDir} && tar -xf ${assetTarPath} -C ${assetDir} && rm -f ${assetTarPath}` },
      }],
    });

    // No syncIn operation for the custom asset; it still materializes via tar.
    expect(syncInOps.flat().length).toBe(0);
    expect(await readFile(path.join(prepared.assetDirs.creds, "cred.txt"), "utf8")).toBe("secret\n");
  });

  it("dereferences symlinks only when followSymlinks is true (native honors the flag)", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-native-symlink-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetsPreserve = path.join(rootDir, "assets-preserve");
    const assetsDeref = path.join(rootDir, "assets-deref");
    const target = path.join(rootDir, "target.md");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(assetsPreserve, { recursive: true });
    await mkdir(assetsDeref, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "ws\n", "utf8");
    await writeFile(target, "link body\n", "utf8");
    await symlink(target, path.join(assetsPreserve, "link.md"));
    await symlink(target, path.join(assetsDeref, "link.md"));

    const { client } = makeNativeClient();
    const prepared = await prepareSandboxManagedRuntime({
      spec: { transport: "sandbox", provider: "test", sandboxId: "s1", remoteCwd: remoteWorkspaceDir, timeoutMs: 30_000, apiKey: null },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      assets: [
        { key: "preserve", localDir: assetsPreserve, followSymlinks: false },
        { key: "deref", localDir: assetsDeref, followSymlinks: true },
      ],
    });

    expect((await lstat(path.join(prepared.assetDirs.preserve, "link.md"))).isSymbolicLink()).toBe(true);
    const dereffed = await lstat(path.join(prepared.assetDirs.deref, "link.md"));
    expect(dereffed.isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(prepared.assetDirs.deref, "link.md"), "utf8")).toBe("link body\n");
  });
});

describe("assertSyncOperationsConfined", () => {
  const op = (targetPath: string, sourcePath = "/host/src"): SandboxSyncOperation[] => [
    { operationId: "sync-op-1", files: [{ sourcePath, targetPath, kind: "directory" }] },
  ];

  it("accepts targets within an allowed root", () => {
    expect(() => assertSyncOperationsConfined(op("/remote/ws/sub"), {
      sourceRoots: ["/host/src"], targetRoots: ["/remote/ws"],
    })).not.toThrow();
  });

  it("rejects a relative target", () => {
    expect(() => assertSyncOperationsConfined(op("relative/path"), {
      sourceRoots: ["/host/src"], targetRoots: ["/remote/ws"],
    })).toThrow(/confined absolute path/);
  });

  it("rejects a parent-traversal escape", () => {
    expect(() => assertSyncOperationsConfined(op("/remote/ws/../etc/passwd"), {
      sourceRoots: ["/host/src"], targetRoots: ["/remote/ws"],
    })).toThrow(/confined absolute path|escapes its confinement root/);
  });

  it("rejects an absolute target outside every root", () => {
    expect(() => assertSyncOperationsConfined(op("/etc/passwd"), {
      sourceRoots: ["/host/src"], targetRoots: ["/remote/ws"],
    })).toThrow(/escapes its confinement root/);
  });

  it("rejects a source outside every source root", () => {
    expect(() => assertSyncOperationsConfined(op("/remote/ws/ok", "/etc/shadow"), {
      sourceRoots: ["/host/src"], targetRoots: ["/remote/ws"],
    })).toThrow(/escapes its confinement root/);
  });
});
