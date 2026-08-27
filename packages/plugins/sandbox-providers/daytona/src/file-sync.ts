import path from "node:path";
import os from "node:os";
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import type { FileDownloadRequest, FileDownloadResponse, FileUpload, Sandbox } from "@daytonaio/sdk";
import type {
  PluginEnvironmentSyncResult,
  PluginPostUploadCommand,
  PluginSpan,
  PluginSyncFileMapping,
  PluginSyncOperation,
} from "@paperclipai/plugin-sdk";
import { getPluginTracer } from "./plugin.js";

const execFileAsync = promisify(execFile);

// The span-attribute names. They mirror the host span-attribute contract by
// value. The plugin ships bundled, so it stays free of the host packages and
// repeats these strings; the host re-clamps a provider span by these exact keys.
const SPAN_ATTR_PREFIX = "paperclip.sandbox.startup.";
const SPAN_ATTR = {
  provider: `${SPAN_ATTR_PREFIX}provider`,
  packWallMs: `${SPAN_ATTR_PREFIX}pack.wall_ms`,
  transferWallMs: `${SPAN_ATTR_PREFIX}transfer.wall_ms`,
  transferGuardCount: `${SPAN_ATTR_PREFIX}transfer.guard.count`,
  // The transfer direction: `inbound` for an upload to the sandbox, `outbound`
  // for a download from the sandbox. Operation identity comes from the parent
  // span, so the transfer span never carries an operation label.
  transferDirection: `${SPAN_ATTR_PREFIX}transfer.direction`,
  // The five zstd-transport-compression attributes. Values are a closed codec
  // set or a finite number — never a path, a command line, file content, a
  // raw identifier, or error text.
  transferCompressionCodec: `${SPAN_ATTR_PREFIX}transfer.compression.codec`,
  transferCompressionWallMs: `${SPAN_ATTR_PREFIX}transfer.compression.wall_ms`,
  transferCompressionBytesIn: `${SPAN_ATTR_PREFIX}transfer.compression.bytes_in`,
  transferCompressionBytesOut: `${SPAN_ATTR_PREFIX}transfer.compression.bytes_out`,
  transferDecompressWallMs: `${SPAN_ATTR_PREFIX}transfer.decompress.wall_ms`,
} as const;

/** The value of `SpanStatusCode.ERROR` in `@opentelemetry/api`. The plugin stays
 * OpenTelemetry-free, so it uses the numeric value directly. */
const SPAN_STATUS_CODE_ERROR = 2;

/**
 * Run one span-wrapped step through the plugin tracer. The pack step, the
 * transfer step, and each command round trip share this helper. It seeds the
 * provider family, runs the step, marks a thrown step failed, and always ends
 * the span. The host records the span with its true wall-clock width from the
 * worker timestamps, so the span shows real time in the trace. The tracer is a
 * no-op until the host injects a live tracer, so the span never changes the sync
 * control flow.
 *
 * `wallMsAttr` is optional. The `pack` and `transfer` spans pass it to keep
 * their existing `*.wall_ms` attribute. A per-round-trip span omits it, so it
 * carries no `*.wall_ms` attribute and relies on the native span width.
 *
 * `run` receives the live span, so a caller that needs to record an attribute
 * only known after the step completes (for example the compression byte
 * counts) can call `span.setAttribute` directly, without a second span.
 */
export async function withProviderSpan<T>(input: {
  name: string;
  wallMsAttr?: string;
  attributes?: Record<string, string | number | boolean>;
  run: (span: PluginSpan) => Promise<T>;
}): Promise<T> {
  const span = getPluginTracer().startSpan(input.name, {
    attributes: { [SPAN_ATTR.provider]: "daytona", ...(input.attributes ?? {}) },
  });
  const startedAtMs = Date.now();
  try {
    return await input.run(span);
  } catch (error) {
    span.setStatus({ code: SPAN_STATUS_CODE_ERROR });
    throw error;
  } finally {
    if (input.wallMsAttr) span.setAttribute(input.wallMsAttr, Date.now() - startedAtMs);
    span.end();
  }
}

/** Convert a millisecond timeout to the whole-seconds value the Daytona SDK expects. */
function toTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

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
 * Parse one `tar -tvf` verbose listing line into its leading type flag and the
 * trailing name-and-link-target field. The listing dialect depends on which tar
 * the host ships: GNU/busybox emit
 * `<perms> <owner>/<group> <size> <date> <time> <rest>`, while bsdtar
 * (libarchive — the system tar on macOS) emits the ls-style
 * `<perms> <links> <user> <group> <size> <Mon> <day> <time|year> <rest>`.
 * The second field disambiguates: GNU always slash-joins owner/group, bsdtar
 * puts a pure-digit link count there, so no line satisfies both shapes — the
 * slash requirement is load-bearing, since a bsdtar line with numeric uid/gid
 * would otherwise match the GNU shape shifted, hiding traversal in `<rest>`.
 * Entries whose size column is not a plain byte count (e.g. a device node's
 * `major,minor`) match neither shape. Returns null when nothing matches so
 * callers can fail closed.
 */
export function parseTarVerboseListingLine(line: string): { typeFlag: string; rest: string } | null {
  const gnu = line.match(/^(\S+)\s+\S+\/\S+\s+\d+\s+\S+\s+\S+\s+(.*)$/);
  if (gnu) return { typeFlag: gnu[1][0], rest: gnu[2] };
  const bsd = line.match(/^(\S+)\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2}(?::\d{2})?)\s+(.*)$/);
  if (bsd) return { typeFlag: bsd[1][0], rest: bsd[2] };
  return null;
}

