import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_RESTORE_POINT_LIMITS } from "./git-restore-point.js";

export const TASK_DIRECTORY_RETENTION_KEY = "isolatedTaskDirectoryRetention";
export const TASK_DIRECTORY_SNAPSHOT_SCHEMA = "paperclip.task-directory-snapshot.v1";
const PAYLOAD_MAGIC = Buffer.from("PCTD-PLAIN1\n");
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

export type TaskDirectorySnapshotLimits = { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };

export const DEFAULT_TASK_DIRECTORY_SNAPSHOT_LIMITS: TaskDirectorySnapshotLimits = {
  maxFiles: DEFAULT_RESTORE_POINT_LIMITS.maxFiles,
  maxFileBytes: DEFAULT_RESTORE_POINT_LIMITS.maxFileBytes,
  maxTotalBytes: DEFAULT_RESTORE_POINT_LIMITS.maxTotalBytes,
};

export type TaskDirectoryEntry =
  | { path: string; type: "directory"; mode: number }
  | { path: string; type: "file"; mode: number; size: number; sha256: string }
  | { path: string; type: "symlink"; target: string };

export type TaskDirectorySnapshotManifest = {
  schema: typeof TASK_DIRECTORY_SNAPSHOT_SCHEMA;
  entries: TaskDirectoryEntry[];
  excluded: string[];
};

export class TaskDirectorySnapshotSkip extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "TaskDirectorySnapshotSkip";
  }
}

export class TaskDirectoryRestoreFailure extends Error {
  constructor(readonly reason: string) {
    super(`The task directory could not be restored: ${reason}`);
    this.name = "TaskDirectoryRestoreFailure";
  }
}

const bySortKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type WalkOptions = {
  limits: TaskDirectorySnapshotLimits;
  signal?: AbortSignal;
  readFile: (absolute: string, relative: string, size: number) => Promise<string>;
};

async function walk(root: string, options: WalkOptions) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TaskDirectorySnapshotSkip("unsafe_task_directory");
  const entries: TaskDirectoryEntry[] = [];
  const excluded: string[] = [];
  let files = 0;
  let total = 0;
  let newestMtimeMs = rootStat.mtimeMs;
  const visit = async (relativeDir: string) => {
    options.signal?.throwIfAborted();
    const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
    const names = (await fs.readdir(absoluteDir)).sort(bySortKey);
    const hasPackageManifest = names.includes("package.json")
      && (await fs.lstat(path.join(absoluteDir, "package.json"))).isFile();
    for (const name of names) {
      options.signal?.throwIfAborted();
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      const absolute = path.join(absoluteDir, name);
      const stat = await fs.lstat(absolute);
      newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
      if (stat.isSymbolicLink()) {
        entries.push({ path: relative, type: "symlink", target: await fs.readlink(absolute) });
        continue;
      }
      if (stat.isDirectory()) {
        if (name === "node_modules" && hasPackageManifest) {
          excluded.push(relative);
          continue;
        }
        entries.push({ path: relative, type: "directory", mode: stat.mode & 0o777 });
        await visit(relative);
        continue;
      }
      if (!stat.isFile()) throw new TaskDirectorySnapshotSkip("unsupported_filesystem_entry");
      files += 1;
      total += stat.size;
      if (files > options.limits.maxFiles) throw new TaskDirectorySnapshotSkip("task_directory_too_many_files");
      if (stat.size > options.limits.maxFileBytes) throw new TaskDirectorySnapshotSkip("task_directory_file_too_large");
      if (total > options.limits.maxTotalBytes) throw new TaskDirectorySnapshotSkip("task_directory_too_large");
      entries.push({ path: relative, type: "file", mode: stat.mode & 0o777, size: stat.size,
        sha256: await options.readFile(absolute, relative, stat.size) });
    }
  };
  await visit("");
  return { entries, excluded, newestMtimeMs };
}

