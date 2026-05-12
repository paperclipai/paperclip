import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

type SnapshotEntry =
  | { kind: "dir" }
  | { kind: "file"; mode: number; hash: string }
  | { kind: "symlink"; target: string };

export interface DirectorySnapshot {
  exclude: string[];
  entries: Map<string, SnapshotEntry>;
}

function isRelativePathOrDescendant(relative: string, candidate: string): boolean {
  return relative === candidate || relative.startsWith(`${candidate}/`);
}

function shouldExclude(relative: string, exclude: readonly string[]): boolean {
  return exclude.some((candidate) => isRelativePathOrDescendant(relative, candidate));
}

async function hashFile(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function walkDirectory(
  root: string,
  exclude: readonly string[],
  relative = "",
  out: Map<string, SnapshotEntry> = new Map(),
): Promise<Map<string, SnapshotEntry>> {
  const current = relative ? path.join(root, relative) : root;
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const nextRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (shouldExclude(nextRelative, exclude)) continue;

    const fullPath = path.join(root, nextRelative);
    const stats = await fs.lstat(fullPath);
    if (stats.isDirectory()) {
      out.set(nextRelative, { kind: "dir" });
      await walkDirectory(root, exclude, nextRelative, out);
      continue;
    }

    if (stats.isSymbolicLink()) {
      out.set(nextRelative, {
        kind: "symlink",
        target: await fs.readlink(fullPath),
      });
      continue;
    }

    out.set(nextRelative, {
      kind: "file",
      mode: stats.mode,
      hash: await hashFile(fullPath),
    });
  }

  return out;
}

async function readSnapshotEntry(root: string, relative: string): Promise<SnapshotEntry | null> {
  const fullPath = path.join(root, relative);
  let stats;
  try {
    stats = await fs.lstat(fullPath);
  } catch {
    return null;
  }

  if (stats.isDirectory()) return { kind: "dir" };
  if (stats.isSymbolicLink()) {
    return {
      kind: "symlink",
      target: await fs.readlink(fullPath),
    };
  }
  return {
    kind: "file",
    mode: stats.mode,
    hash: await hashFile(fullPath),
  };
}

function entriesMatch(left: SnapshotEntry | null | undefined, right: SnapshotEntry | null | undefined): boolean {
  if (!left || !right) return false;
  if (left.kind !== right.kind) return false;
  if (left.kind === "dir") return true;
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target;
  }
  if (left.kind === "file" && right.kind === "file") {
    return left.mode === right.mode && left.hash === right.hash;
  }
  return false;
}

async function isHolderAlive(lockDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(lockDir, "owner.json"), "utf8");
    const owner = JSON.parse(raw) as { pid?: unknown };
    const pid = typeof owner.pid === "number" && Number.isFinite(owner.pid) && owner.pid > 0 ? owner.pid : null;
    if (pid === null) {
      // Owner record is unparseable / missing pid — treat as stale.
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    // owner.json missing or unreadable — treat as stale.
    return false;
  }
}

async function acquireDirectoryMergeLock(lockDir: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      return async () => {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      };
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
      if (code !== "EEXIST") throw error;
      // Stale-lock detection: if the owner PID is dead (SIGKILL / OOM / crash),
      // the lockDir would otherwise persist forever and stall restores. Mirror
      // the materializePaperclipSkillCopy lock pattern — remove and retry.
      if (!(await isHolderAlive(lockDir))) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for workspace restore lock at ${lockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function withDirectoryMergeLock<T>(
  targetDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const releaseLock = await acquireDirectoryMergeLock(`${targetDir}.paperclip-restore.lock`);
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

async function copySnapshotEntry(sourceDir: string, targetDir: string, relative: string, entry: SnapshotEntry): Promise<void> {
  const sourcePath = path.join(sourceDir, relative);
  const targetPath = path.join(targetDir, relative);

  if (entry.kind === "dir") {
    const existing = await fs.lstat(targetPath).catch(() => null);
    if (existing?.isDirectory()) {
      return;
    }
    if (existing) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.mkdir(targetPath, { recursive: true });
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
  if (entry.kind === "symlink") {
    await fs.symlink(entry.target, targetPath);
    return;
  }

  await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE).catch(async () => {
    await fs.copyFile(sourcePath, targetPath);
  });
  await fs.chmod(targetPath, entry.mode);
}

export async function captureDirectorySnapshot(
  rootDir: string,
  options: { exclude?: string[] } = {},
): Promise<DirectorySnapshot> {
  const exclude = [...new Set(options.exclude ?? [])];
  return {
    exclude,
    entries: await walkDirectory(rootDir, exclude),
  };
}

export async function mergeDirectoryWithBaseline(input: {
  baseline: DirectorySnapshot;
  sourceDir: string;
  targetDir: string;
  beforeApply?: () => Promise<void>;
}): Promise<void> {
  const source = await captureDirectorySnapshot(input.sourceDir, { exclude: input.baseline.exclude });
  await withDirectoryMergeLock(input.targetDir, async () => {
    await input.beforeApply?.();
    const current = await captureDirectorySnapshot(input.targetDir, { exclude: input.baseline.exclude });
    const deletedLeafEntries = [...input.baseline.entries.entries()]
      .filter(([relative, entry]) => entry.kind !== "dir" && !source.entries.has(relative))
      .sort(([left], [right]) => right.length - left.length);

    for (const [relative, baselineEntry] of deletedLeafEntries) {
      if (!entriesMatch(current.entries.get(relative), baselineEntry)) continue;
      await fs.rm(path.join(input.targetDir, relative), { recursive: true, force: true }).catch(() => undefined);
    }

    const deletedDirs = [...input.baseline.entries.entries()]
      .filter(([relative, entry]) => entry.kind === "dir" && !source.entries.has(relative))
      .sort(([left], [right]) => right.length - left.length);

    for (const [relative] of deletedDirs) {
      await fs.rmdir(path.join(input.targetDir, relative)).catch(() => undefined);
    }

    const changedSourceEntries = [...source.entries.entries()]
      .filter(([relative, entry]) => !entriesMatch(input.baseline.entries.get(relative), entry))
      .sort(([left], [right]) => left.localeCompare(right));

    for (const [relative, entry] of changedSourceEntries) {
      await copySnapshotEntry(input.sourceDir, input.targetDir, relative, entry);
    }
  });
}

export async function directoryEntryMatchesBaseline(
  rootDir: string,
  relative: string,
  baselineEntry: SnapshotEntry,
): Promise<boolean> {
  return entriesMatch(await readSnapshotEntry(rootDir, relative), baselineEntry);
}
