import fs from "node:fs";

export function ensureDirectoryMode(dirPath: string, mode = 0o700): void {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  applyPathMode(dirPath, mode);
}

export function applyPathMode(targetPath: string, mode: number): void {
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    // best effort
  }
}

export function readPathMode(targetPath: string): number | null {
  try {
    return fs.statSync(targetPath).mode & 0o777;
  } catch {
    return null;
  }
}

export function isModeTooPermissive(actualMode: number, maxMode: number): boolean {
  return (actualMode & ~maxMode) !== 0;
}

export function formatMode(mode: number): string {
  return `0o${mode.toString(8).padStart(3, "0")}`;
}
