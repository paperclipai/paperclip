/**
 * Instance-wide shared skills (TECH-9129).
 *
 * An operator can point the server at one GitHub repository folder that holds skills every company should have in its
 * library. The server alone holds the read credential: it downloads the folder on a timer, keeps the latest snapshot on
 * local disk, and `company-skills` imports that snapshot into each company's library on demand. No company, person or
 * agent receives the token, no connection is created in any company, and nothing is installed on any agent, so the
 * managed GitHub identity lookup that git and gh rely on is unaffected.
 *
 * Unset repository or token means the feature is off (a quiet no-op). Nothing here logs the token, a header or any
 * upstream response text: outcomes carry closed reason codes only.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { SHARED_SKILLS_TOKEN_ENV, readSharedSkillsToken } from "../secrets/shared-skills-token.js";
import { MAX_REPOSITORY_BYTES, MAX_REPOSITORY_FILES } from "./skill-repository-package.js";
import { openGitSkillSnapshot, type GitSkillSnapshot } from "./skill-source-git-snapshot.js";

export { SHARED_SKILLS_TOKEN_ENV };
export const SHARED_SKILLS_REPOSITORY_ENV = "PAPERCLIP_SHARED_SKILLS_REPOSITORY";
export const SHARED_SKILLS_PATH_ENV = "PAPERCLIP_SHARED_SKILLS_PATH";
export const SHARED_SKILLS_REF_ENV = "PAPERCLIP_SHARED_SKILLS_REF";
export const SHARED_SKILLS_INTERVAL_MS = 10 * 60_000;
export const SHARED_SKILLS_KEY_PREFIX = "shared/";
export const SHARED_SKILLS_SOURCE_KIND = "shared_repo";

const KEEP_SNAPSHOTS = 2;
const COMPLETE_MARKER = ".complete";
const POINTER_FILE = "CURRENT";
const SKILL_DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;

export interface SharedSkillsConfig {
  token: string;
  repositoryUrl: string;
  subpath: string;
  ref: string;
}

export type SharedSkillsRefreshOutcome =
  | { status: "not_configured" }
  | { status: "unchanged"; commitSha: string; skills: number }
  | { status: "updated"; commitSha: string; skills: number }
  | { status: "error"; reason: "download_failed" | "no_skills" | "too_large" | "write_failed" };

/**
 * Reads the closed configuration, or null when the feature is off or the settings are malformed. Without an injected
 * `env` the token is the boot snapshot (the variable itself is scrubbed from `process.env` at startup).
 */
export function readSharedSkillsConfig(env?: NodeJS.ProcessEnv): SharedSkillsConfig | null {
  const token = env ? env[SHARED_SKILLS_TOKEN_ENV]?.trim() : readSharedSkillsToken();
  const source = env ?? process.env;
  const repository = source[SHARED_SKILLS_REPOSITORY_ENV]?.trim();
  if (!token || !repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  const subpath = (source[SHARED_SKILLS_PATH_ENV]?.trim() || "skills").replace(/^\/+|\/+$/g, "");
  const ref = source[SHARED_SKILLS_REF_ENV]?.trim() || "main";
  if (!subpath || subpath.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..") || ref.startsWith("-")) return null;
  return { token, repositoryUrl: `https://github.com/${repository}`, subpath, ref };
}

export function sharedSkillsDirectory(): string {
  return path.join(resolvePaperclipInstanceRoot(), "shared-skills");
}

/** The directory holding the latest complete snapshot, or null before the first successful download. */
export async function resolveSharedSkillsRoot(directory = sharedSkillsDirectory()): Promise<string | null> {
  const pointer = (await readFile(path.join(directory, POINTER_FILE), "utf8").catch(() => "")).trim();
  if (!COMMIT_SHA.test(pointer)) return null;
  const root = path.join(directory, pointer);
  const complete = await stat(path.join(root, COMPLETE_MARKER)).then((s) => s.isFile()).catch(() => false);
  return complete ? root : null;
}

function safeRelativePath(entryPath: string, prefix: string): string[] | null {
  if (!entryPath.startsWith(prefix)) return null;
  const segments = entryPath.slice(prefix.length).split("/");
  if (segments.length < 2) return null; // a loose file beside the skill folders is not a skill
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".git")) return null;
  if (!SKILL_DIRECTORY_NAME.test(segments[0]!)) return null;
  return segments;
}

async function pruneOldSnapshots(directory: string, keepSha: string): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const snapshots: Array<{ name: string; mtime: number }> = [];
  for (const name of names) {
    if (!COMMIT_SHA.test(name) || name === keepSha) continue;
    const info = await stat(path.join(directory, name)).catch(() => null);
    if (info?.isDirectory()) snapshots.push({ name, mtime: info.mtimeMs });
  }
  snapshots.sort((a, b) => b.mtime - a.mtime);
  for (const old of snapshots.slice(KEEP_SNAPSHOTS - 1)) {
    await rm(path.join(directory, old.name), { recursive: true, force: true });
  }
}

