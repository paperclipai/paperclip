import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { isCodexAuthCachePath, readSubscriptionAccountId, resolveCodexAuthCacheDir } from "./codex-auth-cache.js";
import {
  type SafeHandle,
  lstatChild,
  listPinnedDirectory,
  openChildNoFollow,
  openDirectoryNoFollow,
  openPathNoFollow,
  readChildLink,
  readRegularFileNoFollow,
  removeFileNoFollow,
  replaceRegularFileNoFollow,
} from "./safe-home-files.js";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const MANAGED_MCP_BLOCK_START = "# BEGIN PAPERCLIP MANAGED MCP";
const MANAGED_MCP_BLOCK_END = "# END PAPERCLIP MANAGED MCP";

/**
 * The allowlist of managed `CODEX_HOME` entries that the codex-local adapter
 * stages into the sandbox `home` asset (see {@link stageCodexHomeForSync}).
 * Derived from the seeding constants so it can never drift from what the adapter
 * actually writes into the home: the copied static config files, the symlinked
 * credential file, and the injected `skills/` directory. Everything else the
 * stock upstream `codex` binary writes at runtime (`*.sqlite`, `*-wal`,
 * `plugins/`, `cache/`, `sessions/`, `shell_snapshots/`, …) is intentionally
 * excluded — it is large host-local runtime state the sandbox run never needs.
 */
export const CODEX_SYNC_ALLOWLIST = [
  ...COPIED_SHARED_FILES,
  ...SYMLINKED_SHARED_FILES,
  "skills",
] as const;

export type ManagedCodexMcpGateway = {
  name: string;
  endpointPath: string;
  bearerToken: string;
};

export function mergeManagedCodexMcpGateways(
  primary: ManagedCodexMcpGateway[],
  secondary: ManagedCodexMcpGateway[],
): ManagedCodexMcpGateway[] {
  const merged = [...primary];
  const names = new Set(primary.map((gateway) => gateway.name));
  for (const gateway of secondary) {
    if (names.has(gateway.name)) continue;
    merged.push(gateway);
    names.add(gateway.name);
  }
  return merged;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

// Co-change notice: this function's logic is mirrored by parseAuth in
// packages/adapter-utils/src/sandbox-managed-runtime.ts (buildCodexAuthMergeDecisionScript).
// If the auth format changes (new shape, renamed field), update both sites together.
function hasUsableAuthPayload(authPayload: unknown): boolean {
  if (authPayload === null || typeof authPayload !== "object" || Array.isArray(authPayload)) {
    return false;
  }

  const parsedPayload = authPayload as Record<string, unknown>;
  const apiKey = parsedPayload.OPENAI_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    return true;
  }

  const tokens = parsedPayload.tokens;
  if (tokens !== null && typeof tokens === "object" && !Array.isArray(tokens)) {
    const parsedTokens = tokens as Record<string, unknown>;
    const accountId = parsedTokens.account_id;
    const hasAccountId = typeof accountId === "string" && accountId.trim().length > 0;
    const hasTokenMaterial = ["id_token", "access_token", "refresh_token"].some((key) => {
      const value = parsedTokens[key];
      return typeof value === "string" && value.trim().length > 0;
    });
    if (hasAccountId && hasTokenMaterial) return true;
  }

  return false;
}

function readApiKeyFromAuthPayload(authPayload: unknown): string | null {
  if (authPayload === null || typeof authPayload !== "object" || Array.isArray(authPayload)) {
    return null;
  }
  const raw = (authPayload as Record<string, unknown>).OPENAI_API_KEY;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * The `last_refresh` timestamp of an auth.json payload, in epoch milliseconds,
 * or null when the bytes are unreadable or carry no parseable timestamp. This is
 * the same freshness field the shared merge decision predicate
 * (`codex-auth-merge-decision.cjs`) compares, read the same way, so the seeding
 * heal below and the credential writers agree on what "fresher" means.
 */
function readAuthLastRefreshMs(bytes: Buffer | null): number | null {
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const raw = (parsed as Record<string, unknown>).last_refresh;
  const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function resolveSharedCodexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CODEX_HOME);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".codex");
}

function isWorktreeMode(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_ENV_RE.test(env.PAPERCLIP_IN_WORKTREE ?? "");
}

export function resolveManagedCodexHomeDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "codex-home")
    : path.resolve(instanceRoot, "codex-home");
}

