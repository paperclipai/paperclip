import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";

export async function nativeControllerSourceDigest(file: string, maxBytes: number): Promise<string | undefined> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error("native_controller_migration_unsafe_source");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error("native_controller_migration_unsafe_source");
      hash.update(chunk);
    }
    return hash.digest("hex");
  } finally { await handle.close(); }
}
