import { execFileSync } from "node:child_process";

function parseCommit(value: string | undefined): string | null {
  const commit = value?.trim() ?? "";
  return /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : null;
}

/** Only a full source commit may enter the public browser bundle. */
export function resolveBrowserBuildCommit(
  value: string | undefined,
  readGitCommit: () => string | undefined = () => undefined,
): string | null {
  const suppliedCommit = parseCommit(value);
  if (suppliedCommit) return suppliedCommit;
  try {
    return parseCommit(readGitCommit());
  } catch {
    return null;
  }
}

export function readBrowserBuildCommit(repositoryDirectory: string): string | null {
  return resolveBrowserBuildCommit(process.env.PAPERCLIP_BUILD_COMMIT, () =>
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }),
  );
}