/**
 * True when `homePath` lives under the Paperclip-managed company tree
 * (`<instanceRoot>/companies/<companyId>/...`). This covers both the shared
 * company `codex-home` and the per-agent `agents/<agentId>/codex-home` set by
 * the server-side isolation guard. A path outside that tree is a genuine
 * external/user-supplied override that Paperclip must not seed or overwrite.
 */
export function isManagedCodexHomePath(
  env: NodeJS.ProcessEnv,
  companyId: string | undefined,
  homePath: string,
): boolean {
  if (!companyId) return false;
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  const companyRoot = path.resolve(instanceRoot, "companies", companyId);
  const resolved = path.resolve(homePath);
  return resolved === companyRoot || resolved.startsWith(companyRoot + path.sep);
}

/** A connector run may only seed auth from a server-selected home when the
 * service itself holds file-backed database credentials. The digest and the
 * agent's CODEX_HOME are not proof that a path is a credential source. */
export async function assertTrustedConnectorAuthSourceHome(input: {
  env: NodeJS.ProcessEnv;
  companyId: string;
  agentId: string;
  sourceHome: string | null;
  managedAiConnection: boolean;
}): Promise<void> {
  const { env, companyId, agentId, sourceHome, managedAiConnection } = input;
  if (!env.PAPERCLIP_DATABASE_URL_FILE?.trim() || sourceHome === null) return;
  const source = path.resolve(sourceHome);
  const companyHome = resolveManagedCodexHomeDir(env, companyId);
  const agentHome = path.join(path.dirname(companyHome), "agents", agentId, "codex-home");
  const cacheRoot = resolveCodexAuthCacheDir(env, companyId);
  const isCacheEntry = path.dirname(source) === cacheRoot && path.basename(source) !== ".";
  if ([resolveSharedCodexHomeDir(env), companyHome, agentHome].some((home) => source === path.resolve(home)) || isCacheEntry) {
    return;
  }
  // A managed AI connection gets a short-lived credential home created by the
  // server. Its private root is owned by this service, not by the local agent.
  if (managedAiConnection && path.basename(source) === "provider") {
    const sessionHome = path.dirname(source);
    const serviceUid = process.getuid?.();
    if (serviceUid !== undefined && path.dirname(sessionHome) === path.resolve(os.tmpdir())
      && path.basename(sessionHome).startsWith(`paperclip-ai-${companyId}-`)) {
      const [rootStat, sourceStat] = await Promise.all([fs.lstat(sessionHome), fs.lstat(source)]);
      if (rootStat.isDirectory() && sourceStat.isDirectory()
        && rootStat.uid === serviceUid && sourceStat.uid === serviceUid
        && (rootStat.mode & 0o077) === 0 && (sourceStat.mode & 0o077) === 0) return;
    }
  }
  throw new Error("Connector CODEX_HOME is not a trusted auth source in file-backed database mode");
}

/**
 * True when the Codex home has a usable `auth.json`. Uses `fs.access` (follows
 * symlinks), so a dangling auth symlink whose source has been removed counts as
 * no usable credentials.
 */
export async function codexHomeHasUsableAuth(home: string): Promise<boolean> {
  const authPath = path.join(home, "auth.json");
  if (!(await pathExists(authPath))) return false;
  try {
    const raw = await fs.readFile(authPath, "utf8");
    const parsed = JSON.parse(raw);
    return hasUsableAuthPayload(parsed);
  } catch {
    return false;
  }
}

async function codexHomeHasMatchingApiKeyAuth(home: string, apiKey: string): Promise<boolean> {
  const authPath = path.join(home, "auth.json");
  const existing = await fs.lstat(authPath).catch(() => null);
  if (!existing || existing.isSymbolicLink()) return false;
  try {
    const raw = await fs.readFile(authPath, "utf8");
    const parsed = JSON.parse(raw);
    return readApiKeyFromAuthPayload(parsed) === apiKey.trim();
  } catch {
    return false;
  }
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function isExpectedSymlink(target: string, source: string): Promise<boolean> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing?.isSymbolicLink()) return false;

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return false;

  return path.resolve(path.dirname(target), linkedPath) === path.resolve(source);
}

async function createExpectedSymlink(target: string, source: string): Promise<void> {
  try {
    await fs.symlink(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && await isExpectedSymlink(target, source)) return;
    throw error;
  }
}

