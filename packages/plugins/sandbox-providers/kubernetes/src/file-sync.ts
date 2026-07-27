/**
 * Native file-sync transport for the Kubernetes sandbox provider.
 *
 * Implements the opt-in `onEnvironmentSyncIn`/`onEnvironmentSyncOut` hooks over
 * the pod exec data channel, so workspace/asset transfers stream through a
 * SINGLE exec per operation instead of the default base64 chunk loop (which
 * costs one exec per ~4 MB chunk — see `upload-interceptor.ts`).
 *
 * The transport is pure streaming: raw tar bytes move over the exec's stdin /
 * stdout channels straight to and from a host file on disk, so neither the host
 * nor the pod ever holds the whole payload in memory.
 *
 *   - syncIn:  build one host tarball of the operation's payload on disk, stream
 *              its raw bytes over the exec's stdin into `head -c <N> | tar -x`
 *              inside the pod (N is the exact archive size, known host-side, so
 *              the pod command self-terminates without depending on stdin EOF),
 *              then stage-then-`mv -f` each single file onto its target so an
 *              interrupted transfer never leaves a truncated file.
 *   - syncOut: run `tar -c … -f -` inside the pod over one exec, streaming the
 *              archive on stdout straight into a host file, then reassemble it.
 *
 * The exec primitive is injected as `PodStreamExec` so this module stays free of
 * any `@kubernetes/client-node` coupling and is unit-testable against a
 * shell-backed fake. `plugin.ts` binds it to `execInPodStreaming` for a resolved
 * pod.
 *
 * Security model (carried from the seam's design review): every sandbox path is
 * confined to the workspace remote dir both lexically on the host AND via an
 * in-pod `realpath` check that pins the resolved directory inode through
 * `/proc/self/fd` before any byte is written — closing the symlink-swap TOCTOU
 * window. Secret files land at their requested `mode` with no world-readable
 * window (the staging dir is created `0700` and each file is `chmod`ed before
 * the rename). All interpolated paths are single-quoted. Sandbox-authored
 * tarballs (outbound) are member-confined before host extraction.
 *
 * Memory + disk posture: because the archive streams to/from disk, a transfer of
 * any size keeps host and pod memory flat — there is no whole-payload buffer and
 * therefore no 100 MB in-memory cap (the old base64-buffered transport needed
 * one). Inbound bytes are host-authored (the tar this module builds), so they
 * need no untrusted-size bound. Outbound bytes are authored by the untrusted
 * pod, which controls how much it emits, so the sink `Writable` is wrapped in a
 * streamed-bytes guard that fails the transfer closed above `maxOutputBytes`
 * before it can fill the host's disk; the pod's stderr is separately capped in
 * `execInPodStreaming`.
 */
import path from "node:path";
import os from "node:os";
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { finished } from "node:stream/promises";
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginEnvironmentSyncResult,
  PluginSyncFileMapping,
  PluginSyncOperation,
} from "@paperclipai/plugin-sdk";

const execFileAsync = promisify(execFile);

/**
 * Injected streaming pod-exec primitive. `command` is always
 * `["/bin/sh", "-c", <script>]`; `io.stdin` (when present) is streamed to the
 * command's stdin over the exec data channel, and `io.stdout` (when present)
 * receives the command's stdout. Returns the command's exit code plus its
 * captured (bounded) stderr. `plugin.ts` binds this to
 * `execInPodStreaming(kc, namespace, podName, "agent", …)`.
 */
export type PodStreamExec = (
  command: string[],
  io: {
    stdin?: Readable;
    stdout?: Writable;
    timeoutMs?: number;
    maxStderrBytes?: number;
  },
) => Promise<{ exitCode: number; stderr: string }>;

// Reserved scratch-name stem for staged transfers and remote tarballs. The
// runtime's base64 fallback stages to `<path>.paperclip-upload`; the native
// transport reuses the same reserved prefix so a provider temp never collides
// with a real target or with the fallback's scratch name.
const SCRATCH_PREFIX = ".paperclip-upload";

// Fail-closed guard on the number of bytes an outbound (`syncOut`) transfer will
// stream to host disk. The archive is authored by the untrusted pod, which
// controls how many bytes it emits on stdout; streaming keeps memory flat but a
// hostile pod could still try to exhaust the worker's ephemeral disk. The
// transfer aborts the instant the pod exceeds this bound. It is deliberately
// generous (real workspace/asset syncs are far smaller) and overridable per
// call so operators can tune it to the worker's actual disk budget.
const MAX_SYNC_OUTPUT_BYTES = 8 * 1024 * 1024 * 1024;

