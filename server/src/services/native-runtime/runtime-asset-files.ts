import fs from "node:fs/promises";
import path from "node:path";

export const MAX_ASSET_FILES = 10_000;
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
export type AssetFile = { path: string; content: Buffer; mode: number };

const FILE_CONCURRENCY = 8;
let activeFiles = 0;
const waitingFiles: Array<() => void> = [];
async function withFileIo<T>(action: () => Promise<T>): Promise<T> {
  if (activeFiles >= FILE_CONCURRENCY) await new Promise<void>(resolve => waitingFiles.push(resolve));
  else activeFiles++;
  try { return await action(); }
  finally { const next = waitingFiles.shift(); if (next) next(); else activeFiles--; }
}

async function forFiles<T>(items: readonly T[], action: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(FILE_CONCURRENCY, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { await withFileIo(() => action(items[index]!, index)); }
      catch (error) { failed = true; throw error; }
    }
  }));
  // Do not let cleanup race writes still owned by sibling workers after a failure.
  const rejected = outcomes.find(outcome => outcome.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
}

export const safeRelativePath = (value: string, label: string) => {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must stay within its bundle root`);
  }
  return normalized;
};

export async function collectDirectoryFiles(sourceRoot: string): Promise<AssetFile[]> {
  const root = path.resolve(sourceRoot);
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`runtime context source is not a safe directory: ${root}`);
  const candidates: string[] = [];
  async function visit(relativeDirectory: string): Promise<void> {
    const entries = await fs.readdir(relativeDirectory ? path.join(root, relativeDirectory) : root, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = safeRelativePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name, "runtime context path");
      if (entry.isSymbolicLink()) throw new Error(`runtime context bundles do not permit symlinks: ${relativePath}`);
      if (entry.isDirectory()) {
        const stat = await fs.lstat(path.join(root, relativePath));
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`runtime context source is not a safe directory: ${relativePath}`);
        await visit(relativePath);
      } else {
        if (!entry.isFile()) throw new Error(`runtime context bundle contains an unsupported file: ${relativePath}`);
        candidates.push(relativePath);
        if (candidates.length > MAX_ASSET_FILES) throw new Error("runtime context bundle exceeds its bound");
      }
    }
  }
  await visit("");
  if (!candidates.length) throw new Error(`runtime context source is empty: ${root}`);
  const files: AssetFile[] = new Array(candidates.length);
  let expectedBytes = 0;
  let totalBytes = 0;
  await forFiles(candidates, async (relativePath, index) => {
    const absolutePath = path.join(root, relativePath);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`runtime context bundles do not permit symlinks: ${relativePath}`);
    if (!stat.isFile()) throw new Error(`runtime context bundle contains an unsupported file: ${relativePath}`);
    expectedBytes += stat.size;
    if (expectedBytes > MAX_ASSET_BYTES) throw new Error("runtime context bundle exceeds its bound");
    const content = await fs.readFile(absolutePath);
    totalBytes += content.byteLength;
    if (totalBytes > MAX_ASSET_BYTES) throw new Error("runtime context bundle exceeds its bound");
    files[index] = { path: relativePath, content, mode: stat.mode & 0o555 };
  });
  return files;
}

export async function writeAssetFiles(stagingRoot: string, files: readonly AssetFile[]): Promise<void> {
  const directories = [...new Set(files.map(file => path.dirname(path.join(stagingRoot, file.path))))];
  await forFiles(directories, async directory => { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); });
  await forFiles(files, async file => {
    const target = path.join(stagingRoot, file.path);
    await fs.writeFile(target, file.content, { mode: file.mode & 0o555 });
    await fs.chmod(target, file.mode & 0o555);
  });
}

export async function makeDirectoriesReadOnly(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeDirectoriesReadOnly(path.join(directory, entry.name));
  }
  await fs.chmod(directory, 0o555);
}
