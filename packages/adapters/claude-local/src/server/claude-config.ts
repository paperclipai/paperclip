import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

// Only auth/global-settings files are copied into the isolated agent config dir.
// We deliberately do NOT copy `skills/`, `projects/`, `plans/`, `commands/`,
// `sessions/`, `history.jsonl`, `plugins/`, or other personal data — that is the
// entire point of the isolation: keep login working, strip private context.
const SEEDED_SHARED_FILES = [
  ".credentials.json",
  "credentials.json",
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
] as const;

// Marker file written into every isolated config dir so the agent (and human
// auditors) can detect at-a-glance that this is a Paperclip-managed sandbox of
// the user's ~/.claude, not the real thing.
const ISOLATION_MARKER_FILENAME = "PAPERCLIP_AGENT_ISOLATION.md";
const ISOLATION_MARKER_BODY = `# Paperclip Agent Config Isolation

This directory is a Paperclip-managed snapshot of the operator's Claude config.

It contains ONLY the files needed for Claude CLI authentication and the
operator's global Claude settings (\`.credentials.json\`, \`credentials.json\`,
\`settings.json\`, \`settings.local.json\`, \`CLAUDE.md\`).

It deliberately does NOT contain:
- the operator's personal Claude skills (\`~/.claude/skills/\`)
- memories of the operator's other projects (\`~/.claude/projects/*\`)
- the operator's plans, commands, sessions, history, plugins, or tasks

If you are an agent reading this file: you are running inside a Paperclip
ajan workspace. Do not assume the operator's personal skills or other-project
context are available to you — they are intentionally not present.
`;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : null;
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
    // Backfill the isolation marker on pre-existing snapshots created before
    // the marker existed, so audits work even when we reuse a cached seed.
    await fs
      .writeFile(path.join(targetDir, ISOLATION_MARKER_FILENAME), ISOLATION_MARKER_BODY, "utf8")
      .catch(() => undefined);
    return targetDir;
  }

  await fs.mkdir(input.rootDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(input.rootDir, ".tmp-"));
  try {
    for (const file of input.files) {
      await fs.copyFile(file.sourcePath, path.join(stagingDir, file.name));
    }
    await fs.writeFile(path.join(stagingDir, ISOLATION_MARKER_FILENAME), ISOLATION_MARKER_BODY, "utf8");
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

export function resolveSharedClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

export function resolveManagedClaudeConfigSeedDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "claude-config-seed")
    : path.resolve(instanceRoot, "claude-config-seed");
}

export { ISOLATION_MARKER_FILENAME, ISOLATION_MARKER_BODY };

export async function prepareClaudeConfigSeed(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const sourceDir = resolveSharedClaudeConfigDir(env);
  const targetRootDir = resolveManagedClaudeConfigSeedDir(env, companyId);

  if (path.resolve(sourceDir) === path.resolve(targetRootDir)) {
    // Degenerate config (operator pointed CLAUDE_CONFIG_DIR at the seed root).
    // Without this guard we'd skip materialization entirely and the agent would
    // run against the operator's untouched config — defeating isolation.
    await fs.mkdir(targetRootDir, { recursive: true }).catch(() => undefined);
    await fs
      .writeFile(path.join(targetRootDir, ISOLATION_MARKER_FILENAME), ISOLATION_MARKER_BODY, "utf8")
      .catch(() => undefined);
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
      `[paperclip] Prepared Claude config seed "${targetDir}" from "${sourceDir}" (${copiedFiles.map((file) => file.name).join(", ")}).\n`,
    );
  } else {
    await onLog(
      "stdout",
      `[paperclip] No local Claude config seed files were found in "${sourceDir}". Remote Claude auth may still require login.\n`,
    );
  }

  return targetDir;
}
