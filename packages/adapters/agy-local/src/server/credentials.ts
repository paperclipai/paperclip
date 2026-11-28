import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";

export interface AgyCredentialReadinessInput {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  configuredApiKey?: string | null;
}

export interface AgyCredentialReadiness {
  ready: boolean;
  authMode: "subscription" | "api" | "none";
  tokenPath?: string | null;
  detail?: string | null;
}

/**
 * Candidate Antigravity CLI OAuth token locations, in search order, without
 * touching the filesystem. Both the adapter's own resolver and the server's
 * isolated-login check iterate this list, so the search order has exactly
 * one owner and login checks cannot drift from execution as supported
 * paths change.
 */
export function listAgyOAuthTokenPaths(
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    env.ANTIGRAVITY_CLI_HOME ? path.join(env.ANTIGRAVITY_CLI_HOME, "antigravity-oauth-token") : null,
    env.GEMINI_CLI_HOME ? path.join(env.GEMINI_CLI_HOME, "antigravity-oauth-token") : null,
    path.join(homedir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    path.join(homedir, ".gemini", "antigravity", "antigravity-oauth-token"),
  ].filter((p): p is string => Boolean(p));
}

/**
 * Searches for the Antigravity CLI OAuth token file across standard locations:
 * - $ANTIGRAVITY_CLI_HOME/antigravity-oauth-token
 * - $GEMINI_CLI_HOME/antigravity-oauth-token
 * - ~/.gemini/antigravity-cli/antigravity-oauth-token
 * - ~/.gemini/antigravity/antigravity-oauth-token
 */
export function resolveAgyOAuthTokenPath(
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const candidate of listAgyOAuthTokenPaths(homedir, env)) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore filesystem access errors
    }
  }
  return null;
}

/**
 * Parses and validates raw content from an Antigravity OAuth token file.
 */
export function parseAgyOAuthToken(content: string): {
  valid: boolean;
  payload: any;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  isExpired: boolean;
  expiryMs: number | null;
} {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") {
      return { valid: false, payload: null, accessToken: null, refreshToken: null, idToken: null, isExpired: false, expiryMs: null };
    }

    const tokenObj = typeof parsed.token === "object" && parsed.token !== null ? parsed.token : null;
    const accessToken =
      (tokenObj && typeof tokenObj.access_token === "string" && tokenObj.access_token.length > 0)
        ? tokenObj.access_token
        : typeof parsed.access_token === "string" && parsed.access_token.length > 0
          ? parsed.access_token
          : typeof parsed.token === "string" && parsed.token.length > 0
            ? parsed.token
            : null;

    const refreshToken =
      (tokenObj && typeof tokenObj.refresh_token === "string" && tokenObj.refresh_token.length > 0)
        ? tokenObj.refresh_token
        : typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
          ? parsed.refresh_token
          : null;

    const idToken =
      (tokenObj && typeof tokenObj.id_token === "string" && tokenObj.id_token.length > 0)
        ? tokenObj.id_token
        : typeof parsed.id_token === "string" && parsed.id_token.length > 0
          ? parsed.id_token
          : null;

    const expiryStr = (tokenObj && typeof tokenObj.expiry === "string")
      ? tokenObj.expiry
      : typeof parsed.expiry === "string"
        ? parsed.expiry
        : typeof parsed.expires_at === "string"
          ? parsed.expires_at
          : null;

    let isExpired = false;
    let expiryMs: number | null = null;
    if (expiryStr) {
      const ms = new Date(expiryStr).getTime();
      if (!Number.isNaN(ms)) {
        expiryMs = ms;
        if (ms <= Date.now()) {
          isExpired = true;
        }
      }
    }

    const hasTokens = Boolean(accessToken || refreshToken || idToken);
    const valid = hasTokens && (!isExpired || Boolean(refreshToken));

    return {
      valid,
      payload: parsed,
      accessToken,
      refreshToken,
      idToken,
      isExpired,
      expiryMs,
    };
  } catch {
    const trimmed = content.trim();
    return {
      valid: trimmed.length > 0,
      payload: trimmed,
      accessToken: trimmed || null,
      refreshToken: null,
      idToken: null,
      isExpired: false,
      expiryMs: null,
    };
  }
}

