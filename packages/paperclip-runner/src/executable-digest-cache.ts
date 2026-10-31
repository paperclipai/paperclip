import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

export interface ExecutableFileIdentity {
  device: string;
  inode: string;
  size: string;
  modifiedNanoseconds: string;
  changedNanoseconds: string;
}

export function createExecutableDigestCache(directory?: string) {
  async function location(identity: ExecutableFileIdentity, create: boolean): Promise<string> {
    const user = userInfo();
    const temporaryRoot = tmpdir();
    if (!isAbsolute(directory ?? temporaryRoot)) throw new Error("Executable digest cache directory is unavailable");
    const base = join(temporaryRoot, `paperclip-runner-${user.uid}`);
    const directories = directory ? [directory] : [base, join(base, "executable-digests-v1")];
    for (const [index, path] of directories.entries()) {
      if (create) await mkdir(path, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== user.uid ||
          (metadata.mode & (index === directories.length - 1 ? 0o077 : 0o022)) !== 0) {
        throw new Error("Executable digest cache directory is unavailable");
      }
    }
    const key = createHash("sha256").update(JSON.stringify([1, identity.device, identity.inode, identity.size,
      identity.modifiedNanoseconds, identity.changedNanoseconds])).digest("hex");
    return join(directories.at(-1)!, `v1-${key}.json`);
  }

  return {
    async read(identity: ExecutableFileIdentity): Promise<string | null> {
      try {
        const path = await location(identity, false);
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile() || metadata.uid !== userInfo().uid || (metadata.mode & 0o077) !== 0 ||
              metadata.size < 1 || metadata.size > 1024) return null;
          const entry: unknown = JSON.parse(await handle.readFile("utf8"));
          if (typeof entry !== "object" || entry === null || !("version" in entry) || entry.version !== 1 ||
              !("digest" in entry) || typeof entry.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry.digest)) return null;
          return entry.digest;
        } finally { await handle.close(); }
      } catch { return null; }
    },
    async write(identity: ExecutableFileIdentity, digest: string): Promise<void> {
      let temporary: string | undefined;
      try {
        if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return;
        const path = await location(identity, true);
        temporary = `${path}.${randomUUID()}.tmp`;
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, digest })); }
        finally { await handle.close(); }
        await rename(temporary, path);
      } catch { } finally {
        if (temporary) await unlink(temporary).catch(() => undefined);
      }
    },
  };
}

export const executableDigestCache = createExecutableDigestCache();
