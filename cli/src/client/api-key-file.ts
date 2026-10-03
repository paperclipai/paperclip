import fs, { type BigIntStats } from "node:fs";
import path from "node:path";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

function sameFileSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return (["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs"] as const)
    .every((field) => before[field] === after[field]);
}

/** Read an operator-managed local POSIX credential without exporting its contents. */
export function readApiKeyFile(file: string): string {
  try {
    const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
    if (!path.isAbsolute(file) || !process.geteuid || !O_NONBLOCK || !O_NOFOLLOW) throw new Error();
    const canonical = fs.realpathSync(file);
    if (canonical === "/nix/store" || canonical.startsWith("/nix/store/")) throw new Error();
    const before = fs.lstatSync(canonical, { bigint: true });
    if (!before.isFile() || before.size === 0n || before.size > BigInt(MAX_CREDENTIAL_BYTES)
      || (before.mode & 0o137n) !== 0n
      || (before.uid !== 0n && before.uid !== BigInt(process.geteuid()))) throw new Error();

    // Pin the opened inode, rather than checking a path then reading it again.
    // NONBLOCK also avoids waiting for a writer if the path becomes a FIFO.
    const fd = fs.openSync(canonical, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
    try {
      if (!sameFileSnapshot(before, fs.fstatSync(fd, { bigint: true }))) throw new Error();
      const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
        if (count === 0) break;
        length += count;
      }
      if (length > MAX_CREDENTIAL_BYTES || BigInt(length) !== before.size
        || !sameFileSnapshot(before, fs.fstatSync(fd, { bigint: true }))) throw new Error();
      // latin1 preserves every byte so the ASCII check also rejects malformed UTF-8.
      const token = bytes.subarray(0, length).toString("latin1").replace(/\r?\n$/, "");
      if (!/^[\x21-\x7e]+$/.test(token)) throw new Error();
      return token;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Never include token contents, paths, or nested operating-system diagnostics.
    throw new Error("CLI credential file is missing, invalid, changed, or insufficiently protected");
  }
}
