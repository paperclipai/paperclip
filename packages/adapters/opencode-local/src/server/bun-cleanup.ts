import fs from "node:fs/promises";
import {Dirent} from "node:fs";
import path from "node:path";

/**
 * Regex matching Bun's mkstemp pattern for extracted shared libraries.
 * Bun creates files like `.{hex}-{numeric}.so` where {hex} is 16+ hex chars
 * and {numeric} is an 8-digit zero-padded number.
 */
export const BUN_TEMP_SO_RE = /^\.[0-9a-f]{16,}-\d{8}\.so$/;

/** ELF magic bytes (`\x7fELF`) used to validate files before unlinking. */
export const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/**
 * Reap orphaned Bun-extracted shared library files from the given tmpdir.
 *
 * Bun extracts native addons (e.g. `libopentui.so`) into tmpdir on every
 * process load via `mkstemp()` and never cleans them up. Over time these
 * accumulate and can exhaust tmpdir disk space (especially on tmpfs).
 *
 * @param tmpdir - The temporary directory to scan (typically `os.tmpdir()`).
 * @returns The number of successfully deleted files.
 */
export async function reapBunTempSharedLibs(tmpdir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(tmpdir, { withFileTypes: true });
  } catch {
    // tmpdir may not exist or be unreadable — nothing to reap.
    return 0;
  }

  let reapedCount = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !BUN_TEMP_SO_RE.test(entry.name)) continue;

    const fullPath = path.join(tmpdir, entry.name);

    // Wrap ELF validation so one bad file (I/O error, EMFILE, etc.)
    // does not abort the entire scan. Skip to the next file on failure.
    let isElf: boolean;
    try {
      const handle = await fs.open(fullPath);
      try {
        const buf = Buffer.alloc(4);
        await handle.read(buf, 0, 4, 0);
        isElf = buf.equals(ELF_MAGIC);
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }

    if (!isElf) continue;

    try {
      await fs.unlink(fullPath);
      reapedCount++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      // Skip files that are in-use (EBUSY), permission-denied (EPERM),
      // or already deleted by a concurrent cleanup (ENOENT).
      if (code !== "ENOENT" && code !== "EBUSY" && code !== "EPERM") {
        throw err;
      }
    }
  }

  return reapedCount;
}