// Bound on the pod's stderr for a sync exec. stderr carries only the in-pod
// script's fail-loud diagnostics, so a modest cap is ample; it exists solely so
// a pod that floods stderr cannot grow the host accumulator without limit.
const SYNC_STDERR_CAP_BYTES = 1024 * 1024;

function scratchName(suffix = ""): string {
  return `${SCRATCH_PREFIX}-${randomUUID()}${suffix}`;
}

/**
 * Single-quote a string for safe interpolation into a `sh -c` script (close,
 * escape, reopen). Mirrors `pod-exec.ts`'s `shQuote`; duplicated here so this
 * module carries no `@kubernetes/client-node` import and stays hermetically
 * testable. Every path handed to an exec MUST pass through this.
 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Host-side complete-mediation guard applied as defense-in-depth below the
 * orchestrator's own confinement. Every sandbox-side path (the sync target for
 * inbound, the sync source for outbound) MUST be an absolute path that
 * canonicalizes lexically inside the workspace remote dir; absolute escapes and
 * `..` traversal are rejected fail-closed before any bytes move. Sandbox paths
 * are POSIX.
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
    throw new Error(`Kubernetes sync ${label} path is not a confined absolute path: ${candidate}`);
  }
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  if (normalized !== normalizedRoot && !normalized.startsWith(prefix)) {
    throw new Error(`Kubernetes sync ${label} path escapes the workspace remote dir: ${candidate}`);
  }
}

/**
 * True when `relative` (a POSIX path) escapes its anchoring directory once
 * normalized: an absolute path, `..`, or a `..`-leading traversal all break out.
 */
function posixPathEscapes(relative: string): boolean {
  const normalized = path.posix.normalize(relative);
  return normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized);
}

async function withHostTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-k8s-sync-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * POSIX-sh preamble defining a `_pc_resolve` canonicalizer (prefer `realpath`,
 * fall back to `readlink -f`; fail closed with exit 40 if neither exists so the
 * host-side lexical check is never the only line of defense) and `_pc_root` =
 * the resolved workspace remote dir. Shared by every in-pod symlink-escape guard.
 *
 * Also defines `_pc_confine_ancestor <path>`: it walks up to the DEEPEST already-
 * existing ancestor of `<path>`, canonicalizes it, and confines it inside
 * `_pc_root` (exit 42 on escape). `mkdir -p` follows an existing symlink ancestor,
 * so creating a target directory before confining could materialize a dir OUTSIDE
 * the root and only reject afterward — the escape has already mutated the host.
 * Confining the closest existing prefix BEFORE `mkdir` closes that window: any
 * component `mkdir -p` newly creates is a real directory, so only a pre-existing
 * symlink ancestor can redirect the write, and that ancestor is exactly what this
 * check canonicalizes and rejects.
 */
function canonicalizerPreamble(quotedRoot: string): string[] {
  return [
    'if command -v realpath >/dev/null 2>&1; then _pc_resolve() { realpath -- "$1"; };',
    'elif command -v readlink >/dev/null 2>&1; then _pc_resolve() { readlink -f -- "$1"; };',
    'else echo "no path canonicalizer available" >&2; exit 40; fi;',
    `_pc_root=$(_pc_resolve ${quotedRoot}) || { echo "cannot resolve root" >&2; exit 41; };`,
    '_pc_confine_ancestor() {',
    // Confinement targets are always absolute (asserted host-side), so `dirname`
    // needs no `--` end-of-options guard — and omitting it keeps the walk correct
    // on minimal shells (e.g. BusyBox `dirname`, which does not parse `--`).
    '  _pc_a=$1;',
    '  while [ ! -e "$_pc_a" ] && [ ! -L "$_pc_a" ]; do',
    '    _pc_p=$(dirname "$_pc_a");',
    '    [ "$_pc_p" = "$_pc_a" ] && break;',
    '    _pc_a=$_pc_p;',
    '  done;',
    '  _pc_ar=$(_pc_resolve "$_pc_a") || return 42;',
    '  case "$_pc_ar/" in "$_pc_root"/*) return 0 ;; *) return 42 ;; esac;',
    '};',
  ];
}

