import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileDownloadRequest, FileDownloadResponse, FileUpload, Sandbox } from "@daytonaio/sdk";
import type {
  PluginEnvironmentSyncResult,
  PluginSyncFileMapping,
  PluginSyncOperation,
} from "@paperclipai/plugin-sdk";

const execFileAsync = promisify(execFile);

// Reserved scratch-name stem for staged uploads/downloads and remote tarballs.
// The runtime's base64 fallback stages to `<path>.paperclip-upload`; the native
// transport reuses the same reserved prefix so a provider temp never collides
// with a real target or with the fallback's scratch name.
const SCRATCH_PREFIX = ".paperclip-upload";

function scratchName(suffix = ""): string {
  return `${SCRATCH_PREFIX}-${randomUUID()}${suffix}`;
}

/**
 * Single-quote a path for safe interpolation into a sandbox shell command. Every
 * path handed to `sandbox.process.executeCommand` (tar extract / `mv -f` rename)
 * MUST pass through this so a path containing shell metacharacters is transferred
 * literally, never interpreted.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Convert a POSIX numeric mode (e.g. `0o600`) to the octal string the Daytona
 * SDK's `setFilePermissions` expects (e.g. `"600"`), masked to the permission
 * bits so an accidental type flag never widens the mode.
 */
function toOctalModeString(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, "0");
}

/**
 * Host-side complete-mediation guard applied as defense-in-depth below the
 * orchestrator's own confinement. Every sandbox-side path (the sync target for
 * inbound, the sync source for outbound) MUST canonicalize inside the workspace
 * remote dir; absolute escapes and `..` traversal are rejected fail-closed before
 * any bytes move. Sandbox paths on the server are POSIX.
 */
export function assertConfinedSandboxPath(remoteDir: string, candidate: string, label: string): void {
  const normalizedRoot = path.posix.normalize(remoteDir);
  const normalized = path.posix.normalize(candidate);
  if (
    !path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    throw new Error(`Daytona sync ${label} path is not a confined absolute path: ${candidate}`);
  }
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  if (normalized !== normalizedRoot && !normalized.startsWith(prefix)) {
    throw new Error(`Daytona sync ${label} path escapes the workspace remote dir: ${candidate}`);
  }
}

async function withHostTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-daytona-sync-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Build a host-side tarball of a directory, mirroring the runtime's own
 * `createTarballFromDirectory`: archive top-level entries by name (no "." self
 * entry), suppress AppleDouble/xattr sidecars, honor `exclude`, and reproduce the
 * `followSymlinks` → `-h` mapping so the native path is observationally identical
 * to the base64 fallback's tar.
 */
async function createHostTarball(input: {
  localDir: string;
  archivePath: string;
  exclude?: string[];
  followSymlinks?: boolean;
}): Promise<void> {
  const excludeArgs = ["._*", ...(input.exclude ?? [])].flatMap((entry) => ["--exclude", entry]);
  const entries = (await fs.readdir(input.localDir)).sort((left, right) => left.localeCompare(right));
  if (entries.length === 0) {
    // An empty source is valid (blank workspace / empty asset dir). Write a valid
    // empty tar (1024-byte zero EOF marker) so extraction is a clean no-op.
    await fs.writeFile(input.archivePath, Buffer.alloc(1024));
    return;
  }
  await execFileAsync(
    "tar",
    [
      "-c",
      "--no-xattrs",
      ...(input.followSymlinks ? ["-h"] : []),
      "-f",
      input.archivePath,
      "-C",
      input.localDir,
      ...excludeArgs,
      "--",
      ...entries,
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, maxBuffer: 32 * 1024 * 1024 },
  );
}

/**
 * True when `relative` (a POSIX path) escapes its anchoring directory once
 * normalized: an absolute path, `..`, or a `..`-leading traversal all break out.
 */
function posixPathEscapes(relative: string): boolean {
  const normalized = path.posix.normalize(relative);
  return normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized);
}