export function taskDirectoryManifestDigest(manifest: Pick<TaskDirectorySnapshotManifest, "entries">) {
  return createHash("sha256").update(JSON.stringify([TASK_DIRECTORY_SNAPSHOT_SCHEMA, manifest.entries])).digest("hex");
}

async function hashFile(absolute: string, size: number) {
  const handle = await fs.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    let read = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      read += (chunk as Buffer).length;
      hash.update(chunk as Buffer);
    }
    if (read !== size) throw new TaskDirectorySnapshotSkip("task_directory_changed");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function inspectTaskDirectory(root: string, options: { limits?: TaskDirectorySnapshotLimits; signal?: AbortSignal } = {}) {
  const walked = await walk(root, { limits: options.limits ?? DEFAULT_TASK_DIRECTORY_SNAPSHOT_LIMITS, signal: options.signal,
    readFile: (absolute, _relative, size) => hashFile(absolute, size) });
  return { digest: taskDirectoryManifestDigest(walked), entries: walked.entries.length, excluded: walked.excluded.length,
    newestMtimeMs: walked.newestMtimeMs };
}

export async function newestTaskDirectoryMtime(root: string, signal?: AbortSignal): Promise<number> {
  const stat = await fs.lstat(root);
  let newest = stat.mtimeMs;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return newest;
  for (const name of await fs.readdir(root)) {
    signal?.throwIfAborted();
    newest = Math.max(newest, await newestTaskDirectoryMtime(path.join(root, name), signal));
  }
  return newest;
}

export async function captureTaskDirectorySnapshot(root: string, options: { limits?: TaskDirectorySnapshotLimits; signal?: AbortSignal } = {}) {
  const bodies: Buffer[] = [];
  const walked = await walk(root, { limits: options.limits ?? DEFAULT_TASK_DIRECTORY_SNAPSHOT_LIMITS, signal: options.signal,
    readFile: async (absolute, _relative, size) => {
      const handle = await fs.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const body = await handle.readFile();
        if (body.length !== size) throw new TaskDirectorySnapshotSkip("task_directory_changed");
        bodies.push(body);
        return createHash("sha256").update(body).digest("hex");
      } finally {
        await handle.close();
      }
    } });
  const manifest: TaskDirectorySnapshotManifest = { schema: TASK_DIRECTORY_SNAPSHOT_SCHEMA, entries: walked.entries, excluded: walked.excluded };
  const encoded = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  const payload = Buffer.concat([PAYLOAD_MAGIC, length, encoded, ...bodies]);
  try { decodeTaskDirectorySnapshot(payload); }
  catch { throw new TaskDirectorySnapshotSkip("task_directory_not_restorable"); }
  return {
    payload,
    digest: taskDirectoryManifestDigest(manifest),
    files: walked.entries.filter(entry => entry.type === "file").length,
    excluded: walked.excluded.length,
  };
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) return false;
  if (path.sep !== "/" && value.includes(path.sep)) return false;
  if (value.startsWith("/")) return false;
  return value.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

