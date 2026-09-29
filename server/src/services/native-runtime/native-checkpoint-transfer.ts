import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, opendir, rename, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { syncNativeHarnessDirectory } from "./native-harness-tree.js";
import { runCheckpointCommand } from "./native-checkpoint-command.js";

const execute = promisify(execFile);
const CHUNK_BYTES = 192 * 1024; // Base64 remains below ordinary 1 MiB command output budgets.
const MAX_LINE_BYTES = 64 * 1024;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const shaCommand = (path: string) => `(if command -v sha256sum >/dev/null 2>&1; then sha256sum ${quote(path)}; else shasum -a 256 ${quote(path)}; fi)`;

async function remote(runner: CommandManagedRuntimeRunner, script: string, stdin?: string, timeoutMs = 30_000): Promise<string> {
  if (timeoutMs === 0 && stdin === undefined) return runCheckpointCommand(runner, `set -e; umask 077; ${script}`);
  const result = await runner.execute({ command: "sh", args: ["-c", `set -e; umask 077; ${script}`], stdin, bypassSession: true, timeoutMs });
  if (result.exitCode !== 0 || result.timedOut) throw new Error("runner_remote_checkpoint_transfer_failed");
  return result.stdout;
}

export function checkpointExclusions(entries: readonly string[]): string[] {
  for (const entry of entries) {
    if (!entry || entry.startsWith("/") || entry.split("/").some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..")) {
      throw new Error("runner_remote_checkpoint_exclusion_invalid");
    }
  }
  return entries.map(entry => `--exclude=./${entry}`);
}

/** Only diagnostic output is buffered. Archive bytes always remain on disk. */
export async function checkpointTar(args: string[]): Promise<void> {
  await execute("tar", args, { env: { ...process.env, COPYFILE_DISABLE: "1", LC_ALL: "C" }, maxBuffer: MAX_LINE_BYTES });
}

async function digest(path: string): Promise<{ bytes: bigint; sha256: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256"); let bytes = 0n;
  try {
    if (!(await file.stat()).isFile()) throw new Error("runner_remote_checkpoint_archive_invalid");
    for await (const chunk of file.createReadStream({ highWaterMark: CHUNK_BYTES, autoClose: false })) {
      hash.update(chunk); bytes += BigInt(chunk.length);
    }
  } finally { await file.close(); }
  return { bytes, sha256: hash.digest("hex") };
}

/** Strict archive validation before extraction, with bounded listing memory.
 * Links/devices are excluded from checkpoints. Tar receives the same private,
 * immutable spool for validation and extraction. No total bytes/entry limit. */
export async function validateCheckpointArchive(path: string): Promise<void> {
  const child = spawn("tar", ["-tvzf", path], { env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderrBytes = 0, pending = "", count = 0n;
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error("runner_remote_checkpoint_archive_invalid")));
  });
  // Attach immediately: validation can fail before the child exits.
  void completed.catch(() => undefined);
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_LINE_BYTES) child.kill(); });
  const validate = (line: string) => {
    if (!line) return;
    // GNU and BSD tar listings. Fail closed on an unknown dialect or an entry
    // whose path contains a raw line break, rather than trusting a partial name.
    const parsed = line.match(/^(\S+)\s+\S+\/\S+\s+\d+\s+\S+\s+\S+\s+(.*)$/)
      ?? line.match(/^(\S+)\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2}(?::\d{2})?)\s+(.*)$/);
    if (!parsed) throw new Error("runner_remote_checkpoint_archive_invalid");
    if (parsed[1]![0] !== "-" && parsed[1]![0] !== "d") throw new Error("runner_remote_checkpoint_archive_unsafe_entry");
    const name = parsed[2]!;
    if (name.startsWith("/") || name.includes("\0") || name.split("/").includes("..")) throw new Error("runner_remote_checkpoint_archive_unsafe_path");
    count++;
  };
  try {
    child.stdout.setEncoding("utf8");
    for await (const chunk of child.stdout) {
      pending += String(chunk);
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        if (end > MAX_LINE_BYTES) throw new Error("runner_remote_checkpoint_archive_invalid");
        validate(pending.slice(0, end)); pending = pending.slice(end + 1);
      }
      if (pending.length > MAX_LINE_BYTES) throw new Error("runner_remote_checkpoint_archive_invalid");
    }
    if (pending) validate(pending);
    await completed;
    if (!count || stderrBytes > MAX_LINE_BYTES) throw new Error("runner_remote_checkpoint_archive_invalid");
  } catch (error) { child.kill(); await completed.catch(() => undefined); throw error; }
}

