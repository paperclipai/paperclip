import { openRunnerApiWorkspaceFile } from "./native-runtime/runner-api-files.js";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

/** Bounded descriptor read; never follows symlinks or reopens a checked path. */
export async function readLocalAiCredentialFile(filename: string): Promise<string> {
  const file = await openRunnerApiWorkspaceFile(filename);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_CREDENTIAL_BYTES) {
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
