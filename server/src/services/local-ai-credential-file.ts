import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { openRunnerApiWorkspaceFile } from "./native-runtime/runner-api-files.js";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

/** Reject Windows links before opening a credential path. */
async function assertWindowsCredentialPath(filename: string): Promise<void> {
  let current = path.resolve(filename);
  while (true) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Invalid credential file");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Bounded descriptor read; Unix uses a confined descriptor and Windows rejects resolved links. */
export async function readLocalAiCredentialFile(filename: string): Promise<string> {
  if (process.platform === "win32") await assertWindowsCredentialPath(filename);
  const file = process.platform === "win32" ? await open(filename, "r") : await openRunnerApiWorkspaceFile(filename);
  try {
    const stat = await file.stat();
    const posix = process.platform !== "win32";
    if (!stat.isFile() || (posix && stat.uid !== process.getuid?.()) || (posix && (stat.mode & 0o777) !== 0o600) || stat.size > MAX_CREDENTIAL_BYTES) {
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