/**
 * Split a verbose-listing link field (`<name><delimiter><target>`) exactly
 * once. The sandbox controls both halves, so a field with zero or multiple
 * delimiter occurrences is unresolvable: a link name that itself contains the
 * delimiter shifts the split point, and taking the first (or last) occurrence
 * would let a crafted name or target hide an escaping link target from the
 * confinement check. Returns null so callers fail closed.
 */
export function splitLinkEntryOnce(field: string, delimiter: string): { name: string; target: string } | null {
  const first = field.indexOf(delimiter);
  if (first === -1) return null;
  if (field.indexOf(delimiter, first + delimiter.length) !== -1) return null;
  return { name: field.slice(0, first), target: field.slice(first + delimiter.length) };
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
    const parsed = parseTarVerboseListingLine(line);
    if (!parsed) {
      throw new Error(`Daytona syncOut refusing tarball with an unparseable entry listing: ${line}`);
    }
    const typeFlag = parsed.typeFlag;
    let name = parsed.rest;
    let linkTarget: string | null = null;
    if (typeFlag === "l") {
      const split = splitLinkEntryOnce(name, " -> ");
      if (!split) throw new Error(`Daytona syncOut refusing unparseable or ambiguous symlink entry: ${line}`);
      name = split.name;
      linkTarget = split.target;
    } else if (typeFlag === "h") {
      const split = splitLinkEntryOnce(name, " link to ");
      if (!split) throw new Error(`Daytona syncOut refusing unparseable or ambiguous hardlink entry: ${line}`);
      name = split.name;
      linkTarget = split.target;
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

/**
 * Run one sandbox command and return its stdout on success. Throws the same
 * shaped error as {@link assertSandboxCommandOk} on a non-zero exit. Used by
 * the mkdir+zstd-probe round trip, which must read the probe's answer from
 * the command's own output rather than only checking the exit code.
 */
async function assertSandboxCommandOkWithOutput(
  sandbox: Sandbox,
  command: string,
  timeoutSeconds: number,
  label: string,
): Promise<string> {
  const result = await sandbox.process.executeCommand(command, undefined, undefined, timeoutSeconds);
  if ((result.exitCode ?? 1) !== 0) {
    const detail = (result.result ?? result.artifacts?.stdout ?? "").toString().trim();
    throw new Error(`Daytona ${label} command failed (exit ${result.exitCode ?? "unknown"})${detail ? `: ${detail}` : ""}`);
  }
  return (result.result ?? result.artifacts?.stdout ?? "").toString();
}

async function assertSandboxCommandOk(
  sandbox: Sandbox,
  command: string,
  timeoutSeconds: number,
  label: string,
): Promise<void> {
  await assertSandboxCommandOkWithOutput(sandbox, command, timeoutSeconds, label);
}

// -------------------------------------------------------------
// zstd transport compression (inbound file-mapping path only)
// -------------------------------------------------------------

/** A source file below this size never compresses: the round-trip and CPU
 * cost of compression is not worth it for a small file. */
const ZSTD_MIN_SOURCE_BYTES = 8 * 1024 * 1024;

/** Reject a compressed candidate whose saving is below this fraction of the
 * source size (a saving under 10 percent falls back to the raw path). */
const ZSTD_MIN_SAVING_RATIO = 0.1;

/** The zstd compression level for the host-side compressor. */
const ZSTD_COMPRESSION_LEVEL = 3;

/** Marker the mkdir+probe command echoes to sandbox stdout when the sandbox
 * has a `zstd` binary on `PATH`. An absent or unexpected answer fails closed
 * (no compression), per the design's fallback rules. */
const ZSTD_PROBE_MARKER = "PAPERCLIP_ZSTD_AVAILABLE";

/**
 * Feature-detect zstd support on the running Node runtime. `node:zlib` shipped
 * zstd as of Node v22.15.0 / v23.8.0, ahead of this package's declared
 * `engines.node` floor, but the design directs a runtime check rather than an
 * assumption from the `engines` field alone: a floor can be wrong, and this
 * check costs nothing to keep in place after the floor moves.
 */
function isZstdCompressionSupported(): boolean {
  return typeof zlib.createZstdCompress === "function";
}

/**
 * Stream-compress `sourcePath` to a new file with zstd at
 * {@link ZSTD_COMPRESSION_LEVEL}, never buffering the whole file in memory.
 * The compressed file lives in a private directory this function creates with
 * `fs.mkdtemp` (mode `0700`), and the file itself opens with `wx` and mode
 * `0600` — so the workspace content this holds is never readable by another
 * local principal, unlike a bare `os.tmpdir()` file at the default `0644`.
 * The caller removes the returned directory (on the accept path, after the
 * upload; on every reject/error path, immediately) — this function only
 * removes it on its OWN failure, so a caller never has to distinguish a
 * partial directory from a finished one. The cleanup scope covers every
 * step after the directory create, including the post-compression size
 * stat, so a throw there does not leave the directory behind.
 */
async function compressFileToHostTemp(sourcePath: string): Promise<{ dir: string; path: string; bytesOut: number }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-daytona-zstd-"));
  const tempPath = path.join(dir, "artifact.zst");
  try {
    await pipeline(
      createReadStream(sourcePath),
      zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_COMPRESSION_LEVEL } }),
      createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
    );
    const bytesOut = (await fs.stat(tempPath)).size;
    return { dir, path: tempPath, bytesOut };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
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
 * shrinks the TOCTOU window between validation and download to near zero: the
 * guard resolves each source's realpath, confirms it is inside the remote dir,
 * re-checks the resolved path is still a (non-symlink) regular file, then `cp`s
 * those exact bytes to a reserved snapshot — all in a single `sh -c` invocation.
 *
 * Two windows are closed here:
 *  - validation→copy: `_pc_real` is a canonical path, so a `[ -L ]`/`[ -f ]`
 *    re-check immediately before `cp` refuses a source the sandbox swapped for a
 *    symlink (or non-regular file) after `realpath` resolved, rather than letting
 *    `cp` follow the swap.
 *  - copy→download: the privileged `downloadFiles` reads the reserved snapshot,
 *    which is an unguessable random name that is a DIRECT child of the resolved
 *    workspace root — no sandbox-swappable intermediate directory sits on the
 *    read path, and the sandbox cannot pre-plant a symlink at the leaf name.
 *
 * The sandbox-side `cp` runs at sandbox-user privilege, so its residual race
 * cannot read anything that user could not already read; the confinement is
 * defense-in-depth for the privileged host-mediated download. Returns the
 * reserved snapshot paths, index-aligned with `sources`; the caller downloads
 * and then removes them.
 *
 * Accepted residual risk (copy→download leaf swap): the sandbox user runs this
 * `cp`, so it knows the reserved snapshot path and could overwrite that leaf with
 * different bytes after `cp` returns but before the privileged `downloadFiles`
 * opens it. This is informational, not a privilege-boundary crossing: the sandbox
 * user can only substitute bytes it can already produce, and the host download
 * would then receive bytes that same user could equally have written into the real
 * source before the snapshot ran. The swap cannot redirect the read outside the
 * confinement root — the leaf is a direct child of the resolved root with no
 * swappable intermediate dir, and the sandbox user cannot use it to exfiltrate any
 * file it lacks read access to — so no privilege escalation is possible and the
 * window is accepted rather than closed.
 */
