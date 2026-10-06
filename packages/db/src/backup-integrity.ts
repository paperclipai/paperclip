import { createReadStream, statSync } from "node:fs";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const MAX_CACHED_BACKUPS = 256;
const integrityCache = new Map<string, { signature: string; result: Promise<boolean> }>();

/** Check gzip completion and checksum without loading a database dump into memory. */
export async function isCompressedDatabaseBackupValid(filePath: string): Promise<boolean> {
  let stat;
  try { stat = statSync(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile() || stat.size < 20) return false;
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = integrityCache.get(filePath);
  if (cached?.signature === signature) return cached.result;

  const result = (async () => {
    let bytes = 0;
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback();
      },
    });
    try {
      await pipeline(createReadStream(filePath), createGunzip(), sink);
      return bytes > 0;
    } catch {
      return false;
    }
  })();
  integrityCache.delete(filePath);
  integrityCache.set(filePath, { signature, result });
  if (integrityCache.size > MAX_CACHED_BACKUPS) {
    const oldest = integrityCache.keys().next().value;
    if (oldest !== undefined) integrityCache.delete(oldest);
  }
  return result;
}
