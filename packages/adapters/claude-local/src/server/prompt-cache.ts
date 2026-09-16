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

export interface ClaudePromptBundle {
  bundleKey: string;
  compatibilityKey: string;
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

async function isShippedSkill(entry: SkillEntry, shippedSkills: SkillEntry[]): Promise<boolean> {
  // A reserved key alone cannot make an editable/company skill first-party.
  const shipped = shippedSkills.find((candidate) => candidate.key === entry.key && candidate.runtimeName === entry.runtimeName);
  if (!shipped || entry.versionId != null) return false;
  const [actual, expected] = await Promise.all([
    fs.realpath(entry.source).catch(() => null), fs.realpath(shipped.source).catch(() => null),
  ]);
  return actual !== null && actual === expected;
}

async function buildCompatibilityKey(input: {
  skills: SkillEntry[]; shippedSkills: SkillEntry[]; instructionsContents: string | null;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update("paperclip-claude-session-context:v1\n");
  hash.update(JSON.stringify(input.instructionsContents));
  for (const entry of [...input.skills].sort((a, b) => a.runtimeName.localeCompare(b.runtimeName))) {
    const shipped = await isShippedSkill(entry, input.shippedSkills);
    hash.update(JSON.stringify([entry.key, entry.runtimeName, entry.versionId ?? null, shipped]));
    if (!shipped) await hashPathContents(entry.source, hash, entry.runtimeName, new Set());
  }
  return hash.digest("hex");
}

/** Only shipped skill bytes may change without replacing an existing conversation. */
export async function claudePromptBundleCanResume(input: {
  companyId: string; bundle: ClaudePromptBundle; previousBundleKey: string;
  previousCompatibilityKey: string; skills: SkillEntry[]; shippedSkills: SkillEntry[];
  instructionsContents: string | null;
}): Promise<boolean> {
  if (!input.previousBundleKey || input.previousBundleKey === input.bundle.bundleKey) return true;
  if (input.previousCompatibilityKey) return input.previousCompatibilityKey === input.bundle.compatibilityKey;
  // Old sessions have no independent content fingerprint. Their cache contains
  // symlinks, so it cannot prove historical third-party skill bytes. Fail closed.
  if (!/^[a-f0-9]{64}$/.test(input.previousBundleKey) || input.skills.length === 0
    || !(await Promise.all(input.skills.map((skill) => isShippedSkill(skill, input.shippedSkills)))).every(Boolean)) return false;
  const cacheRoot = resolveManagedClaudePromptCacheRoot(process.env, input.companyId);
  const oldRoot = path.join(cacheRoot, input.previousBundleKey);
  try {
    if (await fs.realpath(oldRoot) !== path.join(await fs.realpath(cacheRoot), input.previousBundleKey)) return false;
    const names = await fs.readdir(path.join(oldRoot, ".claude", "skills"));
    if (JSON.stringify(names.sort()) !== JSON.stringify(input.skills.map((entry) => entry.runtimeName).sort())) return false;
    for (const entry of input.skills) {
      const oldSkill = path.join(oldRoot, ".claude", "skills", entry.runtimeName);
      // Legacy bundles used symlinks. Verify their historical source provenance,
      // not just a runtime name that a company-managed skill could also use.
      if (!(await fs.lstat(oldSkill)).isSymbolicLink()
        || await fs.realpath(oldSkill) !== await fs.realpath(entry.source)) return false;
    }
    const instructionsPath = path.join(oldRoot, "agent-instructions.md");
    const stat = await fs.lstat(instructionsPath).catch(() => null);
    if (input.instructionsContents === null) return stat === null;
    if (!stat?.isFile() || stat.size !== Buffer.byteLength(input.instructionsContents)) return false;
    return await fs.readFile(instructionsPath, "utf8") === input.instructionsContents;
  } catch { return false; }
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
  shippedSkills?: SkillEntry[];
}): Promise<ClaudePromptBundle> {
  const { companyId, skills, instructionsContents, onLog } = input;
  const bundleKey = await buildClaudePromptBundleKey({
    skills,
    instructionsContents,
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
    compatibilityKey: await buildCompatibilityKey({ skills, instructionsContents, shippedSkills: input.shippedSkills ?? [] }),
    rootDir,
    addDir: rootDir,
    instructionsFilePath,
  };
}
