import path from "node:path";

export function resolveRepoEnvLocalPath(serverRoot: string): string {
  return path.resolve(serverRoot, "..", ".env.local");
}

export function devEnvLocalNodeArgs(serverRoot: string): string[] {
  return [`--env-file-if-exists=${resolveRepoEnvLocalPath(serverRoot)}`];
}

export function devEnvLocalWatchArgs(serverRoot: string): string[] {
  const envLocalPath = resolveRepoEnvLocalPath(serverRoot);
  const fileName = path.basename(envLocalPath);
  const lastCharacterAsClass = `${fileName.slice(0, -1)}[${fileName.slice(-1)}]`;
  return ["--include", path.join(path.dirname(envLocalPath), lastCharacterAsClass)];
}
