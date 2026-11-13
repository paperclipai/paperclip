import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { gitCacheCommand } from "./git-workspace-restoration.js";

export async function copyVerifiedGitExcludes(source: string, cwd: string) {
  const common = await fs.realpath(path.resolve(source, (await gitCacheCommand(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()));
  const info = path.join(common, "info"), file = path.join(info, "exclude");
  const directory = await fs.lstat(info).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!directory) return;
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("unsafe_git_excludes");
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw new Error("unsafe_git_excludes"); });
  if (!handle) return;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 1024n * 1024n) throw new Error("unsafe_git_excludes");
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await fs.lstat(file, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || BigInt(length) !== before.size
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.mode !== after.mode || before.ctimeNs !== after.ctimeNs || before.nlink !== after.nlink
      || await fs.realpath(info) !== info) throw new Error("unsafe_git_excludes");
    const target = path.join(cwd, ".git", "info", "exclude");
    await fs.writeFile(target, bytes.subarray(0, length));
    await fs.chmod(target, Number(before.mode & 0o777n));
  } finally { await handle.close(); }
}

