import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

export interface KimiRuntimeFile { path: string; sha256: string; size: number; executable: boolean }
const MAX_FILES = 30_000;
const MAX_FILE_BYTES = 384 * 1024 * 1024;
const MAX_TREE_BYTES = 1024 * 1024 * 1024;
const HASH_CONCURRENCY = 16;
const safePath = (path: string) => !/[\u0000-\u001f\u007f\\]/.test(path) && path.split("/").every(part => part !== "" && part !== "." && part !== "..");

export function kimiRuntimeClosureDigest(entries: readonly KimiRuntimeFile[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export async function inventoryKimiRuntimeFiles(root: string): Promise<KimiRuntimeFile[]> {
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error("Kimi runtime root is not a physical directory");
  const files: { path: string; size: number; executable: boolean }[] = [];
  let total = 0;
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!safePath(path) || path.startsWith(".paperclip-") || path === "manifest.json") throw new Error("Kimi runtime contains an invalid path");
      const absolute = join(directory, name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error("Kimi runtime contains a symbolic link");
      if (stat.isDirectory()) await visit(absolute, path);
      else {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error("Kimi runtime contains an invalid file");
        total += stat.size;
        if (files.length >= MAX_FILES || total > MAX_TREE_BYTES) throw new Error("Kimi runtime inventory exceeds its bound");
        files.push({ path, size: stat.size, executable: Boolean(stat.mode & 0o111) });
      }
    }
  };
  await visit(root);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const entries: KimiRuntimeFile[] = [];
  for (let index = 0; index < files.length; index += HASH_CONCURRENCY) {
    const batch = await Promise.allSettled(files.slice(index, index + HASH_CONCURRENCY).map(async entry => {
      const path = join(root, entry.path);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(entry.size) || Boolean(before.mode & 0o111n) !== entry.executable) throw new Error("Kimi runtime file changed before inventory");
        const digest = createHash("sha256");
        for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
        const after = await file.stat({ bigint: true });
        const named = await lstat(path, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()) throw new Error("Kimi runtime file changed during inventory");
        return { path: entry.path, sha256: digest.digest("hex"), size: entry.size, executable: entry.executable };
      } finally { await file.close(); }
    }));
    const failed = batch.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    for (const result of batch) if (result.status === "fulfilled") entries.push(result.value);
  }
  return entries;
}
