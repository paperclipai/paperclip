import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { captureDirectorySnapshot, mergeDirectoryWithBaseline } from "./workspace-restore-merge.js";

const execFile = promisify(execFileCallback);

export interface SandboxRemoteExecutionSpec {
  transport: "sandbox";
  provider: string;
  sandboxId: string;
  remoteCwd: string;
  timeoutMs: number;
  apiKey: string | null;
}

export interface SandboxManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
}

export interface SandboxManagedRuntimeClient {
  makeDir(remotePath: string): Promise<void>;
  writeFile(remotePath: string, bytes: ArrayBuffer): Promise<void>;
  readFile(remotePath: string): Promise<Buffer | Uint8Array | ArrayBuffer>;
  listFiles(remotePath: string): Promise<string[]>;
  remove(remotePath: string): Promise<void>;
  run(command: string, options: { timeoutMs: number }): Promise<void>;
}

export interface PreparedSandboxManagedRuntime {
  spec: SandboxRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  restoreWorkspace(): Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function parseSandboxRemoteExecutionSpec(value: unknown): SandboxRemoteExecutionSpec | null {
  const parsed = asObject(value);
  const transport = asString(parsed.transport).trim();
  const provider = asString(parsed.provider).trim();
  const sandboxId = asString(parsed.sandboxId).trim();
  const remoteCwd = asString(parsed.remoteCwd).trim();
  const timeoutMs = asNumber(parsed.timeoutMs);

  if (
    transport !== "sandbox" ||
    provider.length === 0 ||
    sandboxId.length === 0 ||
    remoteCwd.length === 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return null;
  }

  return {
    transport: "sandbox",
    provider,
    sandboxId,
    remoteCwd,
    timeoutMs,
    apiKey: asString(parsed.apiKey).trim() || null,
  };
}

export function buildSandboxExecutionSessionIdentity(spec: SandboxRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "sandbox",
    provider: spec.provider,
    sandboxId: spec.sandboxId,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function sandboxExecutionSessionMatches(saved: unknown, current: SandboxRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildSandboxExecutionSessionIdentity(current);
  if (!currentIdentity) return false;
  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.provider) === currentIdentity.provider &&
    asString(parsedSaved.sandboxId) === currentIdentity.sandboxId &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function execTar(args: string[]): Promise<void> {
  await execFile("tar", args, {
    env: {
      ...process.env,
      COPYFILE_DISABLE: "1",
    },
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function createTarballFromDirectory(input: {
  localDir: string;
  archivePath: string;
  exclude?: string[];
  followSymlinks?: boolean;
}): Promise<void> {
  const excludeArgs = ["._*", ...(input.exclude ?? [])].flatMap((entry) => ["--exclude", entry]);
  await execTar([
    "-c",
    ...(input.followSymlinks ? ["-h"] : []),
    "-f",
    input.archivePath,
    "-C",
    input.localDir,
    ...excludeArgs,
    ".",
  ]);
}

async function extractTarballToDirectory(input: {
  archivePath: string;
  localDir: string;
}): Promise<void> {
  await fs.mkdir(input.localDir, { recursive: true });
  await execTar(["-xf", input.archivePath, "-C", input.localDir]);
}

async function walkDirectory(root: string, relative = ""): Promise<string[]> {
  const current = path.join(root, relative);
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const nextRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    out.push(nextRelative);
    if (entry.isDirectory()) {
      out.push(...(await walkDirectory(root, nextRelative)));
    }
  }
  return out.sort((left, right) => right.length - left.length);
}

function isRelativePathOrDescendant(relative: string, candidate: string): boolean {
  return relative === candidate || relative.startsWith(`${candidate}/`);
}

export async function mirrorDirectory(
  sourceDir: string,
  targetDir: string,
  options: { preserveAbsent?: string[] } = {},
): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const preserveAbsent = new Set(options.preserveAbsent ?? []);
  const shouldPreserveAbsent = (relative: string) =>
    [...preserveAbsent].some((candidate) => isRelativePathOrDescendant(relative, candidate));

  const sourceEntries = new Set(await walkDirectory(sourceDir));
  const targetEntries = await walkDirectory(targetDir);
  for (const relative of targetEntries) {
    if (shouldPreserveAbsent(relative)) continue;
    if (!sourceEntries.has(relative)) {
      await fs.rm(path.join(targetDir, relative), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const copyEntry = async (relative: string) => {
    const sourcePath = path.join(sourceDir, relative);
    const targetPath = path.join(targetDir, relative);
    const stats = await fs.lstat(sourcePath);

    if (stats.isDirectory()) {
      await fs.mkdir(targetPath, { recursive: true });
      return;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    if (stats.isSymbolicLink()) {
      const linkTarget = await fs.readlink(sourcePath);
      await fs.symlink(linkTarget, targetPath);
      return;
    }

    await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE).catch(async () => {
      await fs.copyFile(sourcePath, targetPath);
    });
    await fs.chmod(targetPath, stats.mode);
  };

  const entries = (await walkDirectory(sourceDir)).sort((left, right) => left.localeCompare(right));
  for (const relative of entries) {
    await copyEntry(relative);
  }
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function toBuffer(bytes: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function tarExcludeFlags(exclude: string[] | undefined): string {
  return ["._*", ...(exclude ?? [])].map((entry) => `--exclude ${shellQuote(entry)}`).join(" ");
}

export async function prepareSandboxManagedRuntime(input: {
  spec: SandboxRemoteExecutionSpec;
  adapterKey: string;
  client: SandboxManagedRuntimeClient;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  workspaceExclude?: string[];
  preserveAbsentOnRestore?: string[];
  assets?: SandboxManagedRuntimeAsset[];
}): Promise<PreparedSandboxManagedRuntime> {
  const workspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);
  const baselineSnapshot = await captureDirectorySnapshot(input.workspaceLocalDir, {
    exclude: [...new Set([".paperclip-runtime", ...(input.preserveAbsentOnRestore ?? []), ...(input.workspaceExclude ?? [])])],
  });

  await withTempDir("paperclip-sandbox-sync-", async (tempDir) => {
    const workspaceTarPath = path.join(tempDir, "workspace.tar");
    await createTarballFromDirectory({
      localDir: input.workspaceLocalDir,
      archivePath: workspaceTarPath,
      exclude: input.workspaceExclude,
    });
    const workspaceTarBytes = await fs.readFile(workspaceTarPath);
    const remoteWorkspaceTar = path.posix.join(runtimeRootDir, "workspace-upload.tar");
    await input.client.makeDir(runtimeRootDir);
    await input.client.writeFile(remoteWorkspaceTar, toArrayBuffer(workspaceTarBytes));
    const preservedNames = new Set([".paperclip-runtime", ...(input.preserveAbsentOnRestore ?? [])]);
    const findPreserveArgs = [...preservedNames].map((entry) => `! -name ${shellQuote(entry)}`).join(" ");
    await input.client.run(
      `sh -c ${shellQuote(
        `mkdir -p ${shellQuote(workspaceRemoteDir)} && ` +
          `find ${shellQuote(workspaceRemoteDir)} -mindepth 1 -maxdepth 1 ${findPreserveArgs} -exec rm -rf -- {} + && ` +
          `tar -xf ${shellQuote(remoteWorkspaceTar)} -C ${shellQuote(workspaceRemoteDir)} && ` +
          `rm -f ${shellQuote(remoteWorkspaceTar)}`,
      )}`,
      { timeoutMs: input.spec.timeoutMs },
    );

    for (const asset of input.assets ?? []) {
      const assetTarPath = path.join(tempDir, `${asset.key}.tar`);
      await createTarballFromDirectory({
        localDir: asset.localDir,
        archivePath: assetTarPath,
        followSymlinks: asset.followSymlinks,
        exclude: asset.exclude,
      });
      const assetTarBytes = await fs.readFile(assetTarPath);
      const remoteAssetDir = path.posix.join(runtimeRootDir, asset.key);
      const remoteAssetTar = path.posix.join(runtimeRootDir, `${asset.key}-upload.tar`);
      await input.client.writeFile(remoteAssetTar, toArrayBuffer(assetTarBytes));
      await input.client.run(
        `sh -c ${shellQuote(
          `rm -rf ${shellQuote(remoteAssetDir)} && ` +
            `mkdir -p ${shellQuote(remoteAssetDir)} && ` +
            `tar -xf ${shellQuote(remoteAssetTar)} -C ${shellQuote(remoteAssetDir)} && ` +
            `rm -f ${shellQuote(remoteAssetTar)}`,
        )}`,
        { timeoutMs: input.spec.timeoutMs },
      );
    }
  });

  const assetDirs = Object.fromEntries(
    (input.assets ?? []).map((asset) => [asset.key, path.posix.join(runtimeRootDir, asset.key)]),
  );

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    restoreWorkspace: async () => {
      await withTempDir("paperclip-sandbox-restore-", async (tempDir) => {
        const remoteWorkspaceTar = path.posix.join(runtimeRootDir, "workspace-download.tar");
        await input.client.run(
          `sh -c ${shellQuote(
            `mkdir -p ${shellQuote(runtimeRootDir)} && ` +
              `tar -cf ${shellQuote(remoteWorkspaceTar)} -C ${shellQuote(workspaceRemoteDir)} ` +
              `${tarExcludeFlags(input.workspaceExclude)} .`,
          )}`,
          { timeoutMs: input.spec.timeoutMs },
        );
        const archiveBytes = await input.client.readFile(remoteWorkspaceTar);
        await input.client.remove(remoteWorkspaceTar).catch(() => undefined);
        const localArchivePath = path.join(tempDir, "workspace.tar");
        const extractedDir = path.join(tempDir, "workspace");
        await fs.writeFile(localArchivePath, toBuffer(archiveBytes));
        await extractTarballToDirectory({
          archivePath: localArchivePath,
          localDir: extractedDir,
        });
        await mergeDirectoryWithBaseline({
          baseline: baselineSnapshot,
          sourceDir: extractedDir,
          targetDir: input.workspaceLocalDir,
        });
      });
    },
  };
}