async function snapshotOutboundFileSources(input: {
  sandbox: Sandbox;
  remoteDir: string;
  sources: string[];
  timeoutSeconds: number;
}): Promise<string[]> {
  const { sandbox, remoteDir, sources, timeoutSeconds } = input;
  // Reserved snapshot names are a DIRECT child of remoteDir (the confinement
  // root), so the privileged download leg carries no swappable intermediate dir.
  const snapshots = sources.map(() => path.posix.join(remoteDir, scratchName()));
  if (sources.length === 0) return snapshots;
  const lines = [...canonicalizerPreamble(shellQuote(remoteDir))];
  sources.forEach((source, index) => {
    const quotedSource = shellQuote(source);
    const quotedSnapshot = shellQuote(snapshots[index]);
    lines.push(
      `_pc_real=$(_pc_resolve ${quotedSource}) || { echo "ESCAPE"; exit 42; };`,
      `case "$_pc_real/" in "$_pc_root"/*) : ;; *) echo "ESCAPE"; exit 42 ;; esac;`,
      // Close the validation→copy window: refuse a canonical path the sandbox has
      // repointed to a symlink or a non-regular file since `realpath` resolved,
      // so `cp` never follows a post-validation swap.
      `[ -L "$_pc_real" ] && { echo "REPLACED"; exit 44; };`,
      `[ -f "$_pc_real" ] || { echo "NOTREG"; exit 45; };`,
      // Copy the confined canonical bytes into the reserved snapshot so the
      // subsequent download reads this immutable copy, not the live source.
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

/**
 * Try to remove each `.zst` scratch name a SECOND time, after every target in
 * the batch already promoted successfully.
 *
 * The promote script's own cleanup (`rm -f ... || true`) already  tried once.
 * It never fails the sync when that cleanup fails, because a completed and
 * safely promoted target must never read back as a failure.
 * 
 * This function does not touch the promote script or its fail-closed guards.
 * It runs one separate, later sandbox command that retries the removal, then
 * reports how many names are still present. This makes a leftover that
 * survives both tries observable instead of silent.
 *
 * This function runs exactly once. It is not a retry loop. It swallows its
 * own command failure and reports the full count as still present — the
 * same "assume the worst, never throw" contract as
 * {@link removeSandboxScratch}.
 */
async function sweepZstdScratchAfterSuccess(
  sandbox: Sandbox,
  zstdScratchNames: string[],
  timeoutSeconds: number,
): Promise<number> {
  if (zstdScratchNames.length === 0) return 0;
  const removeScript = zstdScratchNames.map((name) => `rm -f ${shellQuote(name)}`).join(" ; ");
  const checkScript = zstdScratchNames.map((name) => `[ -e ${shellQuote(name)} ] && echo 1 || echo 0`).join(" ; ");
  const result = await sandbox.process
    .executeCommand(`sh -c ${shellQuote(`${removeScript} ; ${checkScript}`)}`, undefined, undefined, timeoutSeconds)
    .catch(() => null);
  if (!result) return zstdScratchNames.length;
  const output = (result.result ?? result.artifacts?.stdout ?? "").toString();
  return output.split("\n").filter((line) => line.trim() === "1").length;
}

// ---------------------------------------------------------------------------
// Inbound (host → sandbox)
// ---------------------------------------------------------------------------

/**
 * One file mapping's transfer plan. `compressed` is null until the host
 * compression step (below) accepts this mapping onto the compressed path;
 * it stays null — and the mapping stays on the byte-identical raw path — for
 * every fallback case (no probe, no host zstd support, too small, compression
 * threw, or the saving ratio missed the bar).
 */
interface FileMappingPlan {
  mapping: PluginSyncFileMapping;
  sourceSize: number;
  dir: string;
  /** Reserved scratch name for the FINAL bytes at `targetPath`, a direct child
   * of `remoteDir`. For a raw mapping the host uploads directly to this name.
   * For a compressed mapping the host never creates this name — the in-sandbox
   * decompression step does (Security Condition C1). */
  rawScratch: string;
  compressed: null | {
    /** Reserved `.zst` scratch name, a direct child of `remoteDir`. */
    zstdScratch: string;
    /** Private `0700` host temp directory holding the compressed file, removed
     * (recursively) after upload. */
    hostTempDir: string;
    /** Host temp file (`0600`, inside `hostTempDir`) holding the compressed bytes. */
    hostTempPath: string;
  };
}

async function syncInFileMappings(input: {
  sandbox: Sandbox;
  mappings: PluginSyncFileMapping[];
  remoteDir: string;
  timeoutSeconds: number;
}): Promise<{ filesTransferred: number; bytesTransferred: number }> {
  const { sandbox, mappings, remoteDir, timeoutSeconds } = input;
  if (mappings.length === 0) return { filesTransferred: 0, bytesTransferred: 0 };

  const parentDirs = new Set<string>();
  let bytesTransferred = 0;
  const plans: FileMappingPlan[] = [];
  for (const mapping of mappings) {
    assertConfinedSandboxPath(remoteDir, mapping.targetPath, "target");
    const dir = path.posix.dirname(mapping.targetPath);
    parentDirs.add(dir);
    const sourceSize = (await fs.stat(mapping.sourcePath)).size;
    bytesTransferred += sourceSize;
    // Stage each upload to a reserved temp that is a DIRECT child of the workspace
    // root (`remoteDir`), never a sibling of the target. The target's parent dir is
    // sandbox-writable and can be swapped for a symlink to `/etc` (or any host path)
    // after validation but before the write opens the destination — rooting the
    // privileged write directly under `remoteDir` removes that swappable intermediate
    // component, so the upload cannot be redirected outside the root by a parent
    // swap. `remoteDir` and the target dir share the workspace filesystem, so the
    // closing `mv -f` is still an atomic same-fs rename and an interrupted upload
    // never leaves a truncated file at targetPath.
    plans.push({ mapping, sourceSize, dir, rawScratch: path.posix.join(remoteDir, scratchName()), compressed: null });
  }

  // Count the serial guard round trips before the transfer, so the transfer span
  // records how much of the wall time is guard cost.
  let guardRoundTrips = 0;

  // Ensure every target directory exists before the bulk upload writes its temp.
  // The zstd availability probe rides this SAME round trip: no new sandbox round
  // trip and no availability cache — a cache at any scope would hold one
  // principal's observation and reuse it for another, so probing fresh on every
  // call has no poisoning surface. `command -v zstd` runs only after a successful
  // `mkdir -p`, and always reports success itself (`|| true`), so a sandbox with no
  // `zstd` binary never fails the mkdir step — it only fails closed on compression
  // eligibility below.
  const mkdirCommand = [...parentDirs].map((dir) => `mkdir -p ${shellQuote(dir)}`).join(" && ");
  const mkdirAndProbeCommand = [
    mkdirCommand,
    `&& { command -v zstd >/dev/null 2>&1 && echo ${ZSTD_PROBE_MARKER} || true; }`,
  ].join(" ");
  // `ensureDirectory` span: `mkdir -p` (plus the zstd availability probe) —
  // ensure a directory exists before a write.
  const mkdirOutput = await withProviderSpan({
    name: "ensureDirectory",
    run: () => assertSandboxCommandOkWithOutput(sandbox, mkdirAndProbeCommand, timeoutSeconds, "syncIn mkdir"),
  });
  guardRoundTrips += 1;
  // An absent or unexpected probe answer fails closed: no compression, byte-
  // identical to a sandbox that has no `zstd` binary.
  const sandboxHasZstd = mkdirOutput.includes(ZSTD_PROBE_MARKER);

  // Defense-in-depth beyond the lexical `assertConfinedSandboxPath`: a sandbox
  // can replace a target parent with a symlink to `/etc` so the string check
  // passes but the upload + `mv -f` resolve through it. Canonicalize every parent
  // dir (now materialized) and fail closed if any escapes, BEFORE any bytes land.
  // `checkSymlinkEscape` span: re-check a path resolves inside the workspace root
  // before use.
  await withProviderSpan({
    name: "checkSymlinkEscape",
    run: () =>
      assertSandboxPathsConfined({
        sandbox,
        remoteDir,
        paths: [...parentDirs],
        timeoutSeconds,
        label: "inbound symlink-escape guard",
      }),
  });
  guardRoundTrips += 1;

  // Host-side compression, gated on the probe AND a runtime feature check (a
  // declared `engines.node` floor is an assumption, not a guarantee — always
  // feature-detect). Every candidate at or above `ZSTD_MIN_SOURCE_BYTES` is
  // compressed on the host with `node:zlib` at level 3, streamed so the whole
  // file never buffers in memory. A candidate that throws, or whose saving
  // misses `ZSTD_MIN_SAVING_RATIO`, falls back to the raw path — a fallback is
  // never an error, it reproduces the present behavior exactly.
  const compressCandidates = plans.filter((plan) => plan.sourceSize >= ZSTD_MIN_SOURCE_BYTES);
  if (sandboxHasZstd && isZstdCompressionSupported() && compressCandidates.length > 0) {
    let compressBytesIn = 0;
    let compressBytesOut = 0;
    await withProviderSpan({
      name: "compress",
      wallMsAttr: SPAN_ATTR.transferCompressionWallMs,
      attributes: { [SPAN_ATTR.transferCompressionCodec]: "zstd" },
      run: async (span: PluginSpan) => {
        for (const plan of compressCandidates) {
          let hostTempDir: string | null = null;
          try {
            const compressed = await compressFileToHostTemp(plan.mapping.sourcePath);
            hostTempDir = compressed.dir;
            compressBytesIn += plan.sourceSize;
            compressBytesOut += compressed.bytesOut;
            const savingRatio = 1 - compressed.bytesOut / plan.sourceSize;
            if (savingRatio < ZSTD_MIN_SAVING_RATIO) {
              await fs.rm(compressed.dir, { recursive: true, force: true }).catch(() => undefined);
              continue;
            }
            plan.compressed = {
              zstdScratch: path.posix.join(remoteDir, scratchName(".zst")),
              hostTempDir: compressed.dir,
              hostTempPath: compressed.path,
            };
          } catch {
            // Host compression failed for this candidate — fall back to the raw
            // path for it. Never fail the whole sync over a compression error.
            if (hostTempDir) await fs.rm(hostTempDir, { recursive: true, force: true }).catch(() => undefined);
          }
        }
        span.setAttribute(SPAN_ATTR.transferCompressionBytesIn, compressBytesIn);
        span.setAttribute(SPAN_ATTR.transferCompressionBytesOut, compressBytesOut);
      },
    });
  }

  const uploads: FileUpload[] = [];
  const modeApplies: { temp: string; mode: number }[] = [];
  for (const plan of plans) {
    if (plan.compressed) {
      // Upload ONLY the `.zst` file. The host never creates the raw scratch
      // name — the in-sandbox decompression step below does (C1).
      uploads.push({ source: plan.compressed.hostTempPath, destination: plan.compressed.zstdScratch });
    } else {
      uploads.push({ source: plan.mapping.sourcePath, destination: plan.rawScratch });
      if (typeof plan.mapping.mode === "number") {
        modeApplies.push({ temp: plan.rawScratch, mode: plan.mapping.mode });
      }
    }
  }
  const hasCompressedMapping = plans.some((plan) => plan.compressed !== null);
  // Every reserved scratch name in this batch (raw + `.zst`), for the failure
  // sweep below. A compressed mapping reserves two names; a raw mapping one.
  const allScratchNames = plans.flatMap((plan) =>
    plan.compressed ? [plan.rawScratch, plan.compressed.zstdScratch] : [plan.rawScratch],
  );
  const compressedPlans = plans.filter(
    (plan): plan is FileMappingPlan & { compressed: NonNullable<FileMappingPlan["compressed"]> } =>
      plan.compressed !== null,
  );
  const hostTempDirs = compressedPlans.map((plan) => plan.compressed.hostTempDir);
  // The `.zst` scratch names for compressed mappings. The bounded post-success
  // sweep below uses this list. It excludes the raw scratch names, because the
  // promote script's own rename already consumes them.
  const compressedZstdScratchNames = compressedPlans.map((plan) => plan.compressed.zstdScratch);

  // A failed upload or a mid-batch `mv -f`/decompress failure leaves reserved
  // scratch (some targets promoted, others not) — sweep every reserved name on
  // any error so a retry never accumulates stale `.paperclip-upload-*` scratch.
  // The private host temp directory is removed in `finally` regardless of
  // outcome (C2's "no temp remains after success or failure" applies host-side
  // too).
  try {
    // One batched bulk upload (single /files/bulk-upload) for all file mappings.
    // `transfer` span: the real byte upload — `sandbox.fs.uploadFiles`.
    await withProviderSpan({
      name: "transfer",
      wallMsAttr: SPAN_ATTR.transferWallMs,
      attributes: {
        [SPAN_ATTR.transferGuardCount]: guardRoundTrips,
        [SPAN_ATTR.transferDirection]: "inbound",
      },
      run: () => sandbox.fs.uploadFiles(uploads, timeoutSeconds),
    });

    // Apply the requested mode on the RAW mapping's temp file BEFORE the rename
    // so the target never appears at a widened window. A compressed mapping's
    // raw scratch does not exist yet at this point — its mode (if any) is
    // applied inside the promotion script below, on the safe raw scratch (C3).
    for (const apply of modeApplies) {
      await sandbox.fs.setFilePermissions(apply.temp, { mode: toOctalModeString(apply.mode) });
    }

    // Promote every mapping onto its final target. The `mv -f` traverses the
    // target's PARENT dir, which is sandbox-writable and could be swapped for a
    // symlink after the earlier parent guard ran but before the rename opens it —
    // redirecting the promotion outside the root. Bind the confinement re-check and
    // the rename into ONE sandbox invocation: for each target, re-canonicalize its
    // parent dir, confirm the resolved parent is still inside the workspace root,
    // then OPEN that dir as fd 8 and `mv` into `/proc/self/fd/8/<base>`. Two races
    // are closed:
    //  - check→open (ancestor swap): `mv "$_pc_tgt_dir"/<base>` would re-walk the
    //    parent path string and follow an ancestor the sandbox repointed to a
    //    symlink after the `case` check. Opening fd 8 PINS the directory inode, and
    //    an immediate re-canonicalize of `/proc/self/fd/8` confirms the pinned inode
    //    is still in-root before any write — an ancestor swap before the open is
    //    caught by this verify (fail closed, exit 42); a swap after the open cannot
    //    change which inode fd 8 references.
    //  - open→rename: `mv` targets `/proc/self/fd/8/<base>`, which resolves through
    //    the already-open inode rather than the path string, so the rename lands in
    //    the verified directory even if the path is repointed mid-command.
    //
    // A compressed mapping runs a decompression block, in the SAME `sh -c`
    // script, immediately before its own fd-pinned promote block (C1–C3):
    //  - `umask 077` + `set -C` (POSIX noclobber) scoped to a subshell, then
    //    `exec 9> rawScratch` — an atomic exclusive create: `set -C` opens
    //    with `O_CREAT|O_EXCL`, which fails on any EXISTING name, including a
    //    symlink (dangling or not), because `O_EXCL` fails on the name's own
    //    lstat and never opens through it. The tests in this package verify
    //    this for the shells and the platform under test; it is not a claim
    //    of a portable `O_NOFOLLOW` guarantee across every POSIX shell. This
    //    is the retained descriptor C1 requires — never a separate
    //    existence/symlink test.
    //  - `zstd -d -c` writes into that retained descriptor (`>&9`), so the
    //    decompressed bytes land in the pinned inode even if the pathname is
    //    fought over mid-command.
    //  - the mapping's `mode`, if set, is applied through `/proc/self/fd/9`
    //    (the still-open descriptor) — never by reopening the pathname —
    //    before the descriptor closes (C3). `umask 077` also means a mapping
    //    with NO explicit mode still never appears wider than `0600` in the
    //    window between create and the (absent) chmod.
    //  - a subshell failure at any step exits non-zero without reaching the
    //    `mv` (C2); the decompressed name is a reserved DIRECT child of
    //    `remoteDir`, matching the guarantee the raw path already has for its
    //    scratch name.
    // Only after the decompression block succeeds does the existing fd-pinned
    // promote block run — unchanged — for every mapping, compressed or raw.
    const renameScript = [...canonicalizerPreamble(shellQuote(remoteDir))];
    for (const plan of plans) {
      const parentDir = plan.dir;
      const base = path.posix.basename(plan.mapping.targetPath);
      if (plan.compressed) {
        const modeCommand =
          typeof plan.mapping.mode === "number"
            ? `chmod ${toOctalModeString(plan.mapping.mode)} /proc/self/fd/9 || { echo "chmod failed"; exit 50; };`
            : "";
        renameScript.push(
          "(",
          "umask 077;",
          "set -C;",
          `exec 9> ${shellQuote(plan.rawScratch)} || { echo "raw scratch create failed"; exit 48; };`,
          `zstd -d -c -- ${shellQuote(plan.compressed.zstdScratch)} >&9 || { echo "decompress failed"; exit 49; };`,
          modeCommand,
          "exec 9>&-;",
          ") || exit $?;",
        );
      }
      renameScript.push(
        `_pc_tgt_dir=$(_pc_resolve ${shellQuote(parentDir)}) || { echo "ESCAPE"; exit 42; };`,
        `case "$_pc_tgt_dir/" in "$_pc_root"/*) : ;; *) echo "ESCAPE"; exit 42 ;; esac;`,
        `exec 8<"$_pc_tgt_dir" || { echo "open failed"; exit 47; };`,
        `_pc_fd_dir=$(_pc_resolve /proc/self/fd/8) || { echo "ESCAPE"; exit 42; };`,
        `case "$_pc_fd_dir/" in "$_pc_root"/*) : ;; *) echo "ESCAPE"; exit 42 ;; esac;`,
        `mv -f ${shellQuote(plan.rawScratch)} /proc/self/fd/8/${shellQuote(base)} || { echo "rename failed"; exit 43; };`,
        `exec 8>&-;`,
      );
      if (plan.compressed) {
        // Clean up the `.zst` scratch after a successful promotion (C2/step 7).
        // `|| true` keeps a cleanup failure from becoming the promote script's
        // own exit status — every target file is already in place by this
        // point, so a stray `.zst` scratch must never read back as a sync
        // failure.
        renameScript.push(`rm -f ${shellQuote(plan.compressed.zstdScratch)} || true;`);
      }
    }
    // `promote` span: atomically move the staged temp onto its target via a
    // pinned dir handle. When this batch decompressed at least one mapping,
    // this span also carries `transfer.decompress.wall_ms`. That value
    // measures the WHOLE promote command — the canonicalizer preamble, every
    // decompression, and every `mv` — not decompression alone. Treat it as an
    // upper bound on the decompress wall time, not an exact measurement.
    await withProviderSpan({
      name: "promote",
      wallMsAttr: hasCompressedMapping ? SPAN_ATTR.transferDecompressWallMs : undefined,
      run: () =>
        assertSandboxCommandOk(
          sandbox,
          `sh -c ${shellQuote(renameScript.join("\n"))}`,
          timeoutSeconds,
          "syncIn rename",
        ),
    });
  } catch (error) {
    await removeSandboxScratch(sandbox, allScratchNames, timeoutSeconds);
    throw error;
  } finally {
    await Promise.all(
      hostTempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
    );
  }

  // Every target is already promoted at this point. Give the promote
  // script's own `.zst` cleanup (`|| true`) one more, separate try.
  // Log a count, never a path, when a leftover survives both tries.
  if (compressedZstdScratchNames.length > 0) {
    const leftoverCount = await sweepZstdScratchAfterSuccess(sandbox, compressedZstdScratchNames, timeoutSeconds);
    if (leftoverCount > 0) {
      console.warn(
        `Daytona zstd transport compression: ${leftoverCount} post-promotion scratch file(s) could not be removed after two attempts. The already-promoted target file(s) are unaffected.`,
      );
    }
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
    // The pack step is host-local: it builds the tarball and makes no sandbox
    // round trip. The `pack` span records its wall time.
    // `pack` span: build a tarball on the host — no sandbox round trip.
    await withProviderSpan({
      name: "pack",
      wallMsAttr: SPAN_ATTR.packWallMs,
      run: () => createHostTarball({
        localDir: mapping.sourcePath,
        archivePath,
        exclude: mapping.exclude,
        followSymlinks: mapping.followSymlinks,
      }),
    });
    const bytesTransferred = (await fs.stat(archivePath)).size;
    // The tar bytes ride the native bulk channel (string source ⇒ streamed);
    // only the extract/cleanup control commands use exec.
    const remoteTar = path.posix.join(remoteDir, scratchName(".tar"));
    // Count the serial guard round trips before the transfer, so the transfer
    // span records how much of the wall time is guard cost.
    let guardRoundTrips = 0;
    // Materialize the target dir first so the realpath guard resolves real
    // components, then confirm it (and any existing parent) canonicalizes inside
    // the remote dir — `tar -C` would otherwise follow a sandbox-planted symlink
    // and extract our archive outside the workspace root.
    // `ensureDirectory` span: `mkdir -p` — ensure a directory exists before a write.
    await withProviderSpan({
      name: "ensureDirectory",
      run: () =>
        assertSandboxCommandOk(
          sandbox,
          `mkdir -p ${shellQuote(mapping.targetPath)}`,
          timeoutSeconds,
          "syncIn mkdir",
        ),
    });
    guardRoundTrips += 1;
    // `checkSymlinkEscape` span: re-check a path resolves inside the workspace
    // root before use.
    await withProviderSpan({
      name: "checkSymlinkEscape",
      run: () =>
        assertSandboxPathsConfined({
          sandbox,
          remoteDir,
          paths: [mapping.targetPath],
          timeoutSeconds,
          label: "inbound symlink-escape guard",
        }),
    });
    guardRoundTrips += 1;
    // The uploaded scratch tar lands at the workspace root as a reserved
    // `.paperclip-upload-*` entry. The extract script below removes it only on
    // success. On an upload or extract failure the scratch tar can remain, and the
    // runtime workspace wipe preserves every `.paperclip-upload-*` entry, so a
    // stale tar would surface in the agent workspace. Sweep the scratch on any
    // failure — symmetric with the file-mapping path — so a failed sync (for
    // example a referenced-project extraction) leaves no residue.
    try {
      // `transfer` span: the real byte upload — `sandbox.fs.uploadFiles`.
      await withProviderSpan({
        name: "transfer",
        wallMsAttr: SPAN_ATTR.transferWallMs,
        attributes: {
          [SPAN_ATTR.transferGuardCount]: guardRoundTrips,
          [SPAN_ATTR.transferDirection]: "inbound",
        },
        run: () =>
          sandbox.fs.uploadFiles([{ source: archivePath, destination: remoteTar }], timeoutSeconds),
      });
      // Bind validation and extraction into ONE sandbox invocation, then extract into
      // an OPEN directory inode rather than a path string. `exec 9<"$_pc_real"` itself
      // walks every ancestor of `$_pc_real` during the `open()` syscall, so a sandbox
      // process that swaps an ancestor component for a symlink AFTER `_pc_resolve`
      // returns but BEFORE the `open()` resolves would leave fd 9 pointing at a
      // directory outside the workspace — the earlier `case` check on the resolved
      // string cannot see that. Close the gap with open-then-verify: open fd 9 (which
      // PINS whatever inode `open()` landed on), then re-canonicalize `/proc/self/fd/9`
      // — the pinned inode's own path — and confirm it is still inside `$_pc_root`
      // before extracting. If an ancestor swap redirected the open, the pinned inode
      // resolves outside the root and the verify fails closed (exit 42); once the
      // verify passes, the inode is fixed and `tar -C /proc/self/fd/9` chdir's through
      // the magic symlink to that exact inode, so a post-open ancestor swap cannot
      // redirect the write. (The initial `case` on `$_pc_real` still fails fast on a
      // pre-open escape; the fd re-verify is what makes the guarantee race-free.)
      const extractScript = [
        ...canonicalizerPreamble(shellQuote(remoteDir)),
        `_pc_real=$(_pc_resolve ${shellQuote(mapping.targetPath)}) || { echo "ESCAPE"; exit 42; };`,
        `case "$_pc_real/" in "$_pc_root"/*) : ;; *) echo "ESCAPE"; exit 42 ;; esac;`,
        `exec 9<"$_pc_real" || { echo "open failed"; exit 46; };`,
        `_pc_fd_real=$(_pc_resolve /proc/self/fd/9) || { echo "ESCAPE"; exit 42; };`,
        `case "$_pc_fd_real/" in "$_pc_root"/*) : ;; *) echo "ESCAPE"; exit 42 ;; esac;`,
        `tar -xf ${shellQuote(remoteTar)} -C /proc/self/fd/9 || { echo "extract failed"; exit 43; };`,
        `exec 9>&-;`,
        `rm -f ${shellQuote(remoteTar)};`,
      ].join("\n");
      // `extractTarball` span: one round trip — re-check the path, `tar -xf`, and
      // remove the scratch tarball.
      await withProviderSpan({
        name: "extractTarball",
        run: () =>
          assertSandboxCommandOk(
            sandbox,
            `sh -c ${shellQuote(extractScript)}`,
            timeoutSeconds,
            "syncIn extract",
          ),
      });
    } catch (error) {
      await removeSandboxScratch(sandbox, [remoteTar], timeoutSeconds);
      throw error;
    }
    const filesTransferred = await countHostFiles(mapping.sourcePath, mapping.exclude);
    return { filesTransferred, bytesTransferred };
  });
}

/**
 * Execute an operation's ordered `postUploadCommands` in-sandbox AFTER its files
 * have landed (Phase 3 / Security Conditions C1–C4). Commands run in array order,
 * fail-fast: the first non-zero exit or timeout throws and stops the rest — no
 * silent partial fallback (C4). Each `command` string is executed VERBATIM via the
 * exec seam; the provider never rewrites, concatenates, or appends a shell fragment
 * to it (C1/C3) — the working directory rides `executeCommand`'s structured `cwd`
 * argument, never a `cd &&` prefix on the command. Before exec, a present `cwd` is
 * re-validated under the workspace remote dir with the same lexical
 * ({@link assertConfinedSandboxPath}) + realpath/symlink ({@link assertSandboxPathsConfined})
 * guards used for file placement (C2): `..`, absolute-escape, and symlink-escape
 * are rejected fail-closed before any command runs. An absent `cwd` defaults to the
 * provider-resolved remote dir — never a process default cwd.
 *
 * Shared by the file- and directory-mapping paths: it runs once per operation,
 * after every mapping of that operation has been placed.
 */
async function runPostUploadCommands(input: {
  sandbox: Sandbox;
  commands: PluginPostUploadCommand[];
  remoteDir: string;
  timeoutSeconds: number;
}): Promise<void> {
  const { sandbox, commands, remoteDir, timeoutSeconds } = input;
  for (const command of commands) {
    // C2: re-confine the command cwd before exec. Absent → the remote dir (never a
    // process default cwd); the remote dir is the confinement root itself, so only
    // an explicit cwd carries untrusted input worth re-validating.
    let cwd = remoteDir;
    if (command.cwd != null) {
      assertConfinedSandboxPath(remoteDir, command.cwd, "post-upload command cwd");
      // `checkSymlinkEscape` span: re-check a path resolves inside the workspace
      // root before use.
      await withProviderSpan({
        name: "checkSymlinkEscape",
        run: () =>
          assertSandboxPathsConfined({
            sandbox,
            remoteDir,
            paths: [command.cwd as string],
            timeoutSeconds,
            label: "post-upload command cwd symlink-escape guard",
          }),
      });
      cwd = command.cwd;
    }
    // C1/C3: run the command VERBATIM with a structured cwd (no string rewrite).
    // C4: first non-zero exit or timeout throws and aborts the remaining commands.
    const commandTimeoutSeconds =
      command.timeoutMs != null ? toTimeoutSeconds(command.timeoutMs) : timeoutSeconds;
    // `postUploadCommand` span: run one caller-supplied post-upload command.
    const result = await withProviderSpan({
      name: "postUploadCommand",
      run: () =>
        sandbox.process.executeCommand(command.command, cwd, undefined, commandTimeoutSeconds),
    });
    if ((result.exitCode ?? 1) !== 0) {
      const detail = (result.result ?? result.artifacts?.stdout ?? "").toString().trim();
      throw new Error(
        `Daytona post-upload command failed (exit ${result.exitCode ?? "unknown"})${detail ? `: ${detail}` : ""}`,
      );
    }
  }
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

    // Run the operation's ordered post-upload commands AFTER every file/directory
    // mapping of this operation has landed (Phase 3 / C1–C4). Absent/empty → no
    // extra exec, byte-identical to a pre-contract operation.
    await runPostUploadCommands({
      sandbox: input.sandbox,
      commands: operation.postUploadCommands ?? [],
      remoteDir: input.remoteDir,
      timeoutSeconds: input.timeoutSeconds,
    });

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

  // Count the serial sandbox round trips before the transfer, so the transfer
  // span records how much of the wall time is guard cost. The validate-and-
  // snapshot step is one sandbox round trip. This is symmetric with the inbound
  // transfer span.
  const guardRoundTrips = 1;

  let responses: FileDownloadResponse[];
  try {
    // One batched bulk download for all file mappings, reading the snapshots.
    // `transfer` span: the real byte download — `sandbox.fs.downloadFiles`.
    responses = await withProviderSpan({
      name: "transfer",
      wallMsAttr: SPAN_ATTR.transferWallMs,
      attributes: {
        [SPAN_ATTR.transferGuardCount]: guardRoundTrips,
        [SPAN_ATTR.transferDirection]: "outbound",
      },
      run: () => sandbox.fs.downloadFiles(requests, timeoutSeconds),
    });
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
  // Count the serial sandbox round trips before the transfer, so the transfer
  // span records how much of the wall time is guard cost.
  let guardRoundTrips = 0;
  await assertSandboxPathsConfined({
    sandbox,
    remoteDir,
    paths: [mapping.sourcePath],
    timeoutSeconds,
    label: "outbound symlink-escape guard",
  });
  guardRoundTrips += 1;

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
    guardRoundTrips += 1;

    const localTar = path.join(tmp, "sync-out.tar");
    let bytesTransferred = 0;
    try {
      // `transfer` span: the real byte download — `sandbox.fs.downloadFiles`.
      const responses = await withProviderSpan({
        name: "transfer",
        wallMsAttr: SPAN_ATTR.transferWallMs,
        attributes: {
          [SPAN_ATTR.transferGuardCount]: guardRoundTrips,
          [SPAN_ATTR.transferDirection]: "outbound",
        },
        run: () =>
          sandbox.fs.downloadFiles([{ source: remoteTar, destination: localTar }], timeoutSeconds),
      });
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
