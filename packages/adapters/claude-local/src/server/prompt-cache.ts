import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, type Hash } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  ensurePaperclipSkillSymlink,
  resolvePaperclipInstanceRootForAdapter,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";

type SkillEntry = PaperclipSkillEntry;

/**
 * Error code raised when the skills source cannot be read while computing the
 * prompt-cache bundle key — most commonly because a deploy is swapping the
 * worktree out from under an in-flight run (EPERM/ENOENT/EBUSY on a
 * `…/skills/…` source path). It is deliberately distinct from the generic
 * `adapter_failed` so recovery can treat it as a retryable, swap-window-spanning
 * transient rather than a hard failure that burns the run and false-escalates
 * the issue to `blocked`.
 */
export const SKILLS_SOURCE_UNAVAILABLE_ERROR_CODE = "skills_source_unavailable";

export class SkillsSourceUnavailableError extends Error {
  code = SKILLS_SOURCE_UNAVAILABLE_ERROR_CODE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SkillsSourceUnavailableError";
  }
}

// File-system error codes that indicate the skills source is *temporarily*
// unreadable (a worktree swap in progress), not permanently broken. Re-reading
// the same source a moment later usually succeeds once the swap completes.
const TRANSIENT_SKILLS_SOURCE_FS_ERROR_CODES = new Set(["EPERM", "EACCES", "ENOENT", "EBUSY"]);

export function transientSkillsSourceFsErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSIENT_SKILLS_SOURCE_FS_ERROR_CODES.has(code) ? code : null;
}

// Bounded in-process retry budget for a skills-source read that fails with a
// transient FS error. Short by design: it lets a run ride out a *brief* swap
// window without holding the process hostage. Longer swaps fall through to the
// dedicated `skills_source_unavailable` error, where recovery/service.ts backs
// off across the full (~18–20 min) swap window instead of burning attempts here.
const SKILLS_SOURCE_RETRY_INITIAL_DELAY_MS = 250;
const SKILLS_SOURCE_RETRY_MAX_DELAY_MS = 4_000;
const SKILLS_SOURCE_RETRY_BUDGET_MS = 30_000;