/**
 * Validates whether the OAuth token file exists, is non-empty, and contains a valid token.
 */
export function hasUsableAgyOAuthToken(tokenPath: string): boolean {
  try {
    if (!fs.existsSync(tokenPath)) return false;
    const stat = fs.statSync(tokenPath);
    if (stat.size === 0) return false;
    const content = fs.readFileSync(tokenPath, "utf8");
    return parseAgyOAuthToken(content).valid;
  } catch {
    return false;
  }
}

/**
 * Resolves the path to the Antigravity settings.json file.
 */
export function resolveAgySettingsPath(
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir =
    env.ANTIGRAVITY_CLI_HOME ||
    env.GEMINI_CLI_HOME ||
    path.join(homedir, ".gemini", "antigravity-cli");
  return path.join(dir, "settings.json");
}

/**
 * The effective Gemini API key for an Antigravity run. The CLI only reads
 * GEMINI_API_KEY; AGY_API_KEY and ANTIGRAVITY_API_KEY are Paperclip-side
 * aliases for the same key. Precedence is GEMINI_API_KEY, then AGY_API_KEY,
 * then ANTIGRAVITY_API_KEY; a blank value falls through to the next alias.
 */
export function resolveAgyApiKey(env: Record<string, string | undefined>): string | null {
  for (const name of ["GEMINI_API_KEY", "AGY_API_KEY", "ANTIGRAVITY_API_KEY"] as const) {
    const value = (env[name] ?? "").trim();
    if (value.length > 0) return value;
  }
  return null;
}

/**
 * Map a supported API-key alias to GEMINI_API_KEY, the only key the CLI
 * reads. No-op when GEMINI_API_KEY is already set to a non-blank value, or
 * when no alias is present. Call on the effective env before testing and
 * execution so readiness and the run cannot disagree about whether an API
 * key is configured.
 */
export function applyAgyApiKeyAlias(env: Record<string, string | undefined>): void {
  if ((env.GEMINI_API_KEY ?? "").trim().length > 0) return;
  const key = resolveAgyApiKey(env);
  if (key) env.GEMINI_API_KEY = key;
}

/**
 * Checks whether Antigravity credentials are ready to use.
 * Checks for:
 * 1. Explicitly configured API key
 * 2. Environment API keys (GEMINI_API_KEY, AGY_API_KEY, ANTIGRAVITY_API_KEY)
 * 3. Local OAuth token in ~/.gemini/antigravity-cli (or alternate homes)
 */
export function evaluateAgyCredentialReadiness(
  input: AgyCredentialReadinessInput = {},
): AgyCredentialReadiness {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();

  const explicitKey = (input.configuredApiKey ?? "").trim();
  if (explicitKey.length > 0) {
    return { ready: true, authMode: "api", detail: "configured_api_key" };
  }

  const envKey = resolveAgyApiKey(env);
  if (envKey) {
    return { ready: true, authMode: "api", detail: "env_api_key" };
  }

  const tokenPath = resolveAgyOAuthTokenPath(homedir, env);
  if (tokenPath && hasUsableAgyOAuthToken(tokenPath)) {
    return {
      ready: true,
      authMode: "subscription",
      tokenPath,
      detail: "oauth_token_file",
    };
  }

  return { ready: false, authMode: "none", detail: "missing_credentials" };
}

/**
  Exit code 10: Replace destination credential with source.
  Exit code 20: Keep destination credential.

  The sandbox copy wins ONLY when the host has no working credential
  (destination missing or unparseable): that is the first-sync bootstrap.
  A working host credential is never replaced by sandbox-written bytes.
  Refresh-token equality proves the source belongs to the same grant, but
  it cannot prove the sandbox's access token was issued by Google for that
  grant: a file-capable run can keep the refresh token, forge an arbitrary
  access token with a later expiry, and replace the host login. Decoded
  identity claims and payload identity fields are equally forgeable, so
  none of those may authorize a replacement either. The host keeps its own
  credential instead; a stale access token self-heals because the CLI
  refreshes it on next use with the intact refresh token
  (parseAgyOAuthToken treats expired-with-refresh as valid).
  */
