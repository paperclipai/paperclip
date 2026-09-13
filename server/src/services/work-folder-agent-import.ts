import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

const excluded = new Set([".codex", ".claude", ".cache", ".config", ".local", ".git", ".paperclip-runtime", ".ssh", ".aws", ".azure", ".netrc", ".git-credentials", ".npmrc", ".npm", "node_modules", ".venv"]);
export interface ManagedAgentFile { path: string; kind: "file" | "directory"; executable: boolean; body?: Readable }

/** Pin directory descriptors on Linux so a concurrent rename cannot redirect imports. */
export async function* managedAgentFiles(root: string): AsyncGenerator<ManagedAgentFile> {
  const absolute = path.resolve(root);
  let current = path.parse(absolute).root;
  let parent = await fs.open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const anchored = (fd: number, fallback: string) => process.platform === "linux" ? `/proc/self/fd/${fd}` : fallback;
  try {
    for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      const next = path.join(anchored(parent.fd, current), segment);
      const child = await fs.open(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!child) return;
      await parent.close(); parent = child; current = path.join(current, segment);
    }
    let entries = 0;
    async function* visit(directory: typeof parent, fallback: string, relative: string): AsyncGenerator<ManagedAgentFile> {
      for (const name of (await fs.readdir(anchored(directory.fd, fallback))).sort()) {
        if (excluded.has(name)) continue;
        if (++entries > 100_000) throw new Error("Managed agent import exceeds its file limit");
        const filename = relative ? `${relative}/${name}` : name;
        const source = path.join(anchored(directory.fd, fallback), name);
        const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (stat.isDirectory()) {
            yield { path: filename, kind: "directory", executable: false };
            yield* visit(handle, path.join(fallback, name), filename);
          } else if (stat.isFile() && stat.nlink === 1 && stat.size <= 1024 ** 3) {
            const body = handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 });
            try { yield { path: filename, kind: "file", executable: Boolean(stat.mode & 0o111), body }; }
            finally { body.destroy(); }
          } else throw new Error("Managed agent files cannot contain hard links or special files");
        } finally { await handle.close(); }
      }
    }
    yield* visit(parent, absolute, "");
  } finally { await parent.close(); }
}
