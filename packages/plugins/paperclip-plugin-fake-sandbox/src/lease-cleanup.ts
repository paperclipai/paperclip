import { constants } from "node:fs";
import { open, readdir, rm } from "node:fs/promises";
import path from "node:path";

export interface LeaseRootIdentity {
  dev: number;
  ino: number;
}

async function makeDirectoriesWritable(directory: string, expected?: LeaseRootIdentity): Promise<boolean> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return false;
  try {
    const identity = await handle.stat();
    if (!identity.isDirectory() || (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino))) {
      throw new Error("Refusing to remove a replaced fake sandbox lease root");
    }
    // Native context directories are sealed. Restore deletion permissions on
    // directories only; opening without following links protects outside targets.
    await handle.chmod(0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeDirectoriesWritable(path.join(directory, entry.name));
    }
    return true;
  } finally {
    await handle.close();
  }
}

export async function removeOwnedLeaseDirectory(rootDir: string, identity: LeaseRootIdentity): Promise<void> {
  if (await makeDirectoriesWritable(rootDir, identity)) {
    await rm(rootDir, { recursive: true, force: true });
  }
}