export function decodeTaskDirectorySnapshot(payload: Buffer): { manifest: TaskDirectorySnapshotManifest; bodies: Buffer } {
  if (payload.length < PAYLOAD_MAGIC.length + 4 || !payload.subarray(0, PAYLOAD_MAGIC.length).equals(PAYLOAD_MAGIC)) {
    throw new TaskDirectoryRestoreFailure("invalid_snapshot_payload");
  }
  const length = payload.readUInt32BE(PAYLOAD_MAGIC.length);
  const start = PAYLOAD_MAGIC.length + 4;
  if (length > MAX_MANIFEST_BYTES || start + length > payload.length) throw new TaskDirectoryRestoreFailure("invalid_snapshot_payload");
  let manifest: TaskDirectorySnapshotManifest;
  try { manifest = JSON.parse(payload.subarray(start, start + length).toString("utf8")); }
  catch { throw new TaskDirectoryRestoreFailure("invalid_snapshot_payload"); }
  if (!manifest || manifest.schema !== TASK_DIRECTORY_SNAPSHOT_SCHEMA || !Array.isArray(manifest.entries) || !Array.isArray(manifest.excluded)) {
    throw new TaskDirectoryRestoreFailure("invalid_snapshot_payload");
  }
  const kinds = new Map<string, TaskDirectoryEntry["type"]>();
  let bodyBytes = 0;
  for (const entry of manifest.entries) {
    if (!entry || !validRelativePath(entry.path) || kinds.has(entry.path)) throw new TaskDirectoryRestoreFailure("invalid_snapshot_entry");
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : null;
    if (parent !== null && kinds.get(parent) !== "directory") throw new TaskDirectoryRestoreFailure("invalid_snapshot_entry");
    if (entry.type === "file") {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256)
        || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new TaskDirectoryRestoreFailure("invalid_snapshot_entry");
      bodyBytes += entry.size;
    } else if (entry.type === "directory") {
      if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new TaskDirectoryRestoreFailure("invalid_snapshot_entry");
    } else if (entry.type !== "symlink" || typeof entry.target !== "string" || entry.target.length === 0 || entry.target.includes("\0")) {
      throw new TaskDirectoryRestoreFailure("invalid_snapshot_entry");
    }
    kinds.set(entry.path, entry.type);
  }
  if (manifest.excluded.some(value => !validRelativePath(value))) throw new TaskDirectoryRestoreFailure("invalid_snapshot_entry");
  const bodies = payload.subarray(start + length);
  if (bodies.length !== bodyBytes) throw new TaskDirectoryRestoreFailure("invalid_snapshot_payload");
  return { manifest, bodies };
}

export function shortSiblingName(target: string, prefix: string) {
  const length = Math.max(8, path.basename(target).length - prefix.length);
  return path.join(path.dirname(target), `${prefix}${randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length)}`);
}

export async function materializeTaskDirectorySnapshot(input: { payload: Buffer; target: string; expectedDigest: string; signal?: AbortSignal }) {
  const { manifest, bodies } = decodeTaskDirectorySnapshot(input.payload);
  if (taskDirectoryManifestDigest(manifest) !== input.expectedDigest) throw new TaskDirectoryRestoreFailure("snapshot_digest_mismatch");
  const staging = shortSiblingName(input.target, ".restoring-");
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    let offset = 0;
    const directories: Array<{ target: string; mode: number }> = [];
    for (const entry of manifest.entries) {
      input.signal?.throwIfAborted();
      const target = path.join(staging, ...entry.path.split("/"));
      if (entry.type === "directory") {
        await fs.mkdir(target, { mode: 0o700 });
        directories.push({ target, mode: entry.mode });
      } else if (entry.type === "symlink") {
        await fs.symlink(entry.target, target);
      } else {
        const body = bodies.subarray(offset, offset + entry.size);
        offset += entry.size;
        if (createHash("sha256").update(body).digest("hex") !== entry.sha256) throw new TaskDirectoryRestoreFailure("snapshot_content_mismatch");
        const handle = await fs.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(body); } finally { await handle.close(); }
        await fs.chmod(target, entry.mode);
      }
    }
    for (const directory of directories.reverse()) await fs.chmod(directory.target, directory.mode);
    const restored = await inspectTaskDirectory(staging, { limits: { maxFiles: Number.MAX_SAFE_INTEGER, maxFileBytes: Number.MAX_SAFE_INTEGER,
      maxTotalBytes: Number.MAX_SAFE_INTEGER }, signal: input.signal });
    if (restored.digest !== input.expectedDigest) throw new TaskDirectoryRestoreFailure("restored_contents_mismatch");
    return staging;
  } catch (error) {
    await removeTaskDirectoryTree(staging).catch(() => undefined);
    throw error;
  }
}

export async function removeTaskDirectoryTree(target: string) {
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe_task_directory_trash");
  const makeWritable = async (directory: string) => {
    await fs.chmod(directory, 0o700);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeWritable(path.join(directory, entry.name));
    }
  };
  await makeWritable(target).catch(() => undefined);
  await fs.rm(target, { recursive: true, force: true });
}
