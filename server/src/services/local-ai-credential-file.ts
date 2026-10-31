import { openRunnerApiWorkspaceFile } from "./native-runtime/runner-api-files.js";
import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

// Windows has no POSIX uid/mode checks and the confined workspace opener is
// deliberately Unix-only. The caller supplies a Paperclip-owned login home.
// Reject file and parent reparse points before opening, and verify the opened
// descriptor still refers to the file that was checked. On POSIX we retain the
// existing stronger confined opener and its owner/mode checks unchanged.
async function openWindowsCredentialFile(filename: string) {
  const [parent, entry] = await Promise.all([lstat(path.dirname(filename)), lstat(filename)]);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new Error("Invalid Windows credential path");
  }
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.nlink !== 1) {
      throw new Error("Credential path changed during open");
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Bounded descriptor read; never reopens a checked file. */
export async function readLocalAiCredentialFile(filename: string): Promise<string> {
  const file = process.platform === "win32"
    ? await openWindowsCredentialFile(filename)
    : await openRunnerApiWorkspaceFile(filename);
  try {
    const stat = await file.stat();
    const posix = process.platform !== "win32";
    if (!stat.isFile() || (posix && stat.uid !== process.getuid?.()) ||
        (posix && (stat.mode & 0o777) !== 0o600) || stat.size > MAX_CREDENTIAL_BYTES) {
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
