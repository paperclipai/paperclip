import { existsSync } from "node:fs";
import path from "node:path";

export function localSandboxPath(localPath: string): string {
  if (process.platform !== "win32") return localPath;
  const normalized = path.resolve(localPath).replaceAll("\\", "/");
  return `/${normalized[0]!.toLowerCase()}${normalized.slice(2)}`;
}

export function localSandboxHostPath(remotePath: string): string {
  return process.platform === "win32" && /^\/[a-z]\//i.test(remotePath)
    ? `${remotePath[1]}:${remotePath.slice(2)}` : remotePath;
}

export function localSandboxShell(): string {
  const shell = process.platform === "win32"
    ? path.join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe") : "/bin/bash";
  if (!existsSync(shell)) throw new Error("The local POSIX sandbox fixture requires Git Bash on Windows or /bin/bash on Unix");
  return shell;
}

export function localSandboxShellArgs(args: string[]): string[] {
  const result = [...args];
  if (process.platform === "win32" && result[0] === "-c") result[1] = `export PATH=/usr/bin:/bin:$PATH; ${result[1] ?? ""}`;
  return result;
}