export async function decideAgyAuthMerge(
  sourcePath: string,
  destinationPath: string,
): Promise<number> {
  try {
    const sourceContent = await fs.promises.readFile(sourcePath, "utf8");
    const source = parseAgyOAuthToken(sourceContent);
    if (!source.valid) return 20;

    let destContent: string | null = null;
    try {
      destContent = await fs.promises.readFile(destinationPath, "utf8");
    } catch {
      return 10;
    }

    const dest = parseAgyOAuthToken(destContent);
    if (!dest.valid) return 10;

    // The destination is a working credential. Sandbox bytes must never
    // replace it (see above): keep the host credential.
    return 20;
  } catch {
    return 20;
  }
}

export interface StageAgyHomeForSyncOptions {
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  /**
   * Conversation ids whose brain/ state this run resumes. Only those
   * conversations are staged: the host CLI home may hold other agents' or
   * companies' conversations, and uploading the whole brain/ tree would
   * hand them to the remote agent. Empty/absent means a fresh run — stage
   * no brain/ at all.
   */
  conversationIds?: string[];
  /**
   * Whether to copy the host OAuth token into the staged home. Defaults
   * to true. Remote callers must pass false when the run authenticates
   * another way (an API key): the token would otherwise be placed in a
   * tenant sandbox where agent code can read it, even though the CLI
   * never uses it. Local callers keep the default: the staged home stays
   * on the host, so the token is not exposed to another party.
   */
  includeOAuthToken?: boolean;
}

/**
 * Resolves the Antigravity CLI home directory: the home holding the OAuth
 * token when one exists (the CLI authenticates from its own home), else the
 * home holding settings.json (the env override or ~/.gemini/antigravity-cli).
 * The staged home, the token, the settings, and brain/ all come from this
 * one home so the remote run sees a coherent CLI home.
 */
export function resolveAgyCliHomeDir(
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const tokenPath = resolveAgyOAuthTokenPath(homedir, env);
  if (tokenPath) return path.dirname(tokenPath);
  return path.dirname(resolveAgySettingsPath(homedir, env));
}

/**
 * Stages credentials (antigravity-oauth-token) and configuration (settings.json)
 * into a private temporary directory suitable for syncing into a sandbox execution target.
 */
export async function stageAgyHomeForSync(
  options: StageAgyHomeForSyncOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const prefix = options.runId
    ? `paperclip-agy-home-sync-${options.runId}-`
    : "paperclip-agy-home-sync-";
  const stagedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.promises.chmod(stagedDir, 0o700).catch(() => {});

  const tokenPath = resolveAgyOAuthTokenPath(homedir, env);
  if (options.includeOAuthToken !== false && tokenPath && hasUsableAgyOAuthToken(tokenPath)) {
    try {
      const content = await fs.promises.readFile(tokenPath, "utf8");
      await fs.promises.writeFile(
        path.join(stagedDir, "antigravity-oauth-token"),
        content,
        { mode: 0o600 },
      );
    } catch {
      // Ignore read/write failures
    }
  }

  const settingsPath = resolveAgySettingsPath(homedir, env);
  try {
    if (fs.existsSync(settingsPath)) {
      const content = await fs.promises.readFile(settingsPath, "utf8");
      await fs.promises.writeFile(
        path.join(stagedDir, "settings.json"),
        content,
        { mode: 0o600 },
      );
    }
  } catch {
    // Fall through to API key check
  }

  // A run with an effective API key must use it even when the host has
  // settings (e.g. OAuth/subscription): apply the API-provider setting to
  // the staged copy, preserving the host's other settings. Otherwise the
  // CLI would use the copied subscription or fail for missing OAuth
  // instead of the selected key. This staging step is the only place the
  // provider setting gets applied: callers must never write it into the
  // shared home's settings.json (a local API-key run would permanently
  // flip the operator's home to the API-key provider for every later
  // OAuth-only agent and terminal session).
  if (resolveAgyApiKey(env)) {
    const stagedSettingsPath = path.join(stagedDir, "settings.json");
    let stagedSettings: Record<string, unknown> = {};
    try {
      const raw = await fs.promises.readFile(stagedSettingsPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        stagedSettings = parsed;
      }
    } catch {
      // Missing or invalid JSON; start fresh
    }
    if (stagedSettings.modelProvider !== "gemini") {
      stagedSettings.modelProvider = "gemini";
      await fs.promises.writeFile(
        stagedSettingsPath,
        JSON.stringify(stagedSettings, null, 2) + "\n",
        { mode: 0o600 },
      );
    }
  }

  // Stage only the resumed conversations' state, never the whole brain/
  // tree: the host CLI home may hold other agents' or companies'
  // conversations, and the remote agent must receive only what this run
  // resumes. A conversation id is a single path segment; anything else is
  // ignored rather than staged. Best-effort like the other copies: a
  // missing or unreadable conversation simply means the run starts fresh.
  const conversationIds = (options.conversationIds ?? []).filter(
    (id) => typeof id === "string" && id.length > 0 && !id.includes("/") && !id.includes("\\") && id !== "." && id !== "..",
  );
  if (conversationIds.length > 0) {
    const cliHomeDir = resolveAgyCliHomeDir(homedir, env);
    for (const conversationId of conversationIds) {
      try {
        const brainDir = path.join(cliHomeDir, "brain", conversationId);
        if (fs.existsSync(brainDir)) {
          await fs.promises.cp(brainDir, path.join(stagedDir, "brain", conversationId), { recursive: true });
        }
      } catch {
        // Ignore copy failures
      }
    }
  }

  return stagedDir;
}

