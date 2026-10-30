import { existsSync } from "node:fs";
import path from "node:path";

export function resolveRepoEnvLocalPath(serverRoot: string): string {
  return path.resolve(serverRoot, "..", ".env.local");
}

export function devEnvLocalNodeArgs(serverRoot: string): string[] {
  const envLocalPath = resolveRepoEnvLocalPath(serverRoot);
  return existsSync(envLocalPath) ? [`--env-file=${envLocalPath}`] : [];
}

export function devEnvLocalWatchArgs(serverRoot: string): string[] {
  const envLocalPath = resolveRepoEnvLocalPath(serverRoot);
  return existsSync(envLocalPath) ? ["--include", envLocalPath] : [];
}
