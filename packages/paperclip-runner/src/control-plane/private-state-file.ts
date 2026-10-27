import type { Stats } from "node:fs";

export function verifyPrivateRegularFile(file: Stats, path: string): void {
  if (!file.isFile()) {
    throw new Error(`Private state path is not a regular file: ${path}`);
  }
  if (process.platform !== "win32") {
    if ((file.mode & 0o777) !== 0o600) {
      throw new Error(`Private state file does not use mode 0600: ${path}`);
    }
    if (process.geteuid !== undefined && file.uid !== process.geteuid()) {
      throw new Error(`Private state file is not owned by the daemon user: ${path}`);
    }
  }
}