/**
 * Bounds shared by the local and remote conversation copy-backs: a runaway
 * CLI must not fill the host disk through brain/.
 */
export const COPY_BACK_AGY_CONVERSATION_LIMITS = {
  maxFiles: 1000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
};

export interface CopyBackAgyLocalConversationStateInput {
  /** Private staged CLI home dir (local temp dir). */
  stagedDir: string;
  /** Host CLI home dir the brain/ tree is copied back into. */
  hostCliHomeDir: string;
  log?: (line: string) => void | Promise<void>;
  limits?: Partial<typeof COPY_BACK_AGY_CONVERSATION_LIMITS>;
}

async function collectAgyBrainFiles(dir: string, prefix = "", maxFiles = Number.POSITIVE_INFINITY): Promise<string[]> {
  let dirents;
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const dirent of dirents) {
    // Stop collecting once the cap is reached: the count limit must bound
    // the walk itself, not just the copy loop after the whole tree was
    // already read into memory.
    if (files.length >= maxFiles) break;
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      files.push(...(await collectAgyBrainFiles(path.join(dir, dirent.name), rel, maxFiles - files.length)));
    } else if (dirent.isFile()) {
      files.push(rel);
    }
    // Symlinks are skipped: never follow one out of the staged tree.
  }
  return files;
}

/**
 * Copies a local private CLI home's brain/ back into the real CLI home at
 * teardown, so a run that used a staged home (API-key runs) can still be
 * resumed afterwards. Same validation and bounds as the remote copy-back
 * (copyBackAgyConversationState), but over the local filesystem, so no
 * manifest is needed: the staged tree is confined by construction.
 * Returns the brain/-relative paths that were copied (for callers that
 * need to rewrite recorded paths from the staged dir to the real home).
 * Best-effort: a missing brain/ dir or any read/write error only loses the
 * resume (the status quo), never the run.
 */
