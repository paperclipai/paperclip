import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

const SEEDED_SHARED_FILES = [
  ".credentials.json",
  "credentials.json",
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
] as const;

/**
 * Files whose seed source is overridden by an active pool account. Only the
 * credential blob is account-specific; settings.json / CLAUDE.md still come from
 * the shared ~/.claude dir so non-credential config is preserved.
 */
const POOL_ACCOUNT_CREDENTIAL_FILES = new Set([".credentials.json", "credentials.json"]);

/**
 * Account Pool & Rotation (Slice 3 — credential injection).
 *
 * When a company is riding a pooled subscription account, the active account's
 * decrypted `.credentials.json` blob is resolved server-side (heartbeat reads
 * account_pool_state + decrypts via the secret service) and threaded down here.
 *
 * Critical constraint (Spec D4): we EXTEND THE SEED SOURCE — we never override
 * env.CLAUDE_CONFIG_DIR from rotation code. A direct env override would bypass
 * the container-sync guard at execute.ts:464-467 (useManagedRemoteClaudeConfig).
 */
export interface PoolAccountSeedInput {
  /** company_secrets.id of the active pooled account */
  accountId: string;
  /** decrypted `.credentials.json` blob for that account */
  credentialsJson: string;
}

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

async function collectSeedFiles(
  sourceDir: string,
  overrides?: Map<string, string>,
): Promise<Array<{ name: string; sourcePath: string }>> {
  const files: Array<{ name: string; sourcePath: string }> = [];
  for (const name of SEEDED_SHARED_FILES) {
    const sourcePath = overrides?.get(name) ?? path.join(sourceDir, name);
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

/**
 * Deterministic per-account directory that holds the decrypted credential blob
 * used as the seed SOURCE for `.credentials.json`. Keyed by company + account so
 * two accounts (or two companies) resolve to two distinct source dirs; the
 * downstream snapshot/hash system then guarantees per-content seed isolation.
 */
export function resolvePoolAccountSeedDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
  accountId: string,
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
    "pool-accounts",
    accountId,
    "credentials-src",
  );
}

/**
 * Materialize an active pool account's decrypted `.credentials.json` into its
 * per-account source dir and return the map of seed-file name -> source path so
 * only the credential blob is sourced from the account (everything else still
 * comes from the shared ~/.claude dir).
 */
async function materializePoolAccountCredentialSource(input: {
  env: NodeJS.ProcessEnv;
  companyId: string;
  poolAccount: PoolAccountSeedInput;
}): Promise<Map<string, string>> {
  const seedDir = resolvePoolAccountSeedDir(input.env, input.companyId, input.poolAccount.accountId);
  await fs.mkdir(seedDir, { recursive: true });
  const credentialsPath = path.join(seedDir, ".credentials.json");
  const stagingPath = `${credentialsPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(stagingPath, input.poolAccount.credentialsJson, { mode: 0o600 });
  await fs.rename(stagingPath, credentialsPath);

  const overrides = new Map<string, string>();
  for (const name of POOL_ACCOUNT_CREDENTIAL_FILES) {
    overrides.set(name, credentialsPath);
  }
  return overrides;
}

export async function prepareClaudeConfigSeed(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
  poolAccount?: PoolAccountSeedInput | null,
): Promise<string> {
  const sourceDir = resolveSharedClaudeConfigDir(env);
  const targetRootDir = resolveManagedClaudeConfigSeedDir(env, companyId);

  if (path.resolve(sourceDir) === path.resolve(targetRootDir)) {
    return targetRootDir;
  }

  // When a pooled account is active for this company, source `.credentials.json`
  // from THAT account's decrypted blob instead of the shared ~/.claude dir.
  // Backward-compat: no pool account => identical behavior to before.
  const credentialOverrides =
    poolAccount && companyId
      ? await materializePoolAccountCredentialSource({ env, companyId, poolAccount })
      : undefined;

  const copiedFiles = await collectSeedFiles(sourceDir, credentialOverrides);
  const snapshotKey = await buildSeedSnapshotKey(copiedFiles);
  const targetDir = await materializeSeedSnapshot({
    rootDir: targetRootDir,
    snapshotKey,
    files: copiedFiles,
  });

  if (copiedFiles.length > 0) {
    const poolNote = credentialOverrides
      ? ` [pool account ${poolAccount!.accountId} credentials]`
      : "";
    await onLog(
      "stdout",
      `[paperclip] Prepared Claude config seed "${targetDir}" from "${sourceDir}"${poolNote} (${copiedFiles.map((file) => file.name).join(", ")}).\n`,
    );
  } else {
    await onLog(
      "stdout",
      `[paperclip] No local Claude config seed files were found in "${sourceDir}". Remote Claude auth may still require login.\n`,
    );
  }

  return targetDir;
}
