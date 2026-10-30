import path from "node:path";

export function resolveRepoEnvLocalPath(serverRoot: string): string {
  return path.resolve(serverRoot, "..", ".env.local");
}

export function devEnvLocalNodeArgs(serverRoot: string): string[] {
  return [`--env-file-if-exists=${resolveRepoEnvLocalPath(serverRoot)}`];
}

export function devEnvLocalWatchArgs(serverRoot: string): string[] {
  return ["--include", `${resolveRepoEnvLocalPath(serverRoot)}*`];
}
