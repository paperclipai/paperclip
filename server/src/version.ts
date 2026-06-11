import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  version?: string;
};

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as PackageJson;

const explicitVersionEnvKeys = [
  "PAPERCLIP_VERSION",
  "PAPERCLIP_SOURCE_SHA",
  "SOURCE_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "GITHUB_SHA",
] as const;

function normalizeVersion(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function readGitDir(repoRoot: string) {
  const gitPath = path.join(repoRoot, ".git");
  if (!existsSync(gitPath)) return undefined;

  try {
    if (statSync(gitPath).isDirectory()) return gitPath;

    const pointer = readFileSync(gitPath, "utf8").trim();
    if (!pointer.startsWith("gitdir:")) return undefined;
    const gitDir = pointer.slice("gitdir:".length).trim();
    return path.resolve(repoRoot, gitDir);
  } catch {
    return undefined;
  }
}

function readPackedRef(gitDir: string, refPath: string) {
  try {
    const packedRefs = readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    for (const line of packedRefs.split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const [sha, ref] = line.trim().split(/\s+/);
      if (ref === refPath) return normalizeVersion(sha);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readGitHead(repoRoot: string) {
  const gitDir = readGitDir(repoRoot);
  if (!gitDir) return undefined;

  try {
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head) return undefined;
    if (!head.startsWith("ref:")) return head;

    const refPath = head.slice("ref:".length).trim();
    try {
      return normalizeVersion(readFileSync(path.join(gitDir, refPath), "utf8"));
    } catch {
      return readPackedRef(gitDir, refPath);
    }
  } catch {
    return undefined;
  }
}

export function resolveServerVersion(input: {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  packageVersion?: string;
} = {}) {
  const env = input.env ?? process.env;
  for (const key of explicitVersionEnvKeys) {
    const value = normalizeVersion(env[key]);
    if (value) return value;
  }

  const repoRoot =
    input.repoRoot ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return readGitHead(repoRoot) ?? input.packageVersion ?? pkg.version ?? "0.0.0";
}

export const serverVersion = resolveServerVersion();
