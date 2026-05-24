import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

// Files copied from the host's shared ~/.claude into each per-run seed.
// Mirrors claude-local/src/server/claude-config.ts:8.
const SEEDED_SHARED_FILES = [
  ".credentials.json",
  "credentials.json",
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
] as const;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? (error as { code?: unknown }).code : null;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

async function collectSeedFiles(sourceDir: string): Promise<Array<{ name: string; sourcePath: string }>> {
  const files: Array<{ name: string; sourcePath: string }> = [];
  for (const name of SEEDED_SHARED_FILES) {
    const sourcePath = path.join(sourceDir, name);
    if (!(await pathExists(sourcePath))) continue;
    files.push({ name, sourcePath });
  }
  return files;
}

async function buildSeedSnapshotKey(files: Array<{ name: string; sourcePath: string }>): Promise<string> {
  if (files.length === 0) return "empty";
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(await fs.readFile(file.sourcePath));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function materializeSeedSnapshot(input: {
  rootDir: string;
  snapshotKey: string;
  files: Array<{ name: string; sourcePath: string }>;
}): Promise<string> {
  const targetDir = path.join(input.rootDir, input.snapshotKey);
  if (await pathExists(targetDir)) {
    return targetDir;
  }

  await fs.mkdir(input.rootDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(input.rootDir, ".tmp-"));
  try {
    for (const file of input.files) {
      await fs.copyFile(file.sourcePath, path.join(stagingDir, file.name));
    }
    try {
      await fs.rename(stagingDir, targetDir);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return targetDir;
}

export function resolveSharedClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

export function resolveManagedClaudeTuiConfigSeedDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "claude-tui-config-seed")
    : path.resolve(instanceRoot, "claude-tui-config-seed");
}

/**
 * Materialize a content-addressed snapshot of the host's shared Claude config
 * (credentials, settings, etc.) into a Paperclip-managed directory. The
 * adapter copies this snapshot into a per-run CLAUDE_CONFIG_DIR so two TUI
 * sessions cannot corrupt each other's state.
 *
 * Unlike claude-local, the TUI variant ALWAYS runs this — the contract
 * finding (PAPERCLIP_ADAPTER_CONTRACT.md, "Per-agent isolation" section)
 * notes that the TUI persists more session/project state per run than the
 * headless --print CLI, so sharing ~/.claude across agents is unsafe.
 */
export async function prepareClaudeTuiConfigSeed(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const sourceDir = resolveSharedClaudeConfigDir(env);
  const targetRootDir = resolveManagedClaudeTuiConfigSeedDir(env, companyId);

  if (path.resolve(sourceDir) === path.resolve(targetRootDir)) {
    return targetRootDir;
  }

  const copiedFiles = await collectSeedFiles(sourceDir);
  const snapshotKey = await buildSeedSnapshotKey(copiedFiles);
  const targetDir = await materializeSeedSnapshot({
    rootDir: targetRootDir,
    snapshotKey,
    files: copiedFiles,
  });

  if (copiedFiles.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Prepared Claude TUI config seed "${targetDir}" from "${sourceDir}" (${copiedFiles.map((file) => file.name).join(", ")}).\n`,
    );
  } else {
    await onLog(
      "stdout",
      `[paperclip] No local Claude config seed files were found in "${sourceDir}". Claude TUI may require login on first run.\n`,
    );
  }

  return targetDir;
}

/**
 * Copy a seed snapshot into a per-run CLAUDE_CONFIG_DIR. The TUI mutates its
 * config dir as the session progresses (modal state, project history), so we
 * give every run a fresh writable copy and discard it afterwards.
 */
export async function materializePerRunClaudeConfigDir(input: {
  seedDir: string;
  runId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const env = input.env ?? process.env;
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  const runsRoot = path.resolve(instanceRoot, "claude-tui-runs");
  await fs.mkdir(runsRoot, { recursive: true });
  const runDir = await fs.mkdtemp(path.join(runsRoot, `${input.runId}-`));
  if (await pathExists(input.seedDir)) {
    const entries = await fs.readdir(input.seedDir);
    for (const name of entries) {
      // Skip transient .tmp- staging directories that may exist while a sibling
      // seed snapshot is mid-rename.
      if (name.startsWith(".tmp-")) continue;
      const source = path.join(input.seedDir, name);
      const target = path.join(runDir, name);
      await fs.cp(source, target, { recursive: true });
    }
  }
  return runDir;
}

/**
 * Best-effort cleanup of a per-run CLAUDE_CONFIG_DIR after the TUI exits.
 * Swallows errors — the directory lives under PAPERCLIP_HOME and will be
 * cleaned up by housekeeping if this fails.
 */
export async function cleanupPerRunClaudeConfigDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