export interface RefreshSharedSkillsOptions {
  env?: NodeJS.ProcessEnv;
  directory?: string;
  openSnapshot?: typeof openGitSkillSnapshot;
}

/** Downloads the configured folder once and publishes it as the current snapshot. Idempotent per commit. */
export async function refreshSharedSkills(options: RefreshSharedSkillsOptions = {}): Promise<SharedSkillsRefreshOutcome> {
  const config = readSharedSkillsConfig(options.env);
  if (!config) return { status: "not_configured" };
  const directory = options.directory ?? sharedSkillsDirectory();
  const open = options.openSnapshot ?? openGitSkillSnapshot;

  let snapshot: GitSkillSnapshot;
  try {
    snapshot = await open({ repositoryUrl: config.repositoryUrl, ref: config.ref, token: config.token, cacheScope: "shared-skills" });
  } catch (error) {
    logger.warn({ errorClass: error instanceof Error ? error.constructor.name : typeof error }, "shared skills download failed");
    return { status: "error", reason: "download_failed" };
  }
  try {
    const target = path.join(directory, snapshot.commitSha);
    const prefix = `${config.subpath}/`;
    if (await stat(path.join(target, COMPLETE_MARKER)).then((s) => s.isFile()).catch(() => false)) {
      await writePointer(directory, snapshot.commitSha);
      const skills = (await readdir(target, { withFileTypes: true })).filter((e) => e.isDirectory()).length;
      return { status: "unchanged", commitSha: snapshot.commitSha, skills };
    }

    const wanted = snapshot.entries.filter((entry) => entry.type === "blob" && entry.mode !== "120000" && safeRelativePath(entry.path, prefix));
    const skillDirectories = new Set(wanted.filter((e) => e.path.endsWith("/SKILL.md") && safeRelativePath(e.path, prefix)?.length === 2).map((e) => safeRelativePath(e.path, prefix)![0]!));
    const files = wanted.filter((entry) => skillDirectories.has(safeRelativePath(entry.path, prefix)![0]!));
    if (skillDirectories.size === 0) return { status: "error", reason: "no_skills" };
    if (files.length > MAX_REPOSITORY_FILES || files.reduce((sum, entry) => sum + (entry.size ?? 0), 0) > MAX_REPOSITORY_BYTES) {
      return { status: "error", reason: "too_large" };
    }

    await mkdir(directory, { recursive: true, mode: 0o700 });
    const staging = path.join(directory, `.tmp-${randomBytes(6).toString("hex")}`);
    try {
      for (const entry of files) {
        const relative = safeRelativePath(entry.path, prefix)!;
        const destination = path.join(staging, ...relative);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, await snapshot.readBlob(entry), { mode: entry.mode === "100755" ? 0o755 : 0o644 });
      }
      await writeFile(path.join(staging, COMPLETE_MARKER), snapshot.commitSha);
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
      await chmod(target, 0o755);
      await writePointer(directory, snapshot.commitSha);
      await pruneOldSnapshots(directory, snapshot.commitSha);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      logger.warn({ errorClass: error instanceof Error ? error.constructor.name : typeof error }, "shared skills write failed");
      return { status: "error", reason: "write_failed" };
    }
    return { status: "updated", commitSha: snapshot.commitSha, skills: skillDirectories.size };
  } finally {
    await snapshot.release().catch(() => undefined);
  }
}

async function writePointer(directory: string, commitSha: string): Promise<void> {
  const temporary = path.join(directory, `.pointer-${randomBytes(6).toString("hex")}`);
  await writeFile(temporary, commitSha);
  await rename(temporary, path.join(directory, POINTER_FILE));
}

/** Startup plus every few minutes, unref'd, cleared on shutdown. A no-op when unconfigured. */
export function startSharedSkillsSync(options: RefreshSharedSkillsOptions & { intervalMs?: number } = {}): () => void {
  if (!readSharedSkillsConfig(options.env)) return () => {};
  let active = true;
  let timer: NodeJS.Timeout | null = null;
  const tick = () => {
    refreshSharedSkills(options)
      .then((outcome) => {
        if (outcome.status === "updated") logger.info({ commitSha: outcome.commitSha, skills: outcome.skills }, "shared skills updated");
        else if (outcome.status === "error") logger.warn({ reason: outcome.reason }, "shared skills sync did not publish a snapshot");
      })
      .catch((error) => logger.warn({ errorClass: error instanceof Error ? error.constructor.name : typeof error }, "shared skills sync failed"))
      .finally(() => {
        if (!active) return;
        timer = setTimeout(tick, options.intervalMs ?? SHARED_SKILLS_INTERVAL_MS);
        timer.unref?.();
      });
  };
  const initial = setImmediate(tick);
  return () => {
    active = false;
    clearImmediate(initial);
    if (timer) clearTimeout(timer);
  };
}
