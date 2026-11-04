import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createIsolatedTestHome() {
  const { mkdtempSync, lstatSync, openSync, fchmodSync, closeSync, readdirSync, rmSync, constants } = fs;
  const home = mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-home-"));
  const identity = lstatSync(home);
  const cleanup = () => {
    let current;
    try { current = lstatSync(home); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error("Refusing to clean a replaced isolated test home");
    }
    const makeDirectoriesWritable = (directory: string) => {
      const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fchmodSync(fd, 0o700); }
      finally { closeSync(fd); }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) makeDirectoriesWritable(path.join(directory, entry.name));
      }
    };
    makeDirectoriesWritable(home);
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  };
  return { home, cleanup };
}
