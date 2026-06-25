import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildRemoteGitDeltaBundleScript,
  createImportedGitRef,
  createRemoteGitExportRef,
  deleteLocalGitRef,
  fetchGitBundleIntoLocalRef,
  GIT_ARCHIVE_EXCLUDES,
  integrateImportedGitHead,
  readGitWorkspaceSnapshot,
  resetLocalGitIndexToHead,
  withShallowGitWorkspaceClone,
} from "./git-workspace-sync.js";
import { captureDirectorySnapshot, mergeDirectoryWithBaseline } from "./workspace-restore-merge.js";
import {
  createRuntimeProgressReporter,
  type RuntimeProgressDirection,
  type RuntimeProgressPhase,
  type RuntimeProgressSink,
  type RuntimeStatusPhase,
  type RuntimeStatusSink,
} from "./runtime-progress.js";
import { isRelativePathOrDescendant, shouldExcludePath } from "./exclude-patterns.js";

const execFile = promisify(execFileCallback);
const SANDBOX_WORKSPACE_HEAVY_DIR_NAMES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
] as const;
const SANDBOX_WORKSPACE_HEAVY_DIR_EXCLUDES = SANDBOX_WORKSPACE_HEAVY_DIR_NAMES.flatMap((entry) => [
  entry,
  `${entry}/*`,
  `*/${entry}`,
  `*/${entry}/*`,
]);

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

/**
 * Per-call byte-level progress hook. `transferredBytes`/`totalBytes` are decoded
 * file bytes (not the base64 wire size). `totalBytes` is null when the size is
 * not known up front. The transport is the source of truth for byte counts; the
 * orchestrator owns the phase label and direction.
 */
export interface SandboxTransferProgressOptions {
  onProgress?: (transferredBytes: number, totalBytes: number | null) => void | Promise<void>;
}

