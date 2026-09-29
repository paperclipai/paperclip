import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { readIndexedLocalState } from "../control-plane/indexed-local-state-reader.js";
import { nativeStorageCommand } from "../control-plane/native-storage-command.js";
import { authorityGeneration } from "../control-plane/durable-authority-store.js";

const files = ["runner-state.sqlite", "runner-state.sqlite-wal", "runner-state.sqlite-shm", "runner-state.sqlite.receipts", "runner-state.sqlite.routing", "runner-state.json"];
type Transfer = { schema: "paperclip.runner.indexed-archive.v1"; generation: string; stateSha256: string; files: string[] };

function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("native_indexed_archive_unsafe");
}

export function syncArchiveDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function privateRegular(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("native_indexed_archive_unsafe");
}

/** Publish before moving the active controller directory. This is a bounded
 * routing hint; the caller must still validate the archived authority binding. */
export function publishIndexedArchiveHead(archive: string): void {
  const root = dirname(archive);
  privateDirectory(root);
  privateDirectory(archive);
  const name = basename(archive);
  if (!/^epoch-[a-f0-9]{24}$/.test(name)) throw new Error("native_indexed_archive_invalid");
  const target = resolve(root, "current-archive.json");
  if (existsSync(target)) privateRegular(target);
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ schema: "paperclip.runner.indexed-archive-head.v1", archive: name }), { mode: 0o600, flag: "wx", flush: true });
  renameSync(temporary, target);
  syncArchiveDirectory(root);
}

/** Once a head exists, missing/corrupt current routing fails closed. It must
 * never fall back to choosing an older archive by timestamp or scanning. */
export function readIndexedArchiveHead(archivesRoot: string): string | null {
  const path = resolve(archivesRoot, "current-archive.json");
  // lstat distinguishes an absent pointer from a dangling symlink.
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  privateDirectory(archivesRoot);
  privateRegular(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024) throw new Error("native_indexed_archive_invalid");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("native_indexed_archive_changed");
      offset += count;
    }
    const value = JSON.parse(bytes.toString()) as { schema?: unknown; archive?: unknown };
    if (value.schema !== "paperclip.runner.indexed-archive-head.v1" || typeof value.archive !== "string" || !/^epoch-[a-f0-9]{24}$/.test(value.archive)) throw new Error("native_indexed_archive_invalid");
    const archive = resolve(archivesRoot, value.archive);
    privateDirectory(archive);
    return archive;
  } finally { closeSync(fd); }
}

function readTransfer(archive: string): Transfer | null {
  const path = resolve(archive, "runner-transfer.json");
  if (!existsSync(path)) return null;
  privateDirectory(archive);
  privateRegular(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw new Error("native_indexed_archive_unsafe");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("native_indexed_archive_changed");
      offset += count;
    }
    const value = JSON.parse(bytes.toString()) as Transfer;
    if (typeof value.generation !== "string") throw new Error("native_indexed_archive_invalid");
    try { authorityGeneration(value.generation); } catch { throw new Error("native_indexed_archive_invalid"); }
    if (value.schema !== "paperclip.runner.indexed-archive.v1" || value.generation === "0" ||
        !/^[a-f0-9]{64}$/.test(value.stateSha256) || !Array.isArray(value.files) ||
        value.files.length < 2 || value.files.length > files.length || new Set(value.files).size !== value.files.length ||
        !value.files.includes("runner-state.sqlite") || !value.files.includes("runner-state.json") || value.files.some(file => !files.includes(file))) throw new Error("native_indexed_archive_invalid");
    return value;
  } finally { closeSync(fd); }
}

/** Only called after the existing caller proves a suspended, exclusively owned
 * runner. The intent survives a crash between renames of SQLite companion files. */
export async function prepareIndexedRunnerArchive(runner: string, archive: string, runnerBinary?: string): Promise<void> {
  privateDirectory(runner);
  privateDirectory(archive);
  const snapshot = await readIndexedLocalState(resolve(runner, "runner-state.json"), { runnerBinary });
  if (snapshot.state.lifecycle !== "suspended") throw new Error("native_indexed_archive_unsettled");
  await nativeStorageCommand(["archive-prepare", "--directory", runner, "--destination", archive,
    "--generation", snapshot.generation, "--digest", snapshot.stateDigest], runnerBinary);
}

/** The controller directory must already have moved durably. The native owner
 * completes the fixed renames while holding both store lifetime fences. */
export async function finishIndexedRunnerArchive(runner: string, archive: string, runnerBinary?: string): Promise<boolean> {
  if (!readTransfer(archive)) return false;
  await nativeStorageCommand(["archive-finish", "--directory", runner, "--destination", archive], runnerBinary);
  return true;
}