async function verifyExtracted(root: string, depth = 0): Promise<void> {
  if (depth > 128 || !(await lstat(root)).isDirectory()) throw new Error("runner_remote_checkpoint_unsafe_entry");
  const files: string[] = [];
  const flush = async () => {
    // Keep fsync and descriptor concurrency bounded independently of history
    // length. Await every operation before cleanup or syncing its directory.
    const results = await Promise.allSettled(files.splice(0).map(async path => {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile()) throw new Error("runner_remote_checkpoint_unsafe_entry");
        await file.sync();
      } finally { await file.close(); }
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  };
  for await (const entry of await opendir(root, { bufferSize: 128 })) {
    const path = join(root, entry.name), stat = await lstat(path);
    if (stat.isDirectory()) {
      await flush();
      await verifyExtracted(path, depth + 1);
    }
    else if (stat.isFile()) {
      files.push(path);
      if (files.length === 8) await flush();
    } else throw new Error("runner_remote_checkpoint_unsafe_entry");
  }
  await flush();
  const directory = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function extractCheckpointArchive(archive: string, target: string, mode: number): Promise<void> {
  await validateCheckpointArchive(archive);
  await mkdir(target, { mode });
  await checkpointTar(["--no-same-owner", "--no-same-permissions", "-xzf", archive, "-C", target]);
  await verifyExtracted(target);
  await chmod(target, mode);
}

/** Upload bounded chunks to a private remote spool, verify the whole digest,
 * then extract. A slow large archive has no total transfer deadline. */
export async function uploadCheckpointArchive(input: { runner: CommandManagedRuntimeRunner; archive: string; targetPath: string; mode: number }): Promise<void> {
  const expected = await digest(input.archive);
  const scratch = posix.join(posix.dirname(input.targetPath), `.paperclip-checkpoint-${randomUUID()}`), archive = posix.join(scratch, "payload.tar.gz");
  let owned = false;
  try {
    await remote(input.runner, `mkdir -p ${quote(posix.dirname(input.targetPath))}; mkdir ${quote(scratch)}; : > ${quote(archive)}`); owned = true;
    const file = await open(input.archive, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(CHUNK_BYTES); let index = 0n, length = 0n;
      for (;;) {
        // Fill each block; file.read is allowed to return a short read.
        let filled = 0;
        while (filled < buffer.length) { const read = await file.read(buffer, filled, buffer.length - filled, null); if (!read.bytesRead) break; filled += read.bytesRead; }
        if (!filled) break;
        await remote(input.runner, `test ! -L ${quote(archive)}; test "$(wc -c < ${quote(archive)} | tr -d '[:space:]')" = ${quote(String(length))}; base64 -d | dd of=${quote(archive)} bs=${CHUNK_BYTES} seek=${index} conv=notrunc 2>/dev/null`, buffer.subarray(0, filled).toString("base64"));
        length += BigInt(filled); index++;
      }
    } finally { await file.close(); }
    const actual = await remote(input.runner, `wc -c < ${quote(archive)}; ${shaCommand(archive)}`, undefined, 0);
    assertRemoteDigest(actual, expected);
    await remote(input.runner, `mkdir -p ${quote(input.targetPath)}; tar -xzf ${quote(archive)} -C ${quote(input.targetPath)}; chmod ${input.mode.toString(8)} ${quote(input.targetPath)}`, undefined, 0);
  } finally { if (owned) await remote(input.runner, `rm -rf -- ${quote(scratch)}`).catch(() => undefined); }
}

function assertRemoteDigest(value: string, expected: { bytes: bigint; sha256: string }): void {
  const lines = value.trim().split("\n");
  if (lines.length !== 2 || !/^\s*\d+\s*$/.test(lines[0]!) || BigInt(lines[0]!.trim()) !== expected.bytes || lines[1]!.split(/\s+/)[0] !== expected.sha256) {
    throw new Error("runner_remote_checkpoint_digest_mismatch");
  }
}

/** Remote tar is a fixed disk snapshot. Transfer/read-back are independently
 * verified before the prior local checkpoint can be replaced. */
export async function downloadCheckpointDirectory(input: { runner: CommandManagedRuntimeRunner; sourcePath: string; targetPath: string; mode: number; excludeEntries?: readonly string[] }): Promise<void> {
  const excludes = checkpointExclusions(input.excludeEntries ?? []).map(quote).join(" ");
  const scratch = posix.join(posix.dirname(input.sourcePath), `.paperclip-checkpoint-${randomUUID()}`), archive = posix.join(scratch, "payload.tar.gz");
  await mkdir(dirname(input.targetPath), { recursive: true, mode: 0o700 });
  const local = await mkdtemp(join(dirname(input.targetPath), ".paperclip-checkpoint-"));
  const localArchive = join(local, "payload.tar.gz"), staged = join(local, "payload"), previous = join(local, "previous");
  let owned = false, moved = false, installed = false;
  try {
    await remote(input.runner, `mkdir ${quote(scratch)}`); owned = true;
    const manifest = await remote(input.runner, `tar ${excludes} -czf ${quote(archive)} -C ${quote(input.sourcePath)} .; wc -c < ${quote(archive)}; ${shaCommand(archive)}`, undefined, 0);
    const lines = manifest.trim().split("\n"), size = lines[0]?.trim(), sha256 = lines[1]?.split(/\s+/)[0];
    if (lines.length !== 2 || !size || !/^\d+$/.test(size) || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("runner_remote_checkpoint_archive_invalid");
    const total = BigInt(size), hash = createHash("sha256"), file = await open(localArchive, "wx", 0o600);
    try {
      for (let offset = 0n, index = 0n; offset < total; index++) {
        const encoded = await remote(input.runner, `test ! -L ${quote(archive)}; dd if=${quote(archive)} bs=${CHUNK_BYTES} skip=${index} count=1 2>/dev/null | base64`);
        if (encoded.length > CHUNK_BYTES * 2) throw new Error("runner_remote_checkpoint_chunk_invalid");
        const compact = encoded.replace(/\s/g, ""), chunk = Buffer.from(compact, "base64");
        const expected = Number(total - offset < BigInt(CHUNK_BYTES) ? total - offset : BigInt(CHUNK_BYTES));
        if (chunk.length !== expected || chunk.toString("base64") !== compact) throw new Error("runner_remote_checkpoint_chunk_invalid");
        hash.update(chunk); await file.writeFile(chunk); offset += BigInt(chunk.length);
      }
      if (hash.digest("hex") !== sha256) throw new Error("runner_remote_checkpoint_digest_mismatch");
      await file.sync();
    } finally { await file.close(); }
    await extractCheckpointArchive(localArchive, staged, input.mode);
    try { await rename(input.targetPath, previous); moved = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(staged, input.targetPath);
    await syncNativeHarnessDirectory(dirname(input.targetPath));
    installed = true;
  } catch (error) {
    if (moved && !installed) { try { await rename(previous, input.targetPath); moved = false; } catch { /* Preserve the previous checkpoint in its private staging root. */ } }
    throw error;
  } finally {
    if (owned) await remote(input.runner, `rm -rf -- ${quote(scratch)}`).catch(() => undefined);
    if (!moved || installed) await rm(local, { recursive: true, force: true });
  }
}
