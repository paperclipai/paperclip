import fs from "node:fs";

export function ensureDirectoryMode(dirPath: string, mode = 0o700): void {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  applyPathMode(dirPath, mode);
}

export function ensureFileMode(filePath: string, mode = 0o600): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", { flag: "a", mode });
  }
  applyPathMode(filePath, mode);
}

export function applyPathMode(targetPath: string, mode: number): void {
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    // best effort
  }
}