/**
 * Stream a host file's raw bytes into the pod command's stdin over one exec and
 * assert it exited 0; otherwise throw with the captured stderr so a failed
 * transfer surfaces fail-loud to the orchestrator (never a silent partial
 * success). The pod command bounds its own read (`head -c <N>`), so stdin EOF is
 * never load-bearing.
 */
async function streamFileToPodStdin(input: {
  exec: PodStreamExec;
  script: string;
  filePath: string;
  timeoutMs: number;
  label: string;
}): Promise<void> {
  const source = createReadStream(input.filePath);
  try {
    const result = await input.exec(["/bin/sh", "-c", input.script], {
      stdin: source,
      timeoutMs: input.timeoutMs,
      maxStderrBytes: SYNC_STDERR_CAP_BYTES,
    });
    if (result.exitCode !== 0) {
      const detail = (result.stderr || "").trim();
      throw new Error(
        `Kubernetes ${input.label} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
      );
    }
  } finally {
    source.destroy();
  }
}

/**
 * Run the pod command over one exec and stream its stdout straight into a host
 * file, guarding the byte count against `maxOutputBytes` so an untrusted pod
 * cannot fill the host disk. Resolves only after the file is fully flushed, so a
 * caller that reads it back always sees the complete archive; throws fail-loud on
 * a non-zero exit, a tripped disk guard, or a stream error, writing no file the
 * caller then trusts.
 */
async function streamPodStdoutToFile(input: {
  exec: PodStreamExec;
  script: string;
  filePath: string;
  maxOutputBytes: number;
  timeoutMs: number;
  label: string;
}): Promise<void> {
  const fileStream = createWriteStream(input.filePath);
  let written = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (input.maxOutputBytes >= 0 && written > input.maxOutputBytes) {
        cb(
          new Error(
            `Kubernetes ${input.label} payload exceeded the ${input.maxOutputBytes}-byte streamed-output disk guard; the sandbox emitted more bytes than allowed.`,
          ),
        );
        return;
      }
      cb(null, chunk);
    },
  });
  guard.pipe(fileStream);
  const flushed = finished(fileStream);
  try {
    const result = await input.exec(["/bin/sh", "-c", input.script], {
      stdout: guard,
      timeoutMs: input.timeoutMs,
      maxStderrBytes: SYNC_STDERR_CAP_BYTES,
    });
    await flushed;
    if (result.exitCode !== 0) {
      const detail = (result.stderr || "").trim();
      throw new Error(
        `Kubernetes ${input.label} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
      );
    }
  } catch (err) {
    // Tear the sink down so a tripped guard / rejected exec never leaves the
    // file stream open (and its `finished` promise dangling as unhandled).
    guard.destroy();
    fileStream.destroy();
    await flushed.catch(() => undefined);
    throw err;
  }
}

/**
 * Build a host-side tarball, mirroring the runtime's own `createTarballFromDirectory`:
 * archive the named top-level entries (no "." self entry), suppress xattr
 * sidecars, honor `exclude`, and reproduce the `followSymlinks` → `-h` mapping so
 * the native path is observationally identical to the base64 fallback's tar. An
 * empty entry set writes a valid empty tar (1024-byte zero EOF marker).
 */
