import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { verifyPrivateRegularFile } from "./private-state-file.js";

/** Stage durable bytes off the event loop; the owner publishes them without yielding. */
export async function withStagedPrivateWrite(
  path: string,
  contents: string,
  publish: (temporary: string) => void,
): Promise<void> {
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try {
      if (process.platform !== "win32") await file.chmod(0o600);
      const metadata = await file.stat();
      verifyPrivateRegularFile(metadata, temporary);
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    publish(temporary);
  } finally {
    // Publication can either rename this file or retain a newer durable write.
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
