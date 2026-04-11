import crypto from "node:crypto";

export interface FileEntry {
  path: string;
  content: string;
}

export function computeHashFromFiles(files: FileEntry[]): string | null {
  if (files.length === 0) return null;
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const hash = crypto.createHash("sha256");
  for (const file of sorted) {
    hash.update(`${file.path}:${file.content}\n`);
  }
  return hash.digest("hex");
}