export interface ClaudePromptBundle {
  bundleKey: string;
  rootDir: string;
  addDir: string;
  instructionsFilePath: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveManagedClaudePromptCacheRoot(
  env: NodeJS.ProcessEnv,
  companyId: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(
    instanceRoot,
    "companies",
    companyId,
    "claude-prompt-cache",
  );
}

async function hashPathContents(
  candidate: string,
  hash: Hash,
  relativePath: string,
  seenDirectories: Set<string>,
): Promise<void> {
  const stat = await fs.lstat(candidate);

  if (stat.isSymbolicLink()) {
    hash.update(`symlink:${relativePath}\n`);
    const resolved = await fs.realpath(candidate).catch(() => null);
    if (!resolved) {
      hash.update("missing\n");
      return;
    }
    await hashPathContents(resolved, hash, relativePath, seenDirectories);
    return;
  }

  if (stat.isDirectory()) {
    const realDir = await fs.realpath(candidate).catch(() => candidate);
    hash.update(`dir:${relativePath}\n`);
    if (seenDirectories.has(realDir)) {
      hash.update("loop\n");
      return;
    }
    seenDirectories.add(realDir);
    const entries = await fs.readdir(candidate, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelativePath = relativePath.length > 0 ? `${relativePath}/${entry.name}` : entry.name;
      await hashPathContents(path.join(candidate, entry.name), hash, childRelativePath, seenDirectories);
    }
    return;
  }

  if (stat.isFile()) {
    hash.update(`file:${relativePath}\n`);
    hash.update(await fs.readFile(candidate));
    hash.update("\n");
    return;
  }

  hash.update(`other:${relativePath}:${stat.mode}\n`);
}

async function buildClaudePromptBundleKey(input: {
  skills: SkillEntry[];
  instructionsContents: string | null;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update("paperclip-claude-prompt-bundle:v1\n");
  if (input.instructionsContents) {
    hash.update("instructions\n");
    hash.update(input.instructionsContents);
    hash.update("\n");
  } else {
    hash.update("instructions:none\n");
  }

  const sortedSkills = [...input.skills].sort((left, right) => left.runtimeName.localeCompare(right.runtimeName));
  for (const entry of sortedSkills) {
    hash.update(`skill:${entry.key}:${entry.runtimeName}\n`);
    await hashPathContents(entry.source, hash, entry.runtimeName, new Set<string>());
  }

  return hash.digest("hex");
}

/**
 * Compute the bundle key, tolerating a *transient* skills-source read failure
 * (a deploy worktree swap in progress) with a short bounded retry. Critically it
 * NEVER swallows the failure into an empty/partial hash — the whole key is
 * recomputed from scratch on each attempt, so a stale bundle can never be
 * reused. If the source stays unreadable past the retry budget it raises the
 * dedicated retryable {@link SkillsSourceUnavailableError} instead of letting a
 * generic FS error surface as `adapter_failed`.
 */
export async function buildClaudePromptBundleKeyWithSwapRetry(
  input: {
    skills: SkillEntry[];
    instructionsContents: string | null;
    onLog: AdapterExecutionContext["onLog"];
  },
  options?: {
    retryBudgetMs?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    computeKey?: (bundleInput: {
      skills: SkillEntry[];
      instructionsContents: string | null;
    }) => Promise<string>;
  },
): Promise<string> {
  const retryBudgetMs = options?.retryBudgetMs ?? SKILLS_SOURCE_RETRY_BUDGET_MS;
  const initialDelayMs = options?.initialDelayMs ?? SKILLS_SOURCE_RETRY_INITIAL_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? SKILLS_SOURCE_RETRY_MAX_DELAY_MS;
  const now = options?.now ?? (() => Date.now());
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const computeKey = options?.computeKey ?? buildClaudePromptBundleKey;

  const deadline = now() + retryBudgetMs;
  let attempt = 0;
  let delayMs = initialDelayMs;
  for (;;) {
    try {
      return await computeKey({
        skills: input.skills,
        instructionsContents: input.instructionsContents,
      });
    } catch (err) {
      const fsCode = transientSkillsSourceFsErrorCode(err);
      if (!fsCode) throw err;
      attempt += 1;
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new SkillsSourceUnavailableError(
          `Skills source was unreadable (${fsCode}) after ${attempt} attempt(s) over ` +
            `${retryBudgetMs}ms; a deploy worktree swap is likely in progress.`,
          { cause: err },
        );
      }
      await input.onLog(
        "stderr",
        `[paperclip] Skills source temporarily unreadable (${fsCode}); retrying prompt-cache ` +
          `key (attempt ${attempt}) — likely a deploy worktree swap.\n`,
      );
      await sleep(Math.min(delayMs, remaining, maxDelayMs));
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}

async function ensureReadableFile(targetPath: string, contents: string): Promise<void> {
  try {
    await fs.access(targetPath, fsConstants.R_OK);
    return;
  } catch {
    // Fall through and materialize the file.
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, contents, "utf8");
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    const targetReadable = await fs.access(targetPath, fsConstants.R_OK).then(() => true).catch(() => false);
    if (!targetReadable) {
      throw err;
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function prepareClaudePromptBundle(input: {
  companyId: string;
  skills: SkillEntry[];
  instructionsContents: string | null;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<ClaudePromptBundle> {
  const { companyId, skills, instructionsContents, onLog } = input;
  const bundleKey = await buildClaudePromptBundleKeyWithSwapRetry({
    skills,
    instructionsContents,
    onLog,
  });
  const rootDir = path.join(resolveManagedClaudePromptCacheRoot(process.env, companyId), bundleKey);
  const skillsHome = path.join(rootDir, ".claude", "skills");
  await fs.mkdir(skillsHome, { recursive: true });

  for (const entry of skills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      await ensurePaperclipSkillSymlink(entry.source, target);
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to materialize Claude skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const instructionsFilePath = instructionsContents
    ? path.join(rootDir, "agent-instructions.md")
    : null;
  if (instructionsFilePath && instructionsContents) {
    await ensureReadableFile(instructionsFilePath, instructionsContents);
  }

  return {
    bundleKey,
    rootDir,
    addDir: rootDir,
    instructionsFilePath,
  };
}
