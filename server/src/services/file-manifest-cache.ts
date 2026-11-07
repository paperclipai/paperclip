import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

export type FileManifestEntry = { path: string; size: number; sha256: string; executable: boolean; mode?: number };

// Cache only identities/digests, not file contents. ctime prevents an ordinary
// writer from hiding a modification by restoring mtime. Every use still checks
// paths, file types, count and mode; changed files are hashed again.
const verifiedFiles = new Map<string, { signature: string; digest: string }>();
const MAX_VERIFIED_FILES = 128_000;
let activeFileIo = 0;
const waitingFileIo: Array<() => void> = [];
async function withFileIo<T>(action: () => Promise<T>): Promise<T> {
  if (activeFileIo >= 24) await new Promise<void>(resolve => waitingFileIo.push(resolve));
  else activeFileIo++;
  try { return await action(); }
  finally { const next = waitingFileIo.shift(); if (next) next(); else activeFileIo--; }
}
/** Rename preserves file identities; carry verification forward to avoid
 * re-reading every byte on the first warm turn after a cold materialization. */
export function relocateFileManifestVerification(from: string, to: string, files: readonly FileManifestEntry[]) {
  for (const file of files) {
    const source = path.join(from, file.path);
    const verified = verifiedFiles.get(source);
    verifiedFiles.delete(source);
    if (verified) verifiedFiles.set(path.join(to, file.path), verified);
  }
}
export async function verifyFileManifest(directory: string, files: readonly FileManifestEntry[]): Promise<boolean> {
  const expected = new Map(files.map(file => [file.path, file]));
  const seen = new Set<string>();
  async function walk(relative: string): Promise<boolean> {
    const root = path.join(directory, relative);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (let offset = 0; offset < entries.length; offset += 24) {
      const outcomes = await Promise.all(entries.slice(offset, offset + 24).map(async entry => {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return walk(name);
        const file = expected.get(name);
        if (!file || !entry.isFile()) return false;
        seen.add(name);
        return withFileIo(async () => {
          const target = path.join(directory, name);
          const stat = await fs.lstat(target, { bigint: true });
          if (!stat.isFile() || stat.size !== BigInt(file.size) || Boolean(stat.mode & 0o111n) !== file.executable
            || (file.mode !== undefined && Number(stat.mode & 0o555n) !== file.mode)) return false;
          const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
          const previous = verifiedFiles.get(target);
          if (previous?.signature === signature && previous.digest === file.sha256) return true;
          const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const before = await handle.stat({ bigint: true });
            if (before.ino !== stat.ino || before.ctimeNs !== stat.ctimeNs) return false;
            const hash = createHash("sha256");
            for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
            if (hash.digest("hex") !== file.sha256) return false;
            const after = await handle.stat({ bigint: true });
            if (after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs) return false;
            if (verifiedFiles.size >= MAX_VERIFIED_FILES) verifiedFiles.delete(verifiedFiles.keys().next().value!);
            verifiedFiles.set(target, { signature, digest: file.sha256 });
            return true;
          } finally { await handle.close(); }
        });
      }));
      if (outcomes.some(result => !result)) return false;
    }
    return true;
  }
  try { return await walk("") && seen.size === expected.size; }
  catch (error) { if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
}