export async function ensureSymlink(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await createExpectedSymlink(target, source);
    return;
  }

  if (!existing.isSymbolicLink()) {
    // A previous Paperclip version copied this file into the managed home
    // instead of symlinking it. Codex refresh tokens rotate and are
    // single-use, so a stale copy fails with refresh_token_reused on the next
    // run (#5028). Replace the regular file with a symlink so the CLI follows
    // the live source. Safe to delete: target is always under the
    // Paperclip-managed company home, never the user's real ~/.codex.
    // Directories are left alone — `fs.unlink` would throw EISDIR on Unix
    // (and behave inconsistently on Windows). A directory at this path is not
    // a Paperclip-written stale copy and warrants operator inspection rather
    // than silent removal.
    if (existing.isDirectory()) return;
    await fs.unlink(target);
    await createExpectedSymlink(target, source);
    return;
  }

  if (await isExpectedSymlink(target, source)) return;

  await fs.unlink(target);
  await createExpectedSymlink(target, source);
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isFile()) return;
  if (existing && !existing.isSymbolicLink()) {
    throw new Error("Managed Codex home copy target is not a regular file");
  }
  const bytes = await readRegularFileNoFollow(source);
  if (!bytes) throw new Error("Managed Codex home copy source is missing or linked");
  await ensureParentDir(target);
  await replaceRegularFileNoFollow(target, bytes);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function sanitizeMcpServerName(value: string, fallback: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function stripManagedMcpBlock(config: string): string {
  const start = config.indexOf(MANAGED_MCP_BLOCK_START);
  if (start < 0) return config.trimEnd();
  const end = config.indexOf(MANAGED_MCP_BLOCK_END, start);
  if (end < 0) return config.slice(0, start).trimEnd();
  return `${config.slice(0, start)}${config.slice(end + MANAGED_MCP_BLOCK_END.length)}`.trimEnd();
}

function readCodexMcpServerNames(config: string): Set<string> {
  const names = new Set<string>();
  for (const match of config.matchAll(/^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([^\]\s#]+))\s*\]/gm)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) names.add(name.trim());
  }
  return names;
}

function buildManagedMcpBlock(input: {
  gateways: ManagedCodexMcpGateway[];
  apiBaseUrl: string;
  existingNames: Set<string>;
}): { block: string; warnings: string[] } {
  const warnings: string[] = [];
  const usedNames = new Set<string>();
  const lines = [
    MANAGED_MCP_BLOCK_START,
    "# Written by Paperclip for governed MCP gateway access. Do not edit this block by hand.",
  ];
  input.gateways.forEach((gateway, index) => {
    const baseName = sanitizeMcpServerName(gateway.name, `gateway-${index + 1}`);
    const directOverlap = input.existingNames.has(gateway.name) || input.existingNames.has(baseName);
    let managedName = directOverlap ? `paperclip-${baseName}` : baseName;
    let suffix = 2;
    while (usedNames.has(managedName) || input.existingNames.has(managedName)) {
      managedName = `paperclip-${baseName}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(managedName);
    if (directOverlap) {
      warnings.push(
        `Found unmanaged Codex MCP server "${gateway.name}" overlapping a Paperclip-governed gateway; leaving the direct entry in place and adding managed gateway "${managedName}". Paperclip cannot enforce policies for that direct entry.`,
      );
    }
    const url = new URL(gateway.endpointPath, input.apiBaseUrl).toString();
    lines.push(
      "",
      `[mcp_servers.${tomlString(managedName)}]`,
      `url = ${tomlString(url)}`,
      `http_headers = { Authorization = ${tomlString(`Bearer ${gateway.bearerToken}`)} }`,
    );
  });
  lines.push(MANAGED_MCP_BLOCK_END);
  return { block: lines.join("\n"), warnings };
}

export async function writeManagedCodexMcpConfig(input: {
  codexHome: string;
  apiBaseUrl: string;
  gateways: ManagedCodexMcpGateway[];
}): Promise<{ configPath: string; warnings: string[] }> {
  const configPath = path.join(input.codexHome, "config.toml");
  await fs.mkdir(input.codexHome, { recursive: true });
  const existing = (await readRegularFileNoFollow(configPath))?.toString("utf8") ?? "";
  const unmanagedConfig = stripManagedMcpBlock(existing);
  const { block, warnings } = buildManagedMcpBlock({
    gateways: input.gateways,
    apiBaseUrl: input.apiBaseUrl,
    existingNames: readCodexMcpServerNames(unmanagedConfig),
  });
  const next = input.gateways.length > 0
    ? `${unmanagedConfig}${unmanagedConfig ? "\n\n" : ""}${block}\n`
    : `${unmanagedConfig}${unmanagedConfig ? "\n" : ""}`;
  await replaceRegularFileNoFollow(configPath, next);
  return { configPath, warnings };
}

/**
 * Writes an `auth.json` containing only `OPENAI_API_KEY` so the codex CLI can
 * authenticate via API key. Overwrites any existing file or symlink at that
 * path. Required because the codex CLI (>= 0.122) ignores the `OPENAI_API_KEY`
 * environment variable and only reads credentials from `$CODEX_HOME/auth.json`.
 */
export async function writeApiKeyAuthJson(home: string, apiKey: string): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  const target = path.join(home, "auth.json");
  await replaceRegularFileNoFollow(target, JSON.stringify({ OPENAI_API_KEY: apiKey }));
}

export interface StageCodexHomeForSyncOptions {
  /** Run id, used only to make the staged temp-dir name traceable in logs. */
  runId?: string;
  /** Exact trusted chain for a managed auth.json symlink, ending at a regular file. */
  authSourcePaths?: readonly string[];
  /** Selected, server-resolved skill sources. Unlisted home entries are never staged. */
  skillSources?: readonly { name: string; source: string }[];
}

/** Copy bytes from an already-open inode. An agent replacing its path cannot
 * redirect the service read after this point. */
async function stagePinnedEntry(source: SafeHandle, target: string, preserveExecutable = false): Promise<void> {
  const stat = await source.stat();
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of await listPinnedDirectory(source)) {
      const child = await openChildNoFollow(source, name);
      if (!child) continue; // Never follow nested links, including directory aliases.
      try {
        await stagePinnedEntry(child, path.join(target, name), preserveExecutable);
      } finally {
        await child.close();
      }
    }
  } else if (stat.isFile()) {
    const mode = preserveExecutable && (stat.mode & 0o111) !== 0 ? 0o700 : 0o600;
    await fs.writeFile(target, await source.readFile(), { mode });
    await fs.chmod(target, mode);
  }
  // Sockets, devices and nonblocking FIFOs are not staging inputs.
}

async function readBoundAuthSource(sources: readonly string[], index = 0): Promise<Buffer | null> {
  const source = sources[index];
  if (!source) throw new Error("Unbound Codex auth symlink");
  const dir = await openDirectoryNoFollow(path.dirname(source)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!dir) return null;
  try {
    const name = path.basename(source);
    const stat = await lstatChild(dir, name);
    if (!stat) return null;
    if (stat.isSymbolicLink()) {
      const next = sources[index + 1];
      const linked = await readChildLink(dir, name);
      if (!next || !linked || path.resolve(path.dirname(source), linked) !== path.resolve(next)) {
        throw new Error("Codex auth symlink escaped its expected source");
      }
      return readBoundAuthSource(sources, index + 1);
    }
    if (!stat.isFile()) throw new Error("Codex auth source is not a regular file");
    const handle = await openChildNoFollow(dir, name);
    if (!handle) throw new Error("Codex auth source changed during staging");
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Codex auth source changed type");
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } finally {
    await dir.close();
  }
}

async function stageCodexHomeEntry(
  sourceHome: SafeHandle,
  sourceHomePath: string,
  stagedHome: string,
  entry: (typeof CODEX_SYNC_ALLOWLIST)[number],
  options: StageCodexHomeForSyncOptions,
): Promise<void> {
  const stat = await lstatChild(sourceHome, entry);
  if (!stat) return;
  const target = path.join(stagedHome, entry);

  if (entry === "skills") {
    if (!stat.isDirectory()) throw new Error("Codex skills entry is not a directory");
    const skills = await openChildNoFollow(sourceHome, entry);
    if (!skills) throw new Error("Codex skills directory changed during staging");
    try {
      if (!(await skills.stat()).isDirectory()) throw new Error("Codex skills entry changed type");
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      if (options.skillSources) {
        const seen = new Set<string>();
        for (const skill of options.skillSources) {
          if (skill.name === "." || skill.name === ".." || path.basename(skill.name) !== skill.name || seen.has(skill.name)) {
            throw new Error("Invalid selected Codex skill name");
          }
          seen.add(skill.name);
          const source = await openPathNoFollow(skill.source);
          if (!source) throw new Error("Selected Codex skill source is missing or linked");
          try {
            await stagePinnedEntry(source, path.join(target, skill.name), true);
          } finally {
            await source.close();
          }
        }
      } else {
        // Standalone staging callers can carry regular files/dirs; links are
        // always skipped. Production callers provide the exact selected set.
        for (const name of await listPinnedDirectory(skills)) {
          const source = await openChildNoFollow(skills, name);
          if (!source) continue;
          try {
            await stagePinnedEntry(source, path.join(target, name), true);
          } finally {
            await source.close();
          }
        }
      }
    } finally {
      await skills.close();
    }
    return;
  }

  if (entry === "auth.json" && stat.isSymbolicLink()) {
    const expected = options.authSourcePaths?.[0];
    const linked = await readChildLink(sourceHome, entry);
    if (!expected || !linked || path.resolve(sourceHomePath, linked) !== path.resolve(expected)) {
      throw new Error("Codex auth symlink escaped its expected source");
    }
    const bytes = await readBoundAuthSource(options.authSourcePaths ?? []);
    if (bytes) {
      await fs.writeFile(target, bytes, { mode: 0o600 });
      await fs.chmod(target, 0o600);
    }
    return;
  }
  if (!stat.isFile()) throw new Error("Codex home allowlist entry is not a regular file");
  const source = await openChildNoFollow(sourceHome, entry);
  if (!source) throw new Error("Codex home entry changed during staging");
  try {
    if (!(await source.stat()).isFile()) throw new Error("Codex home entry changed type");
    await stagePinnedEntry(source, target);
  } finally {
    await source.close();
  }
}

/**
 * Stages exactly {@link CODEX_SYNC_ALLOWLIST} from `effectiveCodexHome` into a
 * fresh private temp dir and returns its path, for registration as the sandbox
 * `home` asset. This replaces syncing the whole managed home + a name denylist:
 * only the files Codex actually needs are uploaded, so oversized runtime state
 * (`sessions/`, `*.sqlite`, `plugins/`, …) never reaches the sandbox.
 *
 * - **Only bound symlinks are read** — managed `auth.json` is read from its
 *   expected source chain and selected skills from server-resolved sources.
 *   Agent-controlled links and directory aliases are never followed.
 * - **Missing-but-optional entries are skipped** — no `auth.json` in
 *   keyring-credential mode, or no `config.json`, is not an error.
 * - **`mkdtemp` guarantees the staged dir is `0700`** on POSIX. Credential and
 *   config files are `0600`; selected skill executables retain only owner
 *   execute permission (`0700`). Nothing staged is group/other-readable.
 * - **Fail-closed** — any *unexpected* I/O error removes the partial temp dir
 *   and re-throws, so a run never proceeds with a partial or empty home.
 *
 * The caller owns removing the returned dir on run teardown.
 */
export async function stageCodexHomeForSync(
  effectiveCodexHome: string,
  options: StageCodexHomeForSyncOptions = {},
): Promise<string> {
  const runIdPart = nonEmpty(options.runId ?? undefined);
  const stagedHome = await fs.mkdtemp(
    path.join(os.tmpdir(), `paperclip-codex-home-sync-${runIdPart ? `${runIdPart}-` : ""}`),
  );
  try {
    const sourceHome = await openDirectoryNoFollow(effectiveCodexHome);
    try {
      for (const entry of CODEX_SYNC_ALLOWLIST) {
        await stageCodexHomeEntry(sourceHome, effectiveCodexHome, stagedHome, entry, options);
      }
    } finally {
      await sourceHome.close();
    }
    return stagedHome;
  } catch (error) {
    // Fail-closed: never hand back a partial home. Remove the temp dir we
    // created before propagating the failure.
    await fs.rm(stagedHome, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Seeds auth/config into an explicit Paperclip-managed `targetHome`. Symlinks
 * `auth.json` from the shared source home (so ChatGPT-subscription credentials
 * stay live and single-use refresh tokens are not copied), copies the static
 * shared config files, and — when an API key is supplied — writes an API-key
 * `auth.json` instead. A promoted device-login credential — a regular-file
 * `auth.json` holding a subscription identity the shared source does not hold,
 * or the same identity with a `last_refresh` the shared source has not strictly
 * moved past — is kept authoritative: it is neither removed nor replaced by the
 * shared symlink. Used both for the default company home and for the per-agent
 * home set by the server isolation guard.
 */
export async function seedManagedCodexHome(
  targetHome: string,
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  options: { apiKey?: string | null } = {},
): Promise<void> {
  const apiKey = nonEmpty(options.apiKey ?? undefined);

  const sourceHome = resolveSharedCodexHomeDir(env);
  const seedFromShared = path.resolve(sourceHome) !== path.resolve(targetHome);

  // A per-identity credential-store entry is not a seedable home: its
  // auth.json is the durable, identity-anchored result of a device login,
  // maintained by the promotion, the vend, and the copy-back under their own
  // locks. An agent can bind `CODEX_HOME` to an entry through the login's
  // account-home secret, and this pass runs before every probe and execute —
  // symlinking the entry to the shared source would silently swap the bound
  // account for the host login, and an API-key rewrite would destroy the
  // stored credential outright. The static shared config files still copy
  // in below, so a bound run gets the same config a per-agent home gets.
  const credentialStoreEntry = isCodexAuthCachePath(env, targetHome);

  await fs.mkdir(targetHome, { recursive: true });

  // A regular-file auth.json in the target home is one of two very different
  // things. The device-login promotion writes the company credential as a
  // regular file, and that file is the durable outcome of an interactive login,
  // so it must survive re-seeding. Everything else — an apikey-mode file left by
  // a previous run, a stale pre-symlink copy of the shared credential (#5028),
  // or an unreadable payload — is residue, and removing it lets the chatgpt-mode
  // symlink be restored (ensureSymlink would otherwise replace it and Codex
  // would keep authenticating with the stale key).
  //
  // The discriminator is identity- and freshness-anchored, like the promotion
  // and the cache vend: keep the file when it holds a usable subscription
  // identity that the shared source does not also hold, and also when it holds
  // the SAME identity but the shared source is not strictly fresher by
  // `last_refresh`. A device login for the account the host is also signed in
  // to promotes a file strictly newer than the host copy; swapping that file
  // for the symlink would sign the company back in with the very credential the
  // login just replaced — the failing one that made the user sign in. The
  // #5028 stale copy is the strictly-older direction of the same comparison,
  // and it still heals: the live host credential refreshes on use, so as soon
  // as the shared source is strictly fresher the swap applies. Ties and
  // unparseable freshness keep the file — the same fail-closed direction the
  // shared merge decision predicate uses — because deleting a promoted
  // credential is irreversible while keeping it self-corrects on the next seed
  // once the source has provably moved past it. A different-identity (or
  // source-less) subscription file is the promoted company credential; on a
  // server with no shared login there is nothing to symlink at all, and
  // deleting it would silently sign the company out right after a successful
  // device login.
  let keepPromotedAuth = false;
  if (!apiKey && seedFromShared && !credentialStoreEntry) {
    const authPath = path.join(targetHome, "auth.json");
    const existing = await fs.lstat(authPath).catch(() => null);
    if (existing && !existing.isSymbolicLink()) {
      const targetBytes = await readRegularFileNoFollow(authPath).catch(() => null);
      const targetIdentity = targetBytes ? readSubscriptionAccountId(targetBytes) : null;
      if (targetIdentity) {
        // Any source read failure — absent or unreadable — keeps the usable
        // target file. The alternative, removal plus the existence-only
        // symlink pass below, links the home to a source this process just
        // failed to read, and every downstream reader (the probe seeding, the
        // sandbox stage sync, the CLI itself) runs with the same access, so
        // that home is unusable in every scenario. Keeping the target is
        // better or equal in each case: a promoted credential keeps working,
        // and even a stale same-identity copy (#5028) can still work, while
        // the unreadable symlink cannot. A transient read failure also
        // self-corrects — the next seed with a readable source heals a
        // same-identity copy into the symlink — whereas removing the promoted
        // credential is irreversible. The #5028 heal therefore applies
        // exactly when the source is readable and the identities match.
        let sourceReadErrorCode: string | null = null;
        const sourceBytes = await readRegularFileNoFollow(path.join(sourceHome, "auth.json"))
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
              sourceReadErrorCode = error.code ?? "unknown";
            }
            return null;
          });
        const sourceIdentity = sourceBytes ? readSubscriptionAccountId(sourceBytes) : null;
        if (sourceIdentity !== targetIdentity) {
          keepPromotedAuth = true;
        } else {
          // Same identity: swap to the symlink only when the shared source is
          // strictly fresher. A tie or an unparseable timestamp keeps the file
          // (see the freshness rationale above).
          const sourceLastRefresh = readAuthLastRefreshMs(sourceBytes);
          const targetLastRefresh = readAuthLastRefreshMs(targetBytes);
          keepPromotedAuth = !(
            sourceLastRefresh !== null &&
            targetLastRefresh !== null &&
            sourceLastRefresh > targetLastRefresh
          );
        }
        if (keepPromotedAuth && sourceReadErrorCode) {
          // Deferred heal, made visible: seeding runs before every probe and
          // every execute, so the next call with a readable source applies
          // the same-identity symlink heal this call could not decide.
          await onLog(
            "stdout",
            `[paperclip] Keeping the existing subscription auth.json in Codex home "${targetHome}" (shared source read failed: ${sourceReadErrorCode}); the next seed with a readable source reconciles it.\n`,
          );
        }
      }
      if (keepPromotedAuth) {
        await onLog(
          "stdout",
          `[paperclip] Keeping the promoted subscription auth.json in Codex home "${targetHome}".\n`,
        );
      } else {
        await removeFileNoFollow(authPath);
      }
    }
  }

  if (seedFromShared) {
    for (const name of SYMLINKED_SHARED_FILES) {
      // The kept promoted credential is authoritative for this home; the shared
      // symlink would silently swap the account back to the host login. A
      // credential-store entry's auth.json is authoritative unconditionally.
      if (name === "auth.json" && (keepPromotedAuth || credentialStoreEntry)) continue;
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      await ensureSymlink(path.join(targetHome, name), source);
    }

    for (const name of COPIED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      await ensureCopiedFile(path.join(targetHome, name), source);
    }

    await onLog(
      "stdout",
      `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
    );
  }

  if (apiKey) {
    if (credentialStoreEntry) {
      // Refuse, loudly: overwriting a store entry's subscription credential
      // with an API-key file would destroy the durable login the entry
      // exists to hold. The operator combined an account binding with a
      // configured OPENAI_API_KEY; the binding wins for this home.
      await onLog(
        "stdout",
        `[paperclip] Refusing to write an API-key auth.json into credential-store entry "${targetHome}"; the bound account's stored login stays authoritative.\n`,
      );
    } else {
      await writeApiKeyAuthJson(targetHome, apiKey);
      await onLog(
        "stdout",
        `[paperclip] Wrote API-key auth.json into Codex home "${targetHome}" from configured OPENAI_API_KEY.\n`,
      );
    }
  }
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
  options: { apiKey?: string | null } = {},
): Promise<string> {
  const targetHome = resolveManagedCodexHomeDir(env, companyId);
  await seedManagedCodexHome(targetHome, env, onLog, options);
  return targetHome;
}

export type ReconcileManagedCodexHomeStatus =
  | "no_managed_home"
  | "external_override"
  | "already_seeded"
  | "source_auth_missing"
  | "seeded";

export interface ReconcileManagedCodexHomeInput {
  companyId: string | undefined;
  configuredCodexHome: string | null | undefined;
  apiKey?: string | null;
  /**
   * Set when the agent's persisted `OPENAI_API_KEY` is a secret binding that
   * could not be resolved in this context (e.g. startup reconciliation, which
   * never resolves secrets). When true and the home already has usable auth,
   * reconciliation preserves that auth instead of downgrading it to the shared
   * subscription symlink.
   */
  apiKeySecretBound?: boolean;
  env?: NodeJS.ProcessEnv;
  onLog?: AdapterExecutionContext["onLog"];
}

export interface ReconcileManagedCodexHomeResult {
  status: ReconcileManagedCodexHomeStatus;
  home: string | null;
}

const noopOnLog: AdapterExecutionContext["onLog"] = async () => {};

/**
 * Idempotently reconciles a persisted `codex_local` agent home. Phase 1 seeds
 * managed homes at execute time; this is the backfill for agents that already
 * carry a persisted (but unseeded) per-agent `CODEX_HOME` and have not run
 * since the seeding fix landed. Shares the managed-home detection
 * (`isManagedCodexHomePath`) and seeding (`seedManagedCodexHome`) logic so a
 * genuine external/user override is never touched. Safe to re-run: when a valid
 * `auth.json` is already present (and no API-key rewrite is requested) it is a
 * no-op and reports `already_seeded`.
 */
export async function reconcileManagedCodexHome(
  input: ReconcileManagedCodexHomeInput,
): Promise<ReconcileManagedCodexHomeResult> {
  const env = input.env ?? process.env;
  const configured = nonEmpty(input.configuredCodexHome ?? undefined);
  if (!configured) return { status: "no_managed_home", home: null };

  const resolved = path.resolve(configured);
  if (!isManagedCodexHomePath(env, input.companyId, resolved)) {
    return { status: "external_override", home: resolved };
  }

  const apiKey = nonEmpty(input.apiKey ?? undefined);
  const hadUsableAuth = await codexHomeHasUsableAuth(resolved);

  // A secret-bound OPENAI_API_KEY cannot be resolved here, so we cannot rewrite
  // it into auth.json. If the home already has usable auth — typically an
  // API-key auth.json written at execute time when the secret WAS resolved —
  // preserve it. Re-seeding without the key would delete that file and restore
  // the shared subscription symlink, silently changing the agent's credentials
  // on every boot while the persisted config still says "use the secret key".
  if (input.apiKeySecretBound && hadUsableAuth) {
    return { status: "already_seeded", home: resolved };
  }

  if (apiKey && await codexHomeHasMatchingApiKeyAuth(resolved, apiKey)) {
    return { status: "already_seeded", home: resolved };
  }

  await seedManagedCodexHome(resolved, env, input.onLog ?? noopOnLog, { apiKey });

  if (!apiKey && !(await codexHomeHasUsableAuth(resolved))) {
    return { status: "source_auth_missing", home: resolved };
  }

  // Without an API key, seeding only changes disk state when auth was missing.
  // With an API key, the matching-file short-circuit above filters out the
  // already-seeded case before this write path.
  const status: ReconcileManagedCodexHomeStatus =
    !apiKey && hadUsableAuth ? "already_seeded" : "seeded";
  return { status, home: resolved };
}

export type CodexCredentialAuthMode = "api" | "subscription";

export interface CodexCredentialReadinessInput {
  env?: NodeJS.ProcessEnv;
  companyId: string | undefined;
  /** `config.env.CODEX_HOME` for the run, if any. */
  configuredCodexHome: string | null | undefined;
  /** Resolved `config.env.OPENAI_API_KEY` value (after secret resolution). */
  configuredApiKey: string | null | undefined;
}

export interface CodexCredentialReadiness {
  /** True when Paperclip owns the effective home and is responsible for its auth. */
  managed: boolean;
  authMode: CodexCredentialAuthMode;
  /** True when a run launched now would be able to authenticate. */
  ready: boolean;
  effectiveHome: string;
  /** The shared source home subscription auth is symlinked from (managed homes only). */
  sharedSourceHome: string;
}

/**
 * Read-only predictor for whether a `codex_local` run will be able to
 * authenticate, without seeding or mutating any home. Mirrors the execute-time
 * fail-fast in `execute.ts`, factored out so the control plane can run the same
 * check *before* dispatch and surface a configuration-incomplete blocker instead
 * of dispatching a run that is guaranteed to fail with "no Codex credentials".
 *
 * - An external/user-supplied `CODEX_HOME` override manages its own auth, so it
 *   is always treated as ready (Paperclip must not seed or inspect it).
 * - A non-empty resolved `OPENAI_API_KEY` means API-key auth, always ready.
 * - Otherwise (subscription mode) the run needs a usable `auth.json`. Because a
 *   managed home symlinks `auth.json` from the shared source home at seed time,
 *   we treat the run as ready when either the (possibly already-seeded) effective
 *   home or the shared source home carries usable auth.
 */
export async function evaluateCodexCredentialReadiness(
  input: CodexCredentialReadinessInput,
): Promise<CodexCredentialReadiness> {
  const env = input.env ?? process.env;
  const configuredRaw = nonEmpty(input.configuredCodexHome ?? undefined);
  const configuredCodexHome = configuredRaw ? path.resolve(configuredRaw) : null;
  const configuredApiKey = nonEmpty(input.configuredApiKey ?? undefined);
  const sharedSourceHome = resolveSharedCodexHomeDir(env);

  const configuredHomeIsManaged =
    configuredCodexHome != null && isManagedCodexHomePath(env, input.companyId, configuredCodexHome);
  const effectiveHomeIsManaged = configuredCodexHome == null || configuredHomeIsManaged;
  const effectiveHome = configuredCodexHome ?? resolveManagedCodexHomeDir(env, input.companyId);

  if (!effectiveHomeIsManaged) {
    // Genuine external override: Paperclip never seeds or inspects it.
    return {
      managed: false,
      authMode: configuredApiKey ? "api" : "subscription",
      ready: true,
      effectiveHome,
      sharedSourceHome,
    };
  }

  if (configuredApiKey) {
    return { managed: true, authMode: "api", ready: true, effectiveHome, sharedSourceHome };
  }

  const ready =
    (await codexHomeHasUsableAuth(effectiveHome)) ||
    (await codexHomeHasUsableAuth(sharedSourceHome));
  return { managed: true, authMode: "subscription", ready, effectiveHome, sharedSourceHome };
}
