import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const runtimeShellTestTimeoutMs = process.platform === "win32" ? 30_000 : 5_000;

export function resolveTestShellCommand(): string {
  if (process.platform !== "win32") return "/bin/sh";

  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "sh.exe"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "sh.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "sh";
}

export function normalizeWindowsPathsForTestShell(command: string): string {
  if (process.platform !== "win32") return command;

  return command.replace(/'([A-Za-z]:\\[^']*)'/g, (_match, rawPath: string) => {
    const normalized = rawPath
      .replace(/\\/g, "/")
      .replace(/^([A-Za-z]):/, (_driveMatch, drive: string) => `/${drive.toLowerCase()}`);
    return `'${normalized}'`;
  });
}

export function fromWindowsTestShellPath(value: string): string {
  if (process.platform !== "win32") return value;
  const drivePath = value.match(/^\/([A-Za-z])\/(.*)$/);
  if (drivePath) {
    return `${drivePath[1].toUpperCase()}:\\${drivePath[2].replace(/\//g, "\\")}`;
  }
  if (value === "/tmp") return os.tmpdir();
  if (value.startsWith("/tmp/")) {
    return path.join(os.tmpdir(), value.slice("/tmp/".length).replace(/\//g, path.sep));
  }
  return value;
}
