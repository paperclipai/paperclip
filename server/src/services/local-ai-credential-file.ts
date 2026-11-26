import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { openRunnerApiWorkspaceFile } from "./native-runtime/runner-api-files.js";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

/**
 * Windows has no confined open, so check the opened handle instead. Refuse any
 * symlink or junction in the path, then require the handle to be the file the
 * path names now. A link swapped in after the open cannot change what the
 * handle reads, and one swapped in before it changes the identity or the walk.
 */
async function assertWindowsHandleIsPlainPath(file: FileHandle, filename: string): Promise<void> {
  const resolved = path.resolve(filename);
  const { root } = path.parse(resolved);
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Invalid credential file");
  }
  const [opened, named] = await Promise.all([file.stat({ bigint: true }), lstat(resolved, { bigint: true })]);
  if (opened.dev !== named.dev || opened.ino !== named.ino) throw new Error("Invalid credential file");
}

/** Bounded descriptor read; never follows symlinks or reopens a checked path. */
export async function readLocalAiCredentialFile(filename: string): Promise<string> {
  // Windows has no uid and no 0600 mode; it relies on the per-user profile ACLs
  // of the login home plus the handle checks above.
  const windows = process.platform === "win32";
  const file = windows ? await open(filename, constants.O_RDONLY) : await openRunnerApiWorkspaceFile(filename);
  try {
    if (windows) await assertWindowsHandleIsPlainPath(file, filename);
    const stat = await file.stat();
    const owned = windows || (stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600);
    if (!stat.isFile() || !owned || stat.size > MAX_CREDENTIAL_BYTES) {
      throw new Error("Invalid credential file");
    }
    const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > MAX_CREDENTIAL_BYTES) throw new Error("Invalid credential file");
    return bytes.subarray(0, size).toString("utf8");
  } finally {
    await file.close();
  }
}
