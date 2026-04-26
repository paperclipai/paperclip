import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

function parseEnvFile(contents: string): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (!value) {
      entries[key] = "";
      continue;
    }
    if (value.startsWith("#")) {
      entries[key] = "";
      continue;
    }

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      entries[key] = value.slice(1, -1);
      continue;
    }

    entries[key] = value.replace(/\s+#.*$/, "").trim();
  }

  return entries;
}

type WorktreeEnvBootstrapResult =
  | { envPath: null; missingEnv: false }
  | { envPath: string; missingEnv: true }
  | { envPath: string; missingEnv: false };

/** Returns true if the given directory is a git worktree checkout (its .git entry is a file, not a directory). */
export function isLinkedGitWorktreeCheckout(rootDir: string): boolean {
  const gitMetadataPath = path.join(rootDir, ".git");
  if (!existsSync(gitMetadataPath)) return false;

  const stat = lstatSync(gitMetadataPath);
  if (!stat.isFile()) return false;

  return readFileSync(gitMetadataPath, "utf8").trimStart().startsWith("gitdir:");
}

/** Returns the canonical path of the per-worktree .env file inside a worktree root. */
export function resolveWorktreeEnvFilePath(rootDir: string): string {
  return path.resolve(rootDir, ".paperclip", ".env");
}

/** Loads the worktree .env file into the given process env, reporting whether the file was missing. */
export function bootstrapDevRunnerWorktreeEnv(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): WorktreeEnvBootstrapResult {
  if (!isLinkedGitWorktreeCheckout(rootDir)) {
    return {
      envPath: null,
      missingEnv: false,
    };
  }

  const envPath = resolveWorktreeEnvFilePath(rootDir);
  if (!existsSync(envPath)) {
    return {
      envPath,
      missingEnv: true,
    };
  }

  const entries = parseEnvFile(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(entries)) {
    if (typeof env[key] === "string" && env[key]!.trim().length > 0) continue;
    env[key] = value;
  }

  return {
    envPath,
    missingEnv: false,
  };
}
