import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CursorCloudCheckpointStore } from "./checkpoint.js";

export const CURSOR_CLOUD_STAGING_MAX_BYTES = 268_435_456;
export const CURSOR_CLOUD_STAGING_MAX_ALLOCATIONS = 256;
const queues = new Map<string, Promise<void>>();
type Budget = { schema: "paperclip.cursor-cloud.artifact-budget.v1"; allocations: number; reservedBytes: number };
const denied = () => new Error("Cursor Cloud artifact staging budget is exhausted or cannot be verified");
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const privateEntry = (value: Stats) => (value.mode & 0o077) === 0 && (!process.getuid || value.uid === process.getuid());
async function present(path: string): Promise<Stats | null> {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function privateDirectory(path: string): Promise<Stats> {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink() || !privateEntry(value)) throw denied();
  return value;
}
async function seedBudget(artifactRoot: string): Promise<Budget> {
  const result: Budget = { schema: "paperclip.cursor-cloud.artifact-budget.v1", allocations: 0, reservedBytes: 0 };
  const root = await present(artifactRoot);
  if (!root) return result;
  await privateDirectory(artifactRoot);
  let directories = 0;
  for await (const entry of await opendir(artifactRoot)) {
    if (++directories > CURSOR_CLOUD_STAGING_MAX_ALLOCATIONS || !/^[a-f0-9]{64}$/.test(entry.name)) throw denied();
    const path = join(artifactRoot, entry.name), before = await privateDirectory(path);
    let count = 0;
    for await (const file of await opendir(path)) {
      if (++result.allocations > CURSOR_CLOUD_STAGING_MAX_ALLOCATIONS) throw denied();
      const value = await lstat(join(path, file.name));
      if (!value.isFile() || value.isSymbolicLink() || !privateEntry(value) || value.size > 16_777_216) throw denied();
      result.reservedBytes += value.size; count++;
      if (result.reservedBytes > CURSOR_CLOUD_STAGING_MAX_BYTES) throw denied();
    }
    if (!count && ++result.allocations > CURSOR_CLOUD_STAGING_MAX_ALLOCATIONS) throw denied();
    if (!same(before, await privateDirectory(path))) throw denied();
  }
  if (!same(root, await privateDirectory(artifactRoot))) throw denied();
  return result;
}
async function readBudget(path: string, artifactRoot: string): Promise<{ budget: Budget; identity: Stats | null }> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { budget: await seedBudget(artifactRoot), identity: null }; throw error; }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !privateEntry(before) || before.size > 1_024) throw denied();
    const value = JSON.parse(await handle.readFile("utf8")) as Budget;
    const after = await lstat(path);
    if (!same(before, after) || !after.isFile() || !privateEntry(after) || after.nlink !== 1
      || value?.schema !== "paperclip.cursor-cloud.artifact-budget.v1"
      || Object.keys(value).sort().join(",") !== "allocations,reservedBytes,schema"
      || !Number.isSafeInteger(value.allocations) || value.allocations < 0 || value.allocations > CURSOR_CLOUD_STAGING_MAX_ALLOCATIONS
      || !Number.isSafeInteger(value.reservedBytes) || value.reservedBytes < 0 || value.reservedBytes > CURSOR_CLOUD_STAGING_MAX_BYTES) throw denied();
    return { budget: value, identity: before };
  } finally { await handle.close(); }
}
async function saveBudget(directory: string, path: string, before: Stats | null, value: Budget): Promise<void> {
  const temporary = join(directory, "usage.pending.tmp");
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let owned: Stats | undefined;
  try {
    owned = await handle.stat();
    await handle.writeFile(JSON.stringify(value)); await handle.sync();
    const current = await present(path), temp = await lstat(temporary);
    if ((before ? !current || !same(before, current) || !current.isFile() || !privateEntry(current) || current.nlink !== 1 : current !== null)
      || !same(owned, temp) || !temp.isFile() || !privateEntry(temp) || temp.nlink !== 1) throw denied();
    await rename(temporary, path);
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    await handle.close();
    const current = await present(temporary);
    if (current) {
      if (!owned || !same(owned, current) || !current.isFile() || !privateEntry(current) || current.nlink !== 1) throw denied();
      await unlink(temporary);
    }
  }
}

export async function reserveCursorCloudArtifactStaging(input: {
  runtimeDirectory: string; artifactRoot: string; byteSize: number; signal: AbortSignal;
}): Promise<void> {
  input.signal.throwIfAborted();
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0 || input.byteSize > 16_777_216) throw denied();
  const preceding = queues.get(input.runtimeDirectory) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const queued = preceding.then(() => held);
  queues.set(input.runtimeDirectory, queued);
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(input.signal.reason ?? new Error("Cursor Cloud artifact staging cancelled"));
    input.signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([preceding, cancelled]); input.signal.throwIfAborted();
    await privateDirectory(input.runtimeDirectory);
    const directory = join(input.runtimeDirectory, ".artifact-staging-budget");
    const lock = new CursorCloudCheckpointStore(directory, "budget");
    await lock.acquire();
    try {
      input.signal.throwIfAborted();
      const path = join(directory, "usage.json"), prior = await readBudget(path, input.artifactRoot);
      if (prior.budget.allocations >= CURSOR_CLOUD_STAGING_MAX_ALLOCATIONS
        || prior.budget.reservedBytes + input.byteSize > CURSOR_CLOUD_STAGING_MAX_BYTES) throw denied();
      const next = { ...prior.budget, allocations: prior.budget.allocations + 1, reservedBytes: prior.budget.reservedBytes + input.byteSize };
      input.signal.throwIfAborted();
      await saveBudget(directory, path, prior.identity, next);
      const root = await open(input.runtimeDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await root.sync(); } finally { await root.close(); }
      input.signal.throwIfAborted();
    } finally { await lock.release(); }
  } finally {
    input.signal.removeEventListener("abort", abort); release();
    void queued.then(() => { if (queues.get(input.runtimeDirectory) === queued) queues.delete(input.runtimeDirectory); });
  }
}
