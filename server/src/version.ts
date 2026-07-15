import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseBuildCommit, readBuildCommit } from "./build-commit.js";

type PackageJson = {
  version?: string;
};

type GitDescribeCommand = () => string;
type DebugLog = (fields: Record<string, unknown>, message: string) => void;
type PathExists = (path: string) => boolean;
type Realpath = (path: string) => string;

const requirePackage = createRequire(import.meta.url);
const packageRoot = dirname(requirePackage.resolve("../package.json"));
const pkg = requirePackage("../package.json") as PackageJson;

const GIT_DESCRIBE_RE =
  /^v(?<publicVersion>\d+\.\d+\.\d+)-(?<commitsSinceTag>\d+)-g(?<sha>[0-9a-f]{7,40})(?<dirty>-dirty)?$/i;

function defaultDebugLog(fields: Record<string, unknown>, message: string): void {
  if (process.env.PAPERCLIP_DEBUG_VERSION_RESOLUTION !== "1") return;

  console.debug(message, fields);
}

function defaultGitDescribeCommand(): string {
  return execFileSync(
    "git",
    ["describe", "--tags", "--match", "v*", "--long", "--dirty"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    },
  );
}

function hasPathSegment(path: string, segment: string): boolean {
  return path.split(/[\\/]+/).includes(segment);
}

function safeRealpath(path: string, realpath: Realpath): string {
  try {
    return realpath(path);
  } catch {
    return path;
  }
}

function hasGitMetadataBeforeNodeModulesBoundary(
  path: string,
  pathExists: PathExists,
): boolean {
  let current = path;

  while (true) {
    if (pathExists(join(current, ".git"))) return true;

    const parent = dirname(current);
    if (parent === current || basename(current) === "node_modules") return false;

    current = parent;
  }
}

function isPackagedInstall(
  path: string,
  {
    pathExists = existsSync,
    realpath = realpathSync,
  }: { pathExists?: PathExists; realpath?: Realpath } = {},
): boolean {
  const realPackageRoot = safeRealpath(path, realpath);
  const candidateRoots = Array.from(new Set([path, realPackageRoot]));
  const hasNodeModulesSegment = candidateRoots.some((candidate) =>
    hasPathSegment(candidate, "node_modules"),
  );

  if (!hasNodeModulesSegment) return false;

  return !candidateRoots.some((candidate) =>
    hasGitMetadataBeforeNodeModulesBoundary(candidate, pathExists),
  );
}

function normalizeErrorField(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return value;
}

function compactRecord(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

function summarizeError(err: unknown): Record<string, unknown> {
  if (err && typeof err === "object") {
    const errorLike = err as {
      name?: unknown;
      message?: unknown;
      status?: unknown;
      signal?: unknown;
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      stack?: unknown;
      cause?: unknown;
    };

    return compactRecord({
      name: errorLike.name,
      message: errorLike.message,
      status: errorLike.status,
      signal: errorLike.signal,
      code: errorLike.code,
      stdout: normalizeErrorField(errorLike.stdout),
      stderr: normalizeErrorField(errorLike.stderr),
      stack: errorLike.stack,
      cause:
        errorLike.cause === undefined ? undefined : summarizeError(errorLike.cause),
    });
  }

  return { message: String(err) };
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
    buildCommit?: string | null;
    gitDescribeCommand?: GitDescribeCommand;
    packageVersion?: string;
    debugLog?: DebugLog;
    packageRoot?: string;
    pathExists?: PathExists;
    realpath?: Realpath;
  } = {},
): string {
  const packageVersion = opts.packageVersion ?? pkg.version ?? "0.0.0";
  const gitDescribeCommand = opts.gitDescribeCommand ?? defaultGitDescribeCommand;
  const debugLog = opts.debugLog ?? defaultDebugLog;
  const resolvedPackageRoot = opts.packageRoot ?? packageRoot;

  if (
    isPackagedInstall(resolvedPackageRoot, {
      pathExists: opts.pathExists,
      realpath: opts.realpath,
    })
  ) {
    debugLog(
      { reason: "packaged_install" },
      "falling back to package version for server version",
    );
    return packageVersion;
  }

  try {
    const parsedVersion = parseGitDescribeVersion(gitDescribeCommand());
    if (parsedVersion) return parsedVersion;

    debugLog(
      { reason: "invalid_git_describe" },
      "falling back to package version for server version",
    );
    return packageVersion;
  } catch (err) {
    debugLog(
      { err: summarizeError(err), reason: "git_describe_unavailable" },
      "falling back to package version for server version",
    );
  }

  const buildCommit =
    opts.buildCommit === undefined
      ? readBuildCommit()
      : parseBuildCommit(opts.buildCommit);
  if (buildCommit) {
    return `${packageVersion}+0.git.${buildCommit.slice(0, 7)}`;
  }

  return packageVersion;
}

export const serverVersion = resolveServerVersion();