/**
 * Reject a sandbox-authored tarball before extraction if any member would land
 * outside the extraction dir. The archive is produced by the (untrusted) sandbox,
 * so `tar -xf` on the host must never be handed an archive whose entries carry
 * absolute paths or `../` traversal, nor a symlink/hardlink member whose target
 * escapes the tree — the latter would let a follow-up member be written through
 * the link to an arbitrary host path. Legitimate in-tree relative links (targets
 * that resolve back inside the archive, e.g. `shortcut -> nested/data.txt`) are
 * preserved. Parses the `-tvf` verbose listing so both member names and link
 * targets are inspected; any unparseable line fails closed.
 */
async function assertTarballEntriesConfined(archivePath: string): Promise<void> {
  const { stdout } = await execFileAsync("tar", ["-tvf", archivePath], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  for (const line of lines) {
    // GNU tar -tvf: "<perms> <owner>/<group> <size> <date> <time> <name>[ -> target]".
    const match = line.match(/^(\S+)\s+\S+\s+\d+\s+\S+\s+\S+\s+(.*)$/);
    if (!match) {
      throw new Error(`Daytona syncOut refusing tarball with an unparseable entry listing: ${line}`);
    }
    const typeFlag = match[1][0];
    let name = match[2];
    let linkTarget: string | null = null;
    if (typeFlag === "l") {
      const idx = name.indexOf(" -> ");
      if (idx === -1) throw new Error(`Daytona syncOut refusing unparseable symlink entry: ${line}`);
      linkTarget = name.slice(idx + " -> ".length);
      name = name.slice(0, idx);
    } else if (typeFlag === "h") {
      const idx = name.indexOf(" link to ");
      if (idx === -1) throw new Error(`Daytona syncOut refusing unparseable hardlink entry: ${line}`);
      linkTarget = name.slice(idx + " link to ".length);
      name = name.slice(0, idx);
    }
    const cleanName = name.replace(/\/+$/, "");
    if (cleanName.length > 0 && posixPathEscapes(cleanName)) {
      throw new Error(`Daytona syncOut refusing tarball member that escapes the extraction dir: ${name}`);
    }
    if (linkTarget !== null) {
      const resolved = path.posix.join(path.posix.dirname(cleanName), linkTarget);
      if (path.posix.isAbsolute(linkTarget) || posixPathEscapes(resolved)) {
        throw new Error(
          `Daytona syncOut refusing tarball link whose target escapes the extraction dir: ${name} -> ${linkTarget}`,
        );
      }
    }
  }
}

async function extractHostTarball(input: { archivePath: string; localDir: string }): Promise<void> {
  // The archive is sandbox-authored and untrusted: validate every member (and
  // link target) is confined before letting host-side tar write a single byte.
  await assertTarballEntriesConfined(input.archivePath);
  await fs.mkdir(input.localDir, { recursive: true });
  await execFileAsync("tar", ["-xf", input.archivePath, "-C", input.localDir], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function countHostFiles(root: string, exclude?: string[]): Promise<number> {
  const excludeSet = new Set(exclude ?? []);
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (excludeSet.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        total += 1;
      }
    }
  };
  await walk(root).catch(() => undefined);
  return total;
}

async function assertSandboxCommandOk(
  sandbox: Sandbox,
  command: string,
  timeoutSeconds: number,
  label: string,
): Promise<void> {
  const result = await sandbox.process.executeCommand(command, undefined, undefined, timeoutSeconds);
  if ((result.exitCode ?? 1) !== 0) {
    const detail = (result.result ?? result.artifacts?.stdout ?? "").toString().trim();
    throw new Error(`Daytona ${label} command failed (exit ${result.exitCode ?? "unknown"})${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * POSIX-sh preamble defining a `_pc_resolve` canonicalizer (prefer `realpath`,
 * fall back to `readlink -f`; fail closed with exit 40 if neither exists so the
 * host-side lexical check is never the only line of defense) and `_pc_root` =
 * the resolved workspace remote dir. Shared by every sandbox-side symlink-escape
 * guard. The caller wraps the assembled script in `sh -c` so it runs under a
 * POSIX shell regardless of the sandbox's default login shell.
 */
function canonicalizerPreamble(quotedRoot: string): string[] {
  return [
    'if command -v realpath >/dev/null 2>&1; then _pc_resolve() { realpath -- "$1"; };',
    'elif command -v readlink >/dev/null 2>&1; then _pc_resolve() { readlink -f -- "$1"; };',
    'else echo "no path canonicalizer available"; exit 40; fi;',
    `_pc_root=$(_pc_resolve ${quotedRoot}) || { echo "cannot resolve root"; exit 41; };`,
  ];
}

/**
 * Fail-closed guard: assert that every supplied sandbox path canonicalizes
 * (through symlinks) inside the workspace remote dir. The sandbox is untrusted
 * relative to the host, so a sandbox-planted symlink on an inbound target parent
 * or an outbound source must never widen a transfer past the confinement root.
 * Runs as a single batched `sh -c` precheck: any path whose realpath escapes
 * fails the whole sync (exit 42) before any bytes move. `label` distinguishes
 * the inbound vs outbound call site in the surfaced error.
 */
async function assertSandboxPathsConfined(input: {
  sandbox: Sandbox;
  remoteDir: string;
  paths: string[];
  timeoutSeconds: number;
  label: string;
}): Promise<void> {
  const { sandbox, remoteDir, paths, timeoutSeconds, label } = input;
  if (paths.length === 0) return;
  const quotedPaths = paths.map(shellQuote).join(" ");
  const script = [
    ...canonicalizerPreamble(shellQuote(remoteDir)),
    `for _pc_p in ${quotedPaths}; do`,
    '  _pc_real=$(_pc_resolve "$_pc_p") || { echo "ESCAPE:$_pc_p"; exit 42; };',
    '  case "$_pc_real/" in "$_pc_root"/*) : ;; *) echo "ESCAPE:$_pc_p"; exit 42 ;; esac;',
    "done",
  ].join("\n");
  await assertSandboxCommandOk(sandbox, `sh -c ${shellQuote(script)}`, timeoutSeconds, label);
}

/**
 * Validate every outbound source AND capture a protected snapshot of it in one
 * atomic sandbox-side step, then hand the snapshot paths to `downloadFiles`. This
 * closes the TOCTOU window between validation and download: the guard resolves
 * each source's realpath, confirms it is inside the remote dir, and `cp`s those
 * exact bytes to a reserved temp inside the root — all in a single `sh -c`
 * invocation. Even if the sandbox repoints the original path to a symlink after
 * the check, the host reads the immutable snapshot, never the mutable source.
 * Returns the reserved snapshot paths, index-aligned with `sources`; the caller
 * downloads and then removes them.
 */
async function snapshotOutboundFileSources(input: {
  sandbox: Sandbox;
  remoteDir: string;
  sources: string[];
  timeoutSeconds: number;
}): Promise<string[]> {
  const { sandbox, remoteDir, sources, timeoutSeconds } = input;
  const snapshots = sources.map(() => path.posix.join(remoteDir, scratchName()));
  if (sources.length === 0) return snapshots;
  const lines = [...canonicalizerPreamble(shellQuote(remoteDir))];
  sources.forEach((source, index) => {
    const quotedSource = shellQuote(source);
    const quotedSnapshot = shellQuote(snapshots[index]);
    lines.push(
      `_pc_real=$(_pc_resolve ${quotedSource}) || { echo "ESCAPE"; exit 42; };`,
      `case "$_pc_real/" in "$_pc_root"/*) : ;; *) echo "ESCAPE"; exit 42 ;; esac;`,
      // Copy the resolved bytes (already confined) into the reserved snapshot so
      // the subsequent download reads an immutable file, not the live source.
      `cp -- "$_pc_real" ${quotedSnapshot} || { echo "snapshot copy failed"; exit 43; };`,
    );
  });
  await assertSandboxCommandOk(
    sandbox,
    `sh -c ${shellQuote(lines.join("\n"))}`,
    timeoutSeconds,
    "outbound symlink-escape guard",
  );
  return snapshots;
}

/**
 * Best-effort removal of reserved sandbox-side scratch files (upload/download
 * snapshots or partially promoted temps) on both the happy path and error paths,
 * so a failed transfer never accumulates `.paperclip-upload-*` scratch in the
 * sandbox. Swallows its own failure — cleanup must never mask the original error.
 */
async function removeSandboxScratch(
  sandbox: Sandbox,
  paths: string[],
  timeoutSeconds: number,
): Promise<void> {
  if (paths.length === 0) return;
  const script = paths.map((entry) => `rm -f ${shellQuote(entry)}`).join(" ; ");
  await sandbox.process
    .executeCommand(`sh -c ${shellQuote(script)}`, undefined, undefined, timeoutSeconds)
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Inbound (host → sandbox)
// ---------------------------------------------------------------------------

async function syncInFileMappings(input: {
  sandbox: Sandbox;
  mappings: PluginSyncFileMapping[];
  remoteDir: string;
  timeoutSeconds: number;
}): Promise<{ filesTransferred: number; bytesTransferred: number }> {
  const { sandbox, mappings, remoteDir, timeoutSeconds } = input;
  if (mappings.length === 0) return { filesTransferred: 0, bytesTransferred: 0 };

  const uploads: FileUpload[] = [];
  const renames: { temp: string; target: string }[] = [];
  const modeApplies: { temp: string; mode: number }[] = [];
  const parentDirs = new Set<string>();
  let bytesTransferred = 0;

  for (const mapping of mappings) {
    assertConfinedSandboxPath(remoteDir, mapping.targetPath, "target");
    const dir = path.posix.dirname(mapping.targetPath);
    parentDirs.add(dir);
    // Stage each file to a reserved temp SIBLING of its target (same directory =
    // same filesystem) so the closing `mv -f` is an atomic rename and an
    // interrupted upload never leaves a truncated file at targetPath.
    const temp = path.posix.join(dir, scratchName());
    // A string `source` streams from the local path via the SDK's read stream
    // (batched, flat per-file memory) rather than buffering the whole file.
    uploads.push({ source: mapping.sourcePath, destination: temp });
    renames.push({ temp, target: mapping.targetPath });
    if (typeof mapping.mode === "number") {
      modeApplies.push({ temp, mode: mapping.mode });
    }
    bytesTransferred += (await fs.stat(mapping.sourcePath)).size;
  }

  // Ensure every target directory exists before the bulk upload writes its temp.
  const mkdirCommand = [...parentDirs].map((dir) => `mkdir -p ${shellQuote(dir)}`).join(" && ");
  await assertSandboxCommandOk(sandbox, mkdirCommand, timeoutSeconds, "syncIn mkdir");

  // Defense-in-depth beyond the lexical `assertConfinedSandboxPath`: a sandbox
  // can replace a target parent with a symlink to `/etc` so the string check
  // passes but the upload + `mv -f` resolve through it. Canonicalize every parent
  // dir (now materialized) and fail closed if any escapes, BEFORE any bytes land.
  await assertSandboxPathsConfined({
    sandbox,
    remoteDir,
    paths: [...parentDirs],
    timeoutSeconds,
    label: "inbound symlink-escape guard",
  });

  // A failed upload or a mid-batch `mv -f` failure leaves reserved temps (some
  // targets promoted, others not) — sweep every staged temp on any error so a
  // retry never accumulates stale `.paperclip-upload-*` scratch.
  try {
    // One batched bulk upload (single /files/bulk-upload) for all file mappings.
    await sandbox.fs.uploadFiles(uploads, timeoutSeconds);

    // Apply the requested mode on the temp file BEFORE the rename so the target
    // never appears at a widened window — a secret lands `0600` at targetPath from
    // the instant it exists there.
    for (const apply of modeApplies) {
      await sandbox.fs.setFilePermissions(apply.temp, { mode: toOctalModeString(apply.mode) });
    }

    // One batched rename promoting every staged temp onto its final target.
    const mvCommand = renames
      .map((rename) => `mv -f ${shellQuote(rename.temp)} ${shellQuote(rename.target)}`)
      .join(" && ");
    await assertSandboxCommandOk(sandbox, mvCommand, timeoutSeconds, "syncIn rename");
  } catch (error) {
    await removeSandboxScratch(sandbox, renames.map((rename) => rename.temp), timeoutSeconds);
    throw error;
  }

  return { filesTransferred: mappings.length, bytesTransferred };
}

async function syncInDirectoryMapping(input: {
  sandbox: Sandbox;
  mapping: PluginSyncFileMapping;
  remoteDir: string;
  timeoutSeconds: number;
}): Promise<{ filesTransferred: number; bytesTransferred: number }> {
  const { sandbox, mapping, remoteDir, timeoutSeconds } = input;
  assertConfinedSandboxPath(remoteDir, mapping.targetPath, "target");
  return withHostTempDir(async (tmp) => {
    const archivePath = path.join(tmp, "sync-in.tar");
    await createHostTarball({
      localDir: mapping.sourcePath,
      archivePath,
      exclude: mapping.exclude,
      followSymlinks: mapping.followSymlinks,
    });
    const bytesTransferred = (await fs.stat(archivePath)).size;
    // The tar bytes ride the native bulk channel (string source ⇒ streamed);
    // only the extract/cleanup control commands use exec.
    const remoteTar = path.posix.join(remoteDir, scratchName(".tar"));
    // Materialize the target dir first so the realpath guard resolves real
    // components, then confirm it (and any existing parent) canonicalizes inside
    // the remote dir — `tar -C` would otherwise follow a sandbox-planted symlink
    // and extract our archive outside the workspace root.
    await assertSandboxCommandOk(
      sandbox,
      `mkdir -p ${shellQuote(mapping.targetPath)}`,
      timeoutSeconds,
      "syncIn mkdir",
    );
    await assertSandboxPathsConfined({
      sandbox,
      remoteDir,
      paths: [mapping.targetPath],
      timeoutSeconds,
      label: "inbound symlink-escape guard",
    });
    await sandbox.fs.uploadFiles([{ source: archivePath, destination: remoteTar }], timeoutSeconds);
    const extractCommand = [
      `tar -xf ${shellQuote(remoteTar)} -C ${shellQuote(mapping.targetPath)}`,
      `rm -f ${shellQuote(remoteTar)}`,
    ].join(" && ");
    await assertSandboxCommandOk(sandbox, extractCommand, timeoutSeconds, "syncIn extract");
    const filesTransferred = await countHostFiles(mapping.sourcePath, mapping.exclude);
    return { filesTransferred, bytesTransferred };
  });
}

export async function performSyncIn(input: {
  sandbox: Sandbox;
  operations: PluginSyncOperation[];
  remoteDir: string;
  timeoutSeconds: number;
}): Promise<PluginEnvironmentSyncResult> {
  const operations: PluginEnvironmentSyncResult["operations"] = [];
  for (const operation of input.operations) {
    let filesTransferred = 0;
    let bytesTransferred = 0;

    const fileMappings = operation.files.filter((mapping) => mapping.kind === "file");
    const directoryMappings = operation.files.filter((mapping) => mapping.kind === "directory");

    const fileResult = await syncInFileMappings({
      sandbox: input.sandbox,
      mappings: fileMappings,
      remoteDir: input.remoteDir,
      timeoutSeconds: input.timeoutSeconds,
    });
    filesTransferred += fileResult.filesTransferred;
    bytesTransferred += fileResult.bytesTransferred;

    for (const mapping of directoryMappings) {
      const dirResult = await syncInDirectoryMapping({
        sandbox: input.sandbox,
        mapping,
        remoteDir: input.remoteDir,
        timeoutSeconds: input.timeoutSeconds,
      });
      filesTransferred += dirResult.filesTransferred;
      bytesTransferred += dirResult.bytesTransferred;
    }

    operations.push({ operationId: operation.operationId, filesTransferred, bytesTransferred });
  }
  return { operations };
}

// ---------------------------------------------------------------------------
// Outbound (sandbox → host)
// ---------------------------------------------------------------------------

async function syncOutFileMappings(input: {
  sandbox: Sandbox;
  mappings: PluginSyncFileMapping[];
  remoteDir: string;
  timeoutSeconds: number;
}): Promise<{ filesTransferred: number; bytesTransferred: number }> {
  const { sandbox, mappings, remoteDir, timeoutSeconds } = input;
  if (mappings.length === 0) return { filesTransferred: 0, bytesTransferred: 0 };

  for (const mapping of mappings) {
    assertConfinedSandboxPath(remoteDir, mapping.sourcePath, "source");
  }
  // Close the validation→download TOCTOU: instead of re-opening each mutable
  // source, validate-and-snapshot it in one atomic sandbox-side step and download
  // the immutable snapshot. `snapshots` is index-aligned with `mappings`.
  const snapshots = await snapshotOutboundFileSources({
    sandbox,
    remoteDir,
    sources: mappings.map((mapping) => mapping.sourcePath),
    timeoutSeconds,
  });

  const requests: FileDownloadRequest[] = [];
  const finalize: { temp: string; target: string; source: string; snapshot: string; mode?: number }[] = [];
  mappings.forEach((mapping, index) => {
    const dir = path.dirname(mapping.targetPath);
    // Stream each snapshot into a reserved host temp sibling, then atomic-rename
    // onto the host targetPath so an interrupted download never truncates it.
    const temp = path.join(dir, scratchName());
    requests.push({ source: snapshots[index], destination: temp });
    finalize.push({ temp, target: mapping.targetPath, source: mapping.sourcePath, snapshot: snapshots[index], mode: mapping.mode });
  });

  const cleanup = async (): Promise<void> => {
    await Promise.all(finalize.map((entry) => fs.rm(entry.temp, { force: true }).catch(() => undefined)));
    await removeSandboxScratch(sandbox, snapshots, timeoutSeconds);
  };

  // mkdir host target dirs up front (outside the download try) so a mkdir failure
  // still runs snapshot cleanup below.
  try {
    for (const entry of finalize) {
      await fs.mkdir(path.dirname(entry.target), { recursive: true });
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  let responses: FileDownloadResponse[];
  try {
    // One batched bulk download for all file mappings, reading the snapshots.
    responses = await sandbox.fs.downloadFiles(requests, timeoutSeconds);
  } catch (error) {
    await cleanup();
    throw error;
  }

  // Per-file failures surface in `.error`, not a thrown batch — fail loud on any.
  // Responses are keyed by the (snapshot) request source; report the original
  // sourcePath in the surfaced error for a caller-meaningful message.
  const bySource = new Map(responses.map((response) => [response.source, response]));
  for (const entry of finalize) {
    const response = bySource.get(entry.snapshot);
    if (!response || response.error) {
      await cleanup();
      throw new Error(
        `Daytona syncOut download failed for ${entry.source}: ${response?.error ?? "no response returned"}`,
      );
    }
  }

  let bytesTransferred = 0;
  try {
    for (const entry of finalize) {
      // chmod the temp before the rename so the target never appears at a widened
      // window; rename preserves the inode's mode.
      if (typeof entry.mode === "number") {
        await fs.chmod(entry.temp, entry.mode);
      }
      bytesTransferred += (await fs.stat(entry.temp)).size;
      await fs.rename(entry.temp, entry.target);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  // Success: the host temps have been renamed onto their targets; remove the
  // sandbox-side snapshots so no reserved scratch lingers.
  await removeSandboxScratch(sandbox, snapshots, timeoutSeconds);
  return { filesTransferred: mappings.length, bytesTransferred };
}

async function syncOutDirectoryMapping(input: {
  sandbox: Sandbox;
  mapping: PluginSyncFileMapping;
  remoteDir: string;
  timeoutSeconds: number;
}): Promise<{ filesTransferred: number; bytesTransferred: number }> {
  const { sandbox, mapping, remoteDir, timeoutSeconds } = input;
  assertConfinedSandboxPath(remoteDir, mapping.sourcePath, "source");
  await assertSandboxPathsConfined({
    sandbox,
    remoteDir,
    paths: [mapping.sourcePath],
    timeoutSeconds,
    label: "outbound symlink-escape guard",
  });

  return withHostTempDir(async (tmp) => {
    const remoteTar = path.posix.join(remoteDir, scratchName(".tar"));
    const excludeFlags = ["._*", ...(mapping.exclude ?? [])]
      .map((entry) => `--exclude ${shellQuote(entry)}`)
      .join(" ");
    // Tar the source in-sandbox (naming top-level entries so no "." self-entry is
    // embedded), reproducing the `followSymlinks` → `-h` mapping, then stream the
    // single archive back over the native bulk channel.
    const tarScript = [
      `cd ${shellQuote(mapping.sourcePath)}`,
      "set -- *",
      'if [ "$#" -eq 1 ] && [ "$1" = "*" ] && [ ! -e "$1" ] && [ ! -L "$1" ]; then set --; fi',
      'for entry in .[!.]* ..?*; do [ -e "$entry" ] || [ -L "$entry" ] || continue; set -- "$@" "$entry"; done',
      `if [ "$#" -eq 0 ]; then dd if=/dev/zero of=${shellQuote(remoteTar)} bs=1024 count=1; ` +
        `else tar -c --no-xattrs ${mapping.followSymlinks ? "-h " : ""}${excludeFlags} -f ${shellQuote(remoteTar)} -- "$@"; fi`,
    ].join(" && ");
    await assertSandboxCommandOk(sandbox, `sh -c ${shellQuote(tarScript)}`, timeoutSeconds, "syncOut tar");

    const localTar = path.join(tmp, "sync-out.tar");
    let bytesTransferred = 0;
    try {
      const responses = await sandbox.fs.downloadFiles(
        [{ source: remoteTar, destination: localTar }],
        timeoutSeconds,
      );
      const response = responses.find((entry) => entry.source === remoteTar) ?? responses[0];
      if (!response || response.error) {
        throw new Error(
          `Daytona syncOut directory download failed for ${mapping.sourcePath}: ${response?.error ?? "no response returned"}`,
        );
      }
      bytesTransferred = (await fs.stat(localTar)).size;
      await extractHostTarball({ archivePath: localTar, localDir: mapping.targetPath });
    } finally {
      // Best-effort remove the sandbox-side scratch tar; the host temp dir is
      // cleaned by withHostTempDir.
      await sandbox.fs
        .deleteFile(remoteTar)
        .catch(() => undefined);
    }
    const filesTransferred = await countHostFiles(mapping.targetPath, mapping.exclude);
    return { filesTransferred, bytesTransferred };
  });
}

export async function performSyncOut(input: {
  sandbox: Sandbox;
  operations: PluginSyncOperation[];
  remoteDir: string;
  timeoutSeconds: number;
}): Promise<PluginEnvironmentSyncResult> {
  const operations: PluginEnvironmentSyncResult["operations"] = [];
  for (const operation of input.operations) {
    let filesTransferred = 0;
    let bytesTransferred = 0;

    const fileMappings = operation.files.filter((mapping) => mapping.kind === "file");
    const directoryMappings = operation.files.filter((mapping) => mapping.kind === "directory");

    const fileResult = await syncOutFileMappings({
      sandbox: input.sandbox,
      mappings: fileMappings,
      remoteDir: input.remoteDir,
      timeoutSeconds: input.timeoutSeconds,
    });
    filesTransferred += fileResult.filesTransferred;
    bytesTransferred += fileResult.bytesTransferred;

    for (const mapping of directoryMappings) {
      const dirResult = await syncOutDirectoryMapping({
        sandbox: input.sandbox,
        mapping,
        remoteDir: input.remoteDir,
        timeoutSeconds: input.timeoutSeconds,
      });
      filesTransferred += dirResult.filesTransferred;
      bytesTransferred += dirResult.bytesTransferred;
    }

    operations.push({ operationId: operation.operationId, filesTransferred, bytesTransferred });
  }
  return { operations };
}