async function createHostTarball(input: {
  localDir: string;
  archivePath: string;
  exclude?: string[];
  followSymlinks?: boolean;
  entries?: string[];
}): Promise<void> {
  const excludeArgs = ["._*", ...(input.exclude ?? [])].flatMap((entry) => ["--exclude", entry]);
  const entries =
    input.entries ??
    (await fs.readdir(input.localDir)).sort((left, right) => left.localeCompare(right));
  if (entries.length === 0) {
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
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * Reject a sandbox-authored tarball before extraction if any member would land
 * outside the extraction dir. The archive is produced by the (untrusted) sandbox,
 * so host-side `tar -xf` must never be handed an archive whose entries carry
 * absolute paths or `../` traversal, nor a symlink/hardlink member whose target
 * escapes the tree. Legitimate in-tree relative links are preserved. Parses the
 * `-tvf` verbose listing; any unparseable line fails closed.
 */
async function assertTarballEntriesConfined(archivePath: string): Promise<void> {
  const { stdout } = await execFileAsync("tar", ["-tvf", archivePath], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  for (const line of lines) {
    // GNU tar -tvf: "<perms> <owner>/<group> <size> <date> <time> <name>[ -> target]".
    const match = line.match(/^(\S+)\s+\S+\s+\d+\s+\S+\s+\S+\s+(.*)$/);
    if (!match) {
      throw new Error(`Kubernetes syncOut refusing tarball with an unparseable entry listing: ${line}`);
    }
    const typeFlag = match[1][0];
    let name = match[2];
    let linkTarget: string | null = null;
    if (typeFlag === "l") {
      const idx = name.indexOf(" -> ");
      if (idx === -1) throw new Error(`Kubernetes syncOut refusing unparseable symlink entry: ${line}`);
      linkTarget = name.slice(idx + " -> ".length);
      name = name.slice(0, idx);
    } else if (typeFlag === "h") {
      const idx = name.indexOf(" link to ");
      if (idx === -1) throw new Error(`Kubernetes syncOut refusing unparseable hardlink entry: ${line}`);
      linkTarget = name.slice(idx + " link to ".length);
      name = name.slice(0, idx);
    }
    const cleanName = name.replace(/\/+$/, "");
    if (cleanName.length > 0 && posixPathEscapes(cleanName)) {
      throw new Error(`Kubernetes syncOut refusing tarball member that escapes the extraction dir: ${name}`);
    }
    if (linkTarget !== null) {
      const resolved = path.posix.join(path.posix.dirname(cleanName), linkTarget);
      if (path.posix.isAbsolute(linkTarget) || posixPathEscapes(resolved)) {
        throw new Error(
          `Kubernetes syncOut refusing tarball link whose target escapes the extraction dir: ${name} -> ${linkTarget}`,
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
    maxBuffer: 64 * 1024 * 1024,
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

// ---------------------------------------------------------------------------
// Inbound (host → sandbox)
// ---------------------------------------------------------------------------

/**
 * Transfer all `kind:"file"` mappings of an operation in ONE exec. The host tars
 * the sources under stable index names on disk, streams the archive's raw bytes
 * over the exec's stdin, and a single in-pod script reads exactly the archive's
 * byte count (`head -c <N>`), extracts into a reserved `0700` staging dir,
 * applies each requested mode BEFORE the rename (no widened window), then
 * atomic-`mv -f`s each file onto its target through a `/proc/self/fd`-pinned
 * parent directory so a symlink swap cannot redirect the write outside the root.
 */
async function syncInFileMappings(input: {
  exec: PodStreamExec;
  mappings: PluginSyncFileMapping[];
  remoteDir: string;
  timeoutMs: number;
}): Promise<{ filesTransferred: number; bytesTransferred: number }> {
  const { exec, mappings, remoteDir, timeoutMs } = input;
  if (mappings.length === 0) return { filesTransferred: 0, bytesTransferred: 0 };

  for (const mapping of mappings) {
    assertConfinedSandboxPath(remoteDir, mapping.targetPath, "target");
  }

  return withHostTempDir(async (tmp) => {
    // Stage each source under a flat index name so one tar carries the whole
    // operation; the index maps back to the mapping for mode + rename below.
    const stage = path.join(tmp, "stage");
    await fs.mkdir(stage);
    let bytesTransferred = 0;
    const indexNames: string[] = [];
    for (let i = 0; i < mappings.length; i += 1) {
      const name = String(i);
      await fs.copyFile(mappings[i].sourcePath, path.join(stage, name));
      bytesTransferred += (await fs.stat(mappings[i].sourcePath)).size;
      indexNames.push(name);
    }

    const archivePath = path.join(tmp, "sync-in.tar");
    await createHostTarball({ localDir: stage, archivePath, entries: indexNames });
    // Exact archive size: the pod reads precisely this many bytes so its extract
    // pipeline self-terminates without depending on stdin EOF delivery.
    const archiveBytes = (await fs.stat(archivePath)).size;

    // Reserved staging dir is a DIRECT child of the workspace root (created
    // `0700`), so a secret is never world-readable and the closing `mv -f` is an
    // atomic same-filesystem rename.
    const remoteStage = path.posix.join(remoteDir, scratchName());
    const parentDirs = [...new Set(mappings.map((m) => path.posix.dirname(m.targetPath)))];

    const script: string[] = [...canonicalizerPreamble(shQuote(remoteDir))];
    // Sweep the staging dir on ANY exit so a failed transfer leaves no scratch.
    script.push(`trap 'rm -rf ${shQuote(remoteStage)}' EXIT;`);
    script.push(`mkdir -p -m 700 ${shQuote(remoteStage)} || { echo "stage mkdir failed" >&2; exit 46; };`);
    // Confine the deepest existing ancestor of each target parent BEFORE creating
    // it: `mkdir -p` follows a sandbox-planted symlink ancestor and would
    // otherwise materialize the directory OUTSIDE the root before any post-mkdir
    // check could reject it (P0 escape). Confine-then-create closes that window.
    for (const dir of parentDirs) {
      script.push(
        `_pc_confine_ancestor ${shQuote(dir)} || { echo "ESCAPE" >&2; exit 42; };`,
        `mkdir -p ${shQuote(dir)} || { echo "mkdir failed" >&2; exit 46; };`,
      );
    }
    // Re-confine every (now-materialized) target parent dir through realpath before
    // any bytes land: a sandbox-planted symlink parent is caught here too.
    for (const dir of parentDirs) {
      script.push(
        `_pc_d=$(_pc_resolve ${shQuote(dir)}) || { echo "ESCAPE" >&2; exit 42; };`,
        `case "$_pc_d/" in "$_pc_root"/*) : ;; *) echo "ESCAPE" >&2; exit 42 ;; esac;`,
      );
    }
    // Read exactly the archive's bytes off stdin and extract the whole payload
    // into the staging dir in one pipeline.
    script.push(
      `head -c ${archiveBytes} | tar -xf - -C ${shQuote(remoteStage)} || { echo "extract failed" >&2; exit 43; };`,
    );
    // Promote each staged file onto its target: chmod the temp first (secret
    // lands at its mode from the instant it exists at targetPath), then bind the
    // parent-dir re-check and the rename into a `/proc/self/fd`-pinned open so an
    // ancestor swap after the check cannot redirect the rename.
    mappings.forEach((mapping, i) => {
      const staged = path.posix.join(remoteStage, indexNames[i]);
      const parentDir = path.posix.dirname(mapping.targetPath);
      const base = path.posix.basename(mapping.targetPath);
      if (typeof mapping.mode === "number") {
        script.push(
          `chmod ${(mapping.mode & 0o7777).toString(8).padStart(3, "0")} ${shQuote(staged)} || { echo "chmod failed" >&2; exit 48; };`,
        );
      }
      script.push(
        `_pc_tgt_dir=$(_pc_resolve ${shQuote(parentDir)}) || { echo "ESCAPE" >&2; exit 42; };`,
        `case "$_pc_tgt_dir/" in "$_pc_root"/*) : ;; *) echo "ESCAPE" >&2; exit 42 ;; esac;`,
        `exec 8<"$_pc_tgt_dir" || { echo "open failed" >&2; exit 47; };`,
        `_pc_fd_dir=$(_pc_resolve /proc/self/fd/8) || { echo "ESCAPE" >&2; exit 42; };`,
        `case "$_pc_fd_dir/" in "$_pc_root"/*) : ;; *) echo "ESCAPE" >&2; exit 42 ;; esac;`,
        `mv -f ${shQuote(staged)} /proc/self/fd/8/${shQuote(base)} || { echo "rename failed" >&2; exit 44; };`,
        `exec 8>&-;`,
      );
    });

    await streamFileToPodStdin({
      exec,
      script: script.join("\n"),
      filePath: archivePath,
      timeoutMs,
      label: "syncIn file transfer",
    });
    return { filesTransferred: mappings.length, bytesTransferred };
  });
}

/**
 * Transfer one `kind:"directory"` mapping in ONE exec: the host tars the source
 * on disk (reproducing `followSymlinks` → `-h` and `exclude`), streams its raw
 * bytes over stdin, and the pod reads exactly that byte count and extracts into
 * the target through a `/proc/self/fd`-pinned directory inode. Directory
 * extraction is destroy-into (non-atomic), matching the base64 fallback's tar;
 * only single files are atomic.
 */
async function syncInDirectoryMapping(input: {
  exec: PodStreamExec;
  mapping: PluginSyncFileMapping;
  remoteDir: string;
  timeoutMs: number;
}): Promise<{ filesTransferred: number; bytesTransferred: number }> {
  const { exec, mapping, remoteDir, timeoutMs } = input;
  assertConfinedSandboxPath(remoteDir, mapping.targetPath, "target");
  return withHostTempDir(async (tmp) => {
    const archivePath = path.join(tmp, "sync-in.tar");
    await createHostTarball({
      localDir: mapping.sourcePath,
      archivePath,
      exclude: mapping.exclude,
      followSymlinks: mapping.followSymlinks,
    });
    const archiveBytes = (await fs.stat(archivePath)).size;

    const target = mapping.targetPath;
    const script = [
      ...canonicalizerPreamble(shQuote(remoteDir)),
      // Confine the deepest existing ancestor before `mkdir -p` runs: it follows a
      // sandbox-planted symlink ancestor and would otherwise create the target dir
      // OUTSIDE the root before the post-mkdir realpath check below could reject it.
      `_pc_confine_ancestor ${shQuote(target)} || { echo "ESCAPE" >&2; exit 42; };`,
      `mkdir -p ${shQuote(target)} || { echo "mkdir failed" >&2; exit 46; };`,
      // Open-then-verify the extraction dir: `open()` walks every ancestor, so a
      // post-resolve ancestor swap is caught by re-canonicalizing the pinned fd
      // before extracting; `tar -C /proc/self/fd/9` then chdir's through the
      // pinned inode, immune to a later path swap.
      `_pc_real=$(_pc_resolve ${shQuote(target)}) || { echo "ESCAPE" >&2; exit 42; };`,
      `case "$_pc_real/" in "$_pc_root"/*) : ;; *) echo "ESCAPE" >&2; exit 42 ;; esac;`,
      `exec 9<"$_pc_real" || { echo "open failed" >&2; exit 46; };`,
      `_pc_fd_real=$(_pc_resolve /proc/self/fd/9) || { echo "ESCAPE" >&2; exit 42; };`,
      `case "$_pc_fd_real/" in "$_pc_root"/*) : ;; *) echo "ESCAPE" >&2; exit 42 ;; esac;`,
      `head -c ${archiveBytes} | tar -xf - -C /proc/self/fd/9 || { echo "extract failed" >&2; exit 43; };`,
      `exec 9>&-;`,
    ].join("\n");

    await streamFileToPodStdin({
      exec,
      script,
      filePath: archivePath,
      timeoutMs,
      label: "syncIn directory transfer",
    });
    const filesTransferred = await countHostFiles(mapping.sourcePath, mapping.exclude);
    return { filesTransferred, bytesTransferred: archiveBytes };
  });
}

export async function performSyncIn(input: {
  exec: PodStreamExec;
  operations: PluginSyncOperation[];
  remoteDir: string;
  timeoutMs: number;
}): Promise<PluginEnvironmentSyncResult> {
  const operations: PluginEnvironmentSyncResult["operations"] = [];
  for (const operation of input.operations) {
    let filesTransferred = 0;
    let bytesTransferred = 0;

    const fileMappings = operation.files.filter((mapping) => mapping.kind === "file");
    const directoryMappings = operation.files.filter((mapping) => mapping.kind === "directory");

    const fileResult = await syncInFileMappings({
      exec: input.exec,
      mappings: fileMappings,
      remoteDir: input.remoteDir,
      timeoutMs: input.timeoutMs,
    });
    filesTransferred += fileResult.filesTransferred;
    bytesTransferred += fileResult.bytesTransferred;

    for (const mapping of directoryMappings) {
      const dirResult = await syncInDirectoryMapping({
        exec: input.exec,
        mapping,
        remoteDir: input.remoteDir,
        timeoutMs: input.timeoutMs,
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

/**
 * Stream all `kind:"file"` mappings of an operation back in ONE exec. The in-pod
 * script validates + snapshots each source (confinement realpath check, then a
 * non-symlink regular-file re-check immediately before `cp` closes the
 * validation→copy window), tars the immutable snapshots under index names, and
 * streams the archive on stdout straight into a host file. The host decodes,
 * extracts to a temp, and atomic-renames each file onto its host target
 * (chmod-before-rename for secret modes) so an interrupted reassembly never
 * truncates a target.
 */
async function syncOutFileMappings(input: {
  exec: PodStreamExec;
  mappings: PluginSyncFileMapping[];
  remoteDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<{ filesTransferred: number; bytesTransferred: number }> {
  const { exec, mappings, remoteDir, timeoutMs, maxOutputBytes } = input;
  if (mappings.length === 0) return { filesTransferred: 0, bytesTransferred: 0 };

  for (const mapping of mappings) {
    assertConfinedSandboxPath(remoteDir, mapping.sourcePath, "source");
  }

  return withHostTempDir(async (tmp) => {
    const remoteStage = path.posix.join(remoteDir, scratchName());
    const indexNames = mappings.map((_, i) => String(i));

    const script: string[] = [...canonicalizerPreamble(shQuote(remoteDir))];
    script.push(`trap 'rm -rf ${shQuote(remoteStage)}' EXIT;`);
    script.push(`mkdir -p -m 700 ${shQuote(remoteStage)} || { echo "stage mkdir failed" >&2; exit 46; };`);
    mappings.forEach((mapping, i) => {
      const snapshot = path.posix.join(remoteStage, indexNames[i]);
      script.push(
        `_pc_real=$(_pc_resolve ${shQuote(mapping.sourcePath)}) || { echo "ESCAPE" >&2; exit 42; };`,
        `case "$_pc_real/" in "$_pc_root"/*) : ;; *) echo "ESCAPE" >&2; exit 42 ;; esac;`,
        // Close the validation→copy TOCTOU by pinning the file to an FD and
        // snapshotting THROUGH it, never re-opening by name: `open()` captures the
        // inode, so a source replacement (symlink swap) after this point cannot
        // redirect the copy. Re-resolving the pinned fd re-confines the TRUE inode
        // we opened — if the sandbox swapped `$_pc_real` for a symlink between the
        // resolve above and this open, the fd now points at that target and the
        // re-confinement (or the regular-file check) rejects it before any byte is
        // copied. `cp` then reads the fd's inode, immune to any further swap.
        `exec 7<"$_pc_real" || { echo "REPLACED" >&2; exit 45; };`,
        `_pc_fd_real=$(_pc_resolve /proc/self/fd/7) || { echo "ESCAPE" >&2; exit 42; };`,
        `case "$_pc_fd_real/" in "$_pc_root"/*) : ;; *) echo "ESCAPE" >&2; exit 42 ;; esac;`,
        `[ -f /proc/self/fd/7 ] || { echo "NOTREG" >&2; exit 45; };`,
        `cp -- /proc/self/fd/7 ${shQuote(snapshot)} || { echo "snapshot copy failed" >&2; exit 43; };`,
        `exec 7>&-;`,
      );
    });
    // Tar the immutable snapshots straight to stdout (streamed to a host file).
    script.push(
      `tar -c --no-xattrs -f - -C ${shQuote(remoteStage)} -- ${indexNames
        .map(shQuote)
        .join(" ")} || { echo "tar failed" >&2; exit 43; };`,
    );

    const localTar = path.join(tmp, "sync-out.tar");
    await streamPodStdoutToFile({
      exec,
      script: script.join("\n"),
      filePath: localTar,
      maxOutputBytes,
      timeoutMs,
      label: "syncOut file transfer",
    });

    // Reassemble on the host: member-confine the sandbox-authored archive,
    // extract to a temp, then atomic-rename each index file onto its host target.
    const extractDir = path.join(tmp, "extract");
    await extractHostTarball({ archivePath: localTar, localDir: extractDir });

    let bytesTransferred = 0;
    for (let i = 0; i < mappings.length; i += 1) {
      const mapping = mappings[i];
      const staged = path.join(extractDir, indexNames[i]);
      await fs.mkdir(path.dirname(mapping.targetPath), { recursive: true });
      if (typeof mapping.mode === "number") {
        await fs.chmod(staged, mapping.mode);
      }
      bytesTransferred += (await fs.stat(staged)).size;
      await fs.rename(staged, mapping.targetPath);
    }
    return { filesTransferred: mappings.length, bytesTransferred };
  });
}

/**
 * Stream one `kind:"directory"` mapping back in ONE exec: the in-pod script
 * confines the source (realpath through `/proc/self/fd`), tars it (reproducing
 * `followSymlinks` → `-h` and `exclude`, naming top-level entries so no "." self
 * entry is embedded) straight to stdout, and the host streams that into a file,
 * member-confines the sandbox-authored tar, and extracts into the target dir.
 */
async function syncOutDirectoryMapping(input: {
  exec: PodStreamExec;
  mapping: PluginSyncFileMapping;
  remoteDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<{ filesTransferred: number; bytesTransferred: number }> {
  const { exec, mapping, remoteDir, timeoutMs, maxOutputBytes } = input;
  assertConfinedSandboxPath(remoteDir, mapping.sourcePath, "source");
  return withHostTempDir(async (tmp) => {
    const excludeFlags = ["._*", ...(mapping.exclude ?? [])]
      .map((entry) => `--exclude ${shQuote(entry)}`)
      .join(" ");
    const script = [
      ...canonicalizerPreamble(shQuote(remoteDir)),
      // Confine the source dir through an open-then-verify pinned fd before taring.
      `_pc_real=$(_pc_resolve ${shQuote(mapping.sourcePath)}) || { echo "ESCAPE" >&2; exit 42; };`,
      `case "$_pc_real/" in "$_pc_root"/*) : ;; *) echo "ESCAPE" >&2; exit 42 ;; esac;`,
      `exec 9<"$_pc_real" || { echo "open failed" >&2; exit 46; };`,
      `_pc_fd_real=$(_pc_resolve /proc/self/fd/9) || { echo "ESCAPE" >&2; exit 42; };`,
      `case "$_pc_fd_real/" in "$_pc_root"/*) : ;; *) echo "ESCAPE" >&2; exit 42 ;; esac;`,
      `cd /proc/self/fd/9 || { echo "cd failed" >&2; exit 46; };`,
      // Collect top-level entries (incl. dotfiles) without a "." self-entry, then
      // tar with the `followSymlinks` → `-h` mapping, streaming to stdout.
      "set -- *",
      'if [ "$#" -eq 1 ] && [ "$1" = "*" ] && [ ! -e "$1" ] && [ ! -L "$1" ]; then set --; fi',
      'for entry in .[!.]* ..?*; do [ -e "$entry" ] || [ -L "$entry" ] || continue; set -- "$@" "$entry"; done',
      `if [ "$#" -eq 0 ]; then dd if=/dev/zero bs=1024 count=1 2>/dev/null; ` +
        `else tar -c --no-xattrs ${mapping.followSymlinks ? "-h " : ""}${excludeFlags} -f - -- "$@" || { echo "tar failed" >&2; exit 43; }; fi`,
      `exec 9>&-;`,
    ].join("\n");

    const localTar = path.join(tmp, "sync-out.tar");
    await streamPodStdoutToFile({
      exec,
      script,
      filePath: localTar,
      maxOutputBytes,
      timeoutMs,
      label: "syncOut directory transfer",
    });
    const bytesTransferred = (await fs.stat(localTar)).size;
    await extractHostTarball({ archivePath: localTar, localDir: mapping.targetPath });
    const filesTransferred = await countHostFiles(mapping.targetPath, mapping.exclude);
    return { filesTransferred, bytesTransferred };
  });
}

export async function performSyncOut(input: {
  exec: PodStreamExec;
  operations: PluginSyncOperation[];
  remoteDir: string;
  timeoutMs: number;
  maxOutputBytes?: number;
}): Promise<PluginEnvironmentSyncResult> {
  const maxOutputBytes = input.maxOutputBytes ?? MAX_SYNC_OUTPUT_BYTES;
  const operations: PluginEnvironmentSyncResult["operations"] = [];
  for (const operation of input.operations) {
    let filesTransferred = 0;
    let bytesTransferred = 0;

    const fileMappings = operation.files.filter((mapping) => mapping.kind === "file");
    const directoryMappings = operation.files.filter((mapping) => mapping.kind === "directory");

    const fileResult = await syncOutFileMappings({
      exec: input.exec,
      mappings: fileMappings,
      remoteDir: input.remoteDir,
      timeoutMs: input.timeoutMs,
      maxOutputBytes,
    });
    filesTransferred += fileResult.filesTransferred;
    bytesTransferred += fileResult.bytesTransferred;

    for (const mapping of directoryMappings) {
      const dirResult = await syncOutDirectoryMapping({
        exec: input.exec,
        mapping,
        remoteDir: input.remoteDir,
        timeoutMs: input.timeoutMs,
        maxOutputBytes,
      });
      filesTransferred += dirResult.filesTransferred;
      bytesTransferred += dirResult.bytesTransferred;
    }

    operations.push({ operationId: operation.operationId, filesTransferred, bytesTransferred });
  }
  return { operations };
}
