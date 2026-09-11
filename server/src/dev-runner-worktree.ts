import { existsSync, lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasVerifiedWorktreeSeedManifest } from "./worktree-seed-manifest.js";

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

export function isLinkedGitWorktreeCheckout(rootDir: string): boolean {
  const gitMetadataPath = path.join(rootDir, ".git");
  if (!existsSync(gitMetadataPath)) return false;

  const stat = lstatSync(gitMetadataPath);
  if (!stat.isFile()) return false;

  return readFileSync(gitMetadataPath, "utf8").trimStart().startsWith("gitdir:");
}

export function resolveWorktreeEnvFilePath(rootDir: string): string {
  return path.resolve(rootDir, ".paperclip", ".env");
}

export function isWorktreeSeedPending(rootDir: string): boolean {
  const markerDir = path.resolve(rootDir, ".paperclip");
  const manifestPath = path.resolve(markerDir, "seed-manifest.json");
  if (existsSync(manifestPath)) {
    return !hasVerifiedWorktreeSeedManifest(manifestPath);
  }
  return existsSync(path.resolve(markerDir, "seed-pending"))
    && !existsSync(path.resolve(markerDir, "seed-complete"));
}

function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}

function resolveDefaultWorktreeHome(env: NodeJS.ProcessEnv): string {
  return path.resolve(expandHomePrefix(env.PAPERCLIP_WORKTREES_DIR?.trim() || "~/.paperclip-worktrees"));
}

function repairStaleMigratedWorktreeEnvEntries(
  rootDir: string,
  entries: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const localConfigPath = path.resolve(rootDir, ".paperclip", "config.json");
  const configuredPath = entries.PAPERCLIP_CONFIG?.trim();
  if (!configuredPath) return entries;

  const resolvedConfiguredPath = resolveHomeAwarePath(configuredPath);
  const staleConfigPath =
    resolvedConfiguredPath !== localConfigPath &&
    !existsSync(resolvedConfiguredPath) &&
    existsSync(localConfigPath);
  if (!staleConfigPath) return entries;

  const homeDir = resolveDefaultWorktreeHome(env);
  return {
    ...entries,
    PAPERCLIP_HOME: homeDir,
    PAPERCLIP_CONFIG: localConfigPath,
    PAPERCLIP_CONTEXT: path.resolve(homeDir, "context.json"),
  };
}

/**
 * Load `.paperclip/.env` into the environment the dev runner passes to everything
 * it spawns.
 *
 * A linked worktree must carry this file — without it the isolated instance is
 * unresolvable, so its absence is fatal. A primary checkout has no such
 * requirement, but when it does pin an environment the runner must honour it for
 * the same reason: `resolvePaperclipInstanceRoot` and friends fall back to
 * `os.homedir()` whenever PAPERCLIP_HOME is unset, so a child process that does
 * not inherit it silently builds a second, empty Paperclip home somewhere else.
 * Two homes then exist and neither is obviously authoritative. Setting the
 * variable externally does not prevent that: on Windows `setx` only reaches
 * processes launched from a fresh login environment, so anything spawned by an
 * already-running editor or agent never sees it.
 *
 * Entries never override a variable already present in `env`, so an explicit
 * PAPERCLIP_HOME still wins over the file.
 */
export function bootstrapDevRunnerWorktreeEnv(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): WorktreeEnvBootstrapResult {
  const linkedWorktree = isLinkedGitWorktreeCheckout(rootDir);
  const envPath = resolveWorktreeEnvFilePath(rootDir);

  if (!existsSync(envPath)) {
    // A linked worktree cannot resolve its isolated instance without this file,
    // so its absence is fatal. A primary checkout simply has nothing pinned.
    if (linkedWorktree) {
      return { envPath, missingEnv: true };
    }
    return { envPath: null, missingEnv: false };
  }

  // A primary checkout's pin is honoured only when it is coherent: the config
  // file the env file accompanies has to exist beside it. A lone .env is debris
  // — left behind when a worktree's instance was removed, or carried along when
  // a worktree directory was copied into a clone — and applying it would point
  // every spawned child at an instance that no longer exists. A linked worktree
  // is exempt because repairStaleMigratedWorktreeEnvEntries below exists to
  // rewrite precisely that case for it; a primary checkout has no such repair,
  // so the coherence check is what stands in for it.
  if (!linkedWorktree && !existsSync(path.resolve(rootDir, ".paperclip", "config.json"))) {
    return { envPath: null, missingEnv: false };
  }

  const parsedEntries = parseEnvFile(readFileSync(envPath, "utf8"));
  // The stale-config repair rewrites paths against the worktree home layout, so
  // it stays scoped to linked worktrees; a primary checkout's pin is used as
  // written.
  const entries = linkedWorktree
    ? repairStaleMigratedWorktreeEnvEntries(rootDir, parsedEntries, env)
    : parsedEntries;
  for (const [key, value] of Object.entries(entries)) {
    if (typeof env[key] === "string" && env[key]!.trim().length > 0) continue;
    env[key] = value;
  }

  return {
    envPath,
    missingEnv: false,
  };
}
