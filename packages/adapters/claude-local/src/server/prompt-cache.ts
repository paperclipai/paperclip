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

// Directive appended after the user-supplied AGENTS.md contents so the agent
// knows where its instructions live and how to resolve sibling files. Exported
// so the bundle-key hasher can fingerprint the template identity: any edit to
// this text automatically invalidates resumed sessions on their next heartbeat.
export const INSTRUCTIONS_PATH_DIRECTIVE_TEMPLATE = (path: string, dir: string): string =>
  `\nThe above agent instructions were loaded from ${path}. ` +
  `Resolve any relative file references from ${dir}. ` +
  `This base directory is authoritative for sibling instruction files such as ` +
  `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.`;

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
    hash.update(`target:${resolved}\n`);
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
    hash.update(`file:${relativePath}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}\n`);
    return;
  }

  hash.update(`other:${relativePath}:${stat.mode}\n`);
}

export async function buildClaudePromptBundleKey(input: {
  skills: SkillEntry[];
  instructionsFilePath: string | null;
  instructionsFileDir: string;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update("paperclip-claude-prompt-bundle:v2\n");
  if (input.instructionsFilePath) {
    const stat = await fs.stat(input.instructionsFilePath).catch(() => null);
    if (stat) {
      hash.update(`instructions:path:${input.instructionsFilePath}\n`);
      hash.update(`instructions:dir:${input.instructionsFileDir}\n`);
      hash.update(`instructions:stat:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}\n`);
      hash.update("instructions:directive:");
      hash.update(INSTRUCTIONS_PATH_DIRECTIVE_TEMPLATE("__path__", "__dir__"));
      hash.update("\n");
    } else {
      hash.update(`instructions:missing:${input.instructionsFilePath}\n`);
    }
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
  instructionsFilePath: string | null;
  instructionsFileDir: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<ClaudePromptBundle> {
  const { companyId, skills, instructionsFilePath: sourceInstructionsFilePath, instructionsFileDir, onLog } = input;

  let combinedInstructionsContents: string | null = null;
  if (sourceInstructionsFilePath) {
    try {
      const instructionsContent = await fs.readFile(sourceInstructionsFilePath, "utf-8");
      combinedInstructionsContents =
        instructionsContent + INSTRUCTIONS_PATH_DIRECTIVE_TEMPLATE(sourceInstructionsFilePath, instructionsFileDir);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${sourceInstructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const bundleKey = await buildClaudePromptBundleKey({
    skills,
    instructionsFilePath: sourceInstructionsFilePath,
    instructionsFileDir,
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

  const materializedInstructionsFilePath = combinedInstructionsContents
    ? path.join(rootDir, "agent-instructions.md")
    : null;
  if (materializedInstructionsFilePath && combinedInstructionsContents) {
    await ensureReadableFile(materializedInstructionsFilePath, combinedInstructionsContents);
  }

  return {
    bundleKey,
    rootDir,
    addDir: rootDir,
    instructionsFilePath: materializedInstructionsFilePath,
  };
}