export async function copyBackAgyLocalConversationState(
  input: CopyBackAgyLocalConversationStateInput,
): Promise<string[]> {
  const limits = { ...COPY_BACK_AGY_CONVERSATION_LIMITS, ...(input.limits ?? {}) };
  const log = input.log ?? (() => {});
  const copied: string[] = [];
  try {
    const stagedBrainDir = path.join(input.stagedDir, "brain");
    const entries = await collectAgyBrainFiles(stagedBrainDir, "", limits.maxFiles);
    if (entries.length >= limits.maxFiles) {
      await log(
        `[paperclip] Antigravity conversation copy-back: brain/ holds at least ${limits.maxFiles} files, copying the first ${limits.maxFiles}.`,
      );
    }
    const hostBrainDir = path.join(input.hostCliHomeDir, "brain");
    let totalBytes = 0;
    for (const entry of entries) {
      // Confine every entry to brain/: no absolute paths, no `..` segments,
      // and the resolved host path must stay under the host brain dir.
      if (path.posix.isAbsolute(entry) || entry.split("/").includes("..")) continue;
      const stagedPath = path.join(stagedBrainDir, ...entry.split("/"));
      const hostPath = path.join(hostBrainDir, ...entry.split("/"));
      if (!hostPath.startsWith(hostBrainDir + path.sep)) continue;
      // Bound the read before allocating: stat the file and skip it when
      // it is over the per-file limit, instead of reading it whole and
      // only then discovering it is too large.
      let size: number;
      try {
        size = (await fs.promises.stat(stagedPath)).size;
      } catch {
        continue;
      }
      if (size > limits.maxFileBytes) continue;
      if (totalBytes + size > limits.maxTotalBytes) {
        await log("[paperclip] Antigravity conversation copy-back: hit the total size limit, stopping.");
        break;
      }
      let content: Buffer;
      try {
        content = await fs.promises.readFile(stagedPath);
      } catch {
        continue;
      }
      try {
        await fs.promises.mkdir(path.dirname(hostPath), { recursive: true });
        await fs.promises.writeFile(hostPath, content, { mode: 0o600 });
        totalBytes += content.byteLength;
        copied.push(entry);
      } catch {
        continue;
      }
    }
  } catch (error) {
    await log(
      `[paperclip] Antigravity conversation copy-back failed: ${error instanceof Error ? error.message : String(error)}; the next run will start a fresh conversation.`,
    );
  }
  return copied;
}

export type CopyBackAgyAuthOutcome = "copied" | "kept-host";

export interface CopyBackAgyAuthInput {
  readSandboxAuth: () => Promise<Buffer>;
  hostTokenPath: string;
  log: (line: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  /**
   * Whether the run staged a host OAuth token into the sandbox. Defaults
   * to true. Remote callers must pass false when the run authenticates
   * another way (an API key): with no staged token there is no first-sync
   * bootstrap to perform, and a missing host destination would otherwise
   * let sandbox-written bytes be installed as the host credential.
   */
  stagedTokenPresent?: boolean;
}

/**
 * Guards, locks, and atomically installs a strictly-newer sandbox Antigravity
 * OAuth token onto the host credential at teardown. When no host token was
 * staged for the run (stagedTokenPresent: false), nothing is copied back:
 * the sandbox never held a host credential to refresh.
 */
export async function copyBackAgyAuth(
  input: CopyBackAgyAuthInput,
): Promise<CopyBackAgyAuthOutcome> {
  const { readSandboxAuth, hostTokenPath, log, env = process.env, stagedTokenPresent = true } = input;

  if (!stagedTokenPresent) {
    await log(
      "[paperclip] Antigravity auth copy-out: no host token was staged for this run; kept host.",
    );
    return "kept-host";
  }

  let sandboxAuthBytes: Buffer;
  try {
    sandboxAuthBytes = await readSandboxAuth();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return "kept-host";
    }
    throw error;
  }

  let resolvedHostTokenPath = hostTokenPath;
  try {
    if (fs.existsSync(hostTokenPath)) {
      resolvedHostTokenPath = await fs.promises.realpath(hostTokenPath);
    }
  } catch {
    // keep hostTokenPath
  }

  const hostDir = path.dirname(resolvedHostTokenPath);
  await fs.promises.mkdir(hostDir, { recursive: true, mode: 0o700 });

  return await withDirectoryMergeLock(
    hostDir,
    async () => {
      const stagedTempPath = path.join(
        hostDir,
        `.antigravity-oauth-token.copyback-${process.pid}-${randomUUID()}.tmp`,
      );
      const handle = await fs.promises.open(stagedTempPath, "wx", 0o600);
      try {
        await handle.writeFile(sandboxAuthBytes);
        await handle.close();

        const decision = await decideAgyAuthMerge(stagedTempPath, resolvedHostTokenPath);
        if (decision === 10) {
          await fs.promises.rename(stagedTempPath, resolvedHostTokenPath);
          await log(
            "[paperclip] Antigravity auth copy-out: updated host credential from sandbox.",
          );
          return "copied";
        }

        await log(
          "[paperclip] Antigravity auth copy-out: host credential is newer or equivalent; kept host.",
        );
        return "kept-host";
      } finally {
        await handle.close().catch(() => undefined);
        await fs.promises.rm(stagedTempPath, { force: true }).catch(() => undefined);
      }
    },
    env,
  );
}
