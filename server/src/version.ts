import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

type PackageJson = {
  version?: string;
};

type GitDescribeCommand = () => string;
type DebugLog = (fields: Record<string, unknown>, message: string) => void;

const requirePackage = createRequire(import.meta.url);
const pkg = requirePackage("../package.json") as PackageJson;

const GIT_DESCRIBE_RE =
  /^v(?<publicVersion>\d+\.\d+\.\d+)-(?<commitsSinceTag>\d+)-g(?<sha>[0-9a-f]{7,40})(?<dirty>-dirty)?$/i;

function defaultDebugLog(fields: Record<string, unknown>, message: string): void {
  console.debug(message, fields);
}

function defaultGitDescribeCommand(): string {
  return execFileSync(
    "git",
    ["describe", "--tags", "--match", "v*", "--long", "--dirty"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    },
  );
}

export function parseGitDescribeVersion(output: string): string | null {
  const match = output.trim().match(GIT_DESCRIBE_RE);
  if (!match?.groups) return null;

  const publicVersion = match.groups.publicVersion;
  const commitsSinceTag = match.groups.commitsSinceTag;
  const sha = match.groups.sha;
  const isDirty = Boolean(match.groups.dirty);

  if (commitsSinceTag === "0" && !isDirty) {
    return publicVersion;
  }

  return `${publicVersion}+${commitsSinceTag}.git.${sha}${isDirty ? ".dirty" : ""}`;
}

export function resolveServerVersion(
  opts: {
    gitDescribeCommand?: GitDescribeCommand;
    packageVersion?: string;
    debugLog?: DebugLog;
  } = {},
): string {
  const packageVersion = opts.packageVersion ?? pkg.version ?? "0.0.0";
  const gitDescribeCommand = opts.gitDescribeCommand ?? defaultGitDescribeCommand;
  const debugLog = opts.debugLog ?? defaultDebugLog;

  try {
    const parsedVersion = parseGitDescribeVersion(gitDescribeCommand());
    if (parsedVersion) return parsedVersion;

    debugLog(
      { reason: "invalid_git_describe" },
      "falling back to package version for server version",
    );
  } catch (err) {
    debugLog(
      { err, reason: "git_describe_unavailable" },
      "falling back to package version for server version",
    );
  }

  return packageVersion;
}

export const serverVersion = resolveServerVersion();