export interface SandboxManagedRuntimeClient {
  makeDir(remotePath: string): Promise<void>;
  writeFile(remotePath: string, bytes: ArrayBuffer, options?: SandboxTransferProgressOptions): Promise<void>;
  readFile(
    remotePath: string,
    options?: SandboxTransferProgressOptions,
  ): Promise<Buffer | Uint8Array | ArrayBuffer>;
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
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
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
  // Archive the directory's top-level entries BY NAME rather than ".". Archiving
  // "." embeds a "./" self-entry whose mode/mtime tar then tries to restore onto
  // the extraction target directory; that chmod/utime fails with "Operation not
  // permitted" when the target is a directory the extracting (non-root) user does
  // not own, e.g. an emptyDir mount in a hardened/gVisor sandbox pod. Enumerating
  // entries avoids the self-entry entirely and is portable across GNU/BSD/busybox
  // tar (no GNU-only --no-overwrite-dir needed). --exclude still filters nested
  // matches and any named entry it matches.
  const entries = (await fs.readdir(input.localDir)).sort((left, right) => left.localeCompare(right));
  if (entries.length === 0) {
    // A workspace can legitimately be empty (blank-workspace agent runs). Write a
    // valid empty tar archive (1024-byte all-zero EOF marker) so extraction is a
    // clean no-op rather than tar refusing to create an empty archive.
    await fs.writeFile(input.archivePath, Buffer.alloc(1024));
    return;
  }
  await execTar([
    "-c",
    // Prevent macOS bsdtar from embedding LIBARCHIVE.xattr.* PAX extended
    // headers for extended attributes (e.g. com.apple.provenance). GNU tar on
    // Linux does not recognise these proprietary headers and fails extraction
    // with "This does not look like a tar archive". COPYFILE_DISABLE=1 (set in
    // execTar) already suppresses AppleDouble ._* sidecar files; --no-xattrs
    // additionally suppresses the inline PAX xattr entries.
    "--no-xattrs",
    ...(input.followSymlinks ? ["-h"] : []),
    "-f",
    input.archivePath,
    "-C",
    input.localDir,
    ...excludeArgs,
    "--",
    ...entries,
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

async function copyWorkspaceEntry(sourceRoot: string, targetRoot: string, relative: string): Promise<void> {
  const sourcePath = path.join(sourceRoot, relative);
  const targetPath = path.join(targetRoot, relative);
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

  const entries = (await walkDirectory(sourceDir)).sort((left, right) => left.localeCompare(right));
  for (const relative of entries) {
    await copyWorkspaceEntry(sourceDir, targetDir, relative);
  }
}

async function copySelectedWorkspaceEntries(input: {
  sourceDir: string;
  targetDir: string;
  relativePaths: string[];
  exclude: string[];
}): Promise<void> {
  await fs.mkdir(input.targetDir, { recursive: true });
  for (const relative of input.relativePaths) {
    if (shouldExcludePath(relative, input.exclude)) continue;
    const sourceStats = await fs.lstat(path.join(input.sourceDir, relative)).catch(() => null);
    if (!sourceStats) continue;
    await copyWorkspaceEntry(input.sourceDir, input.targetDir, relative);
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

async function emitRuntimeStatus(
  sink: RuntimeStatusSink | undefined,
  phase: RuntimeStatusPhase,
  message: string,
): Promise<void> {
  if (!sink) return;
  await Promise.resolve(sink({ phase, message })).catch(() => undefined);
}

function mergeExcludes(...groups: Array<string[] | undefined>): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))];
}

function preserveFindArgs(entries: string[]): string {
  return entries.map((entry) => `! -name ${shellQuote(entry)}`).join(" ");
}

async function removeDeletedPathsInSandbox(input: {
  client: SandboxManagedRuntimeClient;
  spec: SandboxRemoteExecutionSpec;
  remoteDir: string;
  deletedPaths: string[];
}): Promise<void> {
  if (input.deletedPaths.length === 0) return;
  const quotedPaths = input.deletedPaths.map((entry) => shellQuote(entry)).join(" ");
  await input.client.run(
    `sh -c ${shellQuote(`cd ${shellQuote(input.remoteDir)} && rm -rf -- ${quotedPaths}`)}`,
    { timeoutMs: input.spec.timeoutMs },
  );
}

// Bridge a single byte-level transfer to the throttled progress reporter. The
// transport reports decoded bytes via `options.onProgress`; the reporter turns
// them into a throttled, fully-formatted log line. `finish()` emits the terminal
// completion line (idempotent) once the transfer returns.
function makeTransferProgress(
  sink: RuntimeProgressSink | undefined,
  phase: RuntimeProgressPhase,
  direction: RuntimeProgressDirection,
  label?: string,
): { options: SandboxTransferProgressOptions | undefined; finish: () => Promise<void> } {
  if (!sink) return { options: undefined, finish: async () => {} };
  const reporter = createRuntimeProgressReporter({
    sink,
    phase,
    direction,
    target: "sandbox",
    label,
  });
  return {
    options: {
      onProgress: async (transferredBytes, totalBytes) => {
        await reporter.report(transferredBytes, totalBytes);
      },
    },
    finish: async () => {
      await reporter.complete();
    },
  };
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
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into writeFile/readFile.
  onProgress?: RuntimeProgressSink;
  onRuntimeProgress?: RuntimeStatusSink;
}): Promise<PreparedSandboxManagedRuntime> {
  const workspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);
  const gitSnapshot = await readGitWorkspaceSnapshot(input.workspaceLocalDir);
  const gitIgnoredExcludes = gitSnapshot?.ignoredPaths;
  const workspaceArchiveExclude = mergeExcludes(
    SANDBOX_WORKSPACE_HEAVY_DIR_EXCLUDES,
    [...GIT_ARCHIVE_EXCLUDES],
    input.workspaceExclude,
    gitIgnoredExcludes,
  );
  const restoreExclude = mergeExcludes(
    SANDBOX_WORKSPACE_HEAVY_DIR_EXCLUDES,
    [...GIT_ARCHIVE_EXCLUDES],
    [".paperclip-runtime"],
    input.preserveAbsentOnRestore,
    input.workspaceExclude,
    gitIgnoredExcludes,
  );
  const baselineSnapshot = await captureDirectorySnapshot(input.workspaceLocalDir, {
    exclude: restoreExclude,
  });

  await withTempDir("paperclip-sandbox-sync-", async (tempDir) => {
    const preservedNames = new Set([
      ".paperclip-runtime",
      ...(gitSnapshot ? [".git"] : []),
      ...(input.preserveAbsentOnRestore ?? []),
    ]);
    if (gitSnapshot) {
      await emitRuntimeStatus(input.onRuntimeProgress, "git_sync", "Syncing git history to sandbox");
      await withShallowGitWorkspaceClone({
        localDir: input.workspaceLocalDir,
        snapshot: gitSnapshot,
      }, async (cloneDir) => {
        const gitTarPath = path.join(tempDir, "git-workspace.tar");
        await createTarballFromDirectory({
          localDir: cloneDir,
          archivePath: gitTarPath,
          exclude: [".paperclip-runtime"],
        });
        const gitTarBytes = await fs.readFile(gitTarPath);
        const remoteGitTar = path.posix.join(runtimeRootDir, "git-workspace-upload.tar");
        await input.client.makeDir(runtimeRootDir);
        const gitUpload = makeTransferProgress(input.onProgress, "Syncing", "to", "git history");
        await input.client.writeFile(remoteGitTar, toArrayBuffer(gitTarBytes), gitUpload.options);
        await gitUpload.finish();
        await input.client.run(
          `sh -c ${shellQuote(
            `mkdir -p ${shellQuote(workspaceRemoteDir)} && ` +
              `find ${shellQuote(workspaceRemoteDir)} -mindepth 1 -maxdepth 1 ${preserveFindArgs([".paperclip-runtime"])} -exec rm -rf -- {} + && ` +
              `tar -xf ${shellQuote(remoteGitTar)} -C ${shellQuote(workspaceRemoteDir)} && ` +
              `rm -f ${shellQuote(remoteGitTar)}`,
          )}`,
          { timeoutMs: input.spec.timeoutMs },
        );
      });
    }

    const workspaceTarPath = path.join(tempDir, "workspace.tar");
    const workspaceArchiveDir = gitSnapshot ? path.join(tempDir, "workspace-overlay") : input.workspaceLocalDir;
    await emitRuntimeStatus(input.onRuntimeProgress, "config_sync", "Syncing workspace to sandbox");
    if (gitSnapshot) {
      await copySelectedWorkspaceEntries({
        sourceDir: input.workspaceLocalDir,
        targetDir: workspaceArchiveDir,
        relativePaths: gitSnapshot.overlayPaths,
        exclude: workspaceArchiveExclude,
      });
    }
    await createTarballFromDirectory({
      localDir: workspaceArchiveDir,
      archivePath: workspaceTarPath,
      exclude: gitSnapshot ? undefined : workspaceArchiveExclude,
    });
    const workspaceTarBytes = await fs.readFile(workspaceTarPath);
    const remoteWorkspaceTar = path.posix.join(runtimeRootDir, "workspace-upload.tar");
    await input.client.makeDir(runtimeRootDir);
    const workspaceUpload = makeTransferProgress(input.onProgress, "Syncing", "to", "workspace");
    await input.client.writeFile(
      remoteWorkspaceTar,
      toArrayBuffer(workspaceTarBytes),
      workspaceUpload.options,
    );
    await workspaceUpload.finish();
    const extractWorkspaceTarCommand = gitSnapshot
      ? `mkdir -p ${shellQuote(workspaceRemoteDir)} && ` +
        `tar -xf ${shellQuote(remoteWorkspaceTar)} -C ${shellQuote(workspaceRemoteDir)} && ` +
        `rm -f ${shellQuote(remoteWorkspaceTar)}`
      : `mkdir -p ${shellQuote(workspaceRemoteDir)} && ` +
        `find ${shellQuote(workspaceRemoteDir)} -mindepth 1 -maxdepth 1 ${preserveFindArgs([...preservedNames])} -exec rm -rf -- {} + && ` +
        `tar -xf ${shellQuote(remoteWorkspaceTar)} -C ${shellQuote(workspaceRemoteDir)} && ` +
        `rm -f ${shellQuote(remoteWorkspaceTar)}`;
    await input.client.run(
      `sh -c ${shellQuote(extractWorkspaceTarCommand)}`,
      { timeoutMs: input.spec.timeoutMs },
    );
    if (gitSnapshot) {
      await removeDeletedPathsInSandbox({
        client: input.client,
        spec: input.spec,
        remoteDir: workspaceRemoteDir,
        deletedPaths: gitSnapshot.deletedPaths,
      });
    }

    for (const asset of input.assets ?? []) {
      await emitRuntimeStatus(input.onRuntimeProgress, "config_sync", "Syncing runtime assets to sandbox");
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
      const assetUpload = makeTransferProgress(input.onProgress, "Syncing", "to", asset.key);
      await input.client.writeFile(remoteAssetTar, toArrayBuffer(assetTarBytes), assetUpload.options);
      await assetUpload.finish();
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
    restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
      const restoreSink = onProgress ?? input.onProgress;
      await withTempDir("paperclip-sandbox-restore-", async (tempDir) => {
        let importedRef: string | null = null;
        let importedHead: string | null = null;
        let remoteWorkspaceStatus = "dirty";
        try {
          if (gitSnapshot) {
            await emitRuntimeStatus(input.onRuntimeProgress, "export", "Exporting git changes from sandbox");
            importedRef = createImportedGitRef("sandbox");
            const remoteGitBundle = path.posix.join(runtimeRootDir, "git-delta.bundle");
            const remoteWorkspaceStatusPath = path.posix.join(runtimeRootDir, "workspace-status.txt");
            const exportRef = createRemoteGitExportRef("sandbox");
            await input.client.run(
              `sh -c ${shellQuote(buildRemoteGitDeltaBundleScript({
                remoteDir: workspaceRemoteDir,
                baseSha: gitSnapshot.headCommit,
                exportRef,
                bundlePath: remoteGitBundle,
                statusPath: remoteWorkspaceStatusPath,
              }))}`,
              { timeoutMs: input.spec.timeoutMs },
            );
            const gitExport = makeTransferProgress(restoreSink, "Exporting git history", "from");
            const bundleBytes = await input.client.readFile(remoteGitBundle, gitExport.options);
            await gitExport.finish();
            await input.client.remove(remoteGitBundle).catch(() => undefined);
            remoteWorkspaceStatus = await input.client.readFile(remoteWorkspaceStatusPath)
              .then((bytes) => toBuffer(bytes).toString("utf8").trim())
              .catch(() => "dirty");
            remoteWorkspaceStatus = remoteWorkspaceStatus === "clean" ? "clean" : "dirty";
            await input.client.remove(remoteWorkspaceStatusPath).catch(() => undefined);
            const bundlePath = path.join(tempDir, "git-delta.bundle");
            await fs.writeFile(bundlePath, toBuffer(bundleBytes));
            importedHead = await fetchGitBundleIntoLocalRef({
              localDir: input.workspaceLocalDir,
              bundlePath,
              exportRef,
              importedRef,
              baseSha: gitSnapshot.headCommit,
            });
          }

          const remoteWorkspaceTar = path.posix.join(runtimeRootDir, "workspace-download.tar");
          await emitRuntimeStatus(input.onRuntimeProgress, "restore", "Restoring workspace from sandbox");
          await input.client.run(
            `sh -c ${shellQuote(
              `mkdir -p ${shellQuote(runtimeRootDir)} && ` +
                `tar -cf ${shellQuote(remoteWorkspaceTar)} -C ${shellQuote(workspaceRemoteDir)} ` +
                `${tarExcludeFlags(restoreExclude)} .`,
            )}`,
            { timeoutMs: input.spec.timeoutMs },
          );
          const workspaceRestore = makeTransferProgress(restoreSink, "Restoring", "from", "workspace");
          const archiveBytes = await input.client.readFile(remoteWorkspaceTar, workspaceRestore.options);
          await workspaceRestore.finish();
          await input.client.remove(remoteWorkspaceTar).catch(() => undefined);
          const localArchivePath = path.join(tempDir, "workspace.tar");
          const extractedDir = path.join(tempDir, "workspace");
          await fs.writeFile(localArchivePath, toBuffer(archiveBytes));
          await extractTarballToDirectory({
            archivePath: localArchivePath,
            localDir: extractedDir,
          });
          const gitHeadToIntegrate = importedHead;
          await mergeDirectoryWithBaseline({
            baseline: baselineSnapshot,
            sourceDir: extractedDir,
            targetDir: input.workspaceLocalDir,
            beforeApply: gitHeadToIntegrate
              ? async () => {
                  await integrateImportedGitHead({
                    localDir: input.workspaceLocalDir,
                    importedHead: gitHeadToIntegrate,
                  });
                }
              : undefined,
            afterApply: gitSnapshot
              ? async () => {
                  await resetLocalGitIndexToHead({
                    localDir: input.workspaceLocalDir,
                    checkWorkingTreeClean: remoteWorkspaceStatus === "clean",
                  });
                }
              : undefined,
          });
        } finally {
          await emitRuntimeStatus(input.onRuntimeProgress, "finalize", "Finalizing sandbox workspace");
          if (importedRef) {
            await deleteLocalGitRef({ localDir: input.workspaceLocalDir, ref: importedRef });
          }
        }
      });
    },
  };
}
