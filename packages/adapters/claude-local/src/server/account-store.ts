import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ACCOUNT_DIR_MODE = 0o700;
const CREDENTIALS_FILE_NAME = ".credentials.json";

function paperclipHome(): string {
  const explicit = process.env.PAPERCLIP_HOME;
  if (explicit && explicit.trim().length > 0) return explicit;
  return path.join(os.homedir(), ".paperclip");
}

export function accountDir(accountId: string): string {
  return path.join(paperclipHome(), "anthropic-accounts", accountId);
}

export async function provisionOauthAccount(
  accountId: string,
): Promise<{ credentialDir: string }> {
  const credentialDir = accountDir(accountId);
  await fs.mkdir(credentialDir, { recursive: true, mode: ACCOUNT_DIR_MODE });
  await fs.chmod(credentialDir, ACCOUNT_DIR_MODE);
  return { credentialDir };
}

export async function readOauthCredentials(accountId: string): Promise<string | null> {
  const filePath = path.join(accountDir(accountId), CREDENTIALS_FILE_NAME);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function deleteAccountFiles(accountId: string): Promise<void> {
  await fs.rm(accountDir(accountId), { recursive: true, force: true });
}

export type ApiKeyResolver = (secretId: string) => Promise<string>;

let apiKeyResolver: ApiKeyResolver | null = null;

export function setApiKeyResolver(resolver: ApiKeyResolver | null): void {
  apiKeyResolver = resolver;
}

export async function readApiKeyValue(secretId: string): Promise<string> {
  if (!apiKeyResolver) {
    throw new Error(
      "API key resolver is not configured; call setApiKeyResolver() during server bootstrap",
    );
  }
  return apiKeyResolver(secretId);
}

export type ActiveAnthropicAccountMode = "oauth" | "api_key" | "bedrock";

export interface ActiveAnthropicAccount {
  id: string;
  label: string;
  mode: ActiveAnthropicAccountMode;
  apiKeySecretId: string | null;
}

export type ActiveAccountResolver = (
  companyId: string,
  agentId: string,
) => Promise<ActiveAnthropicAccount>;

let activeAccountResolver: ActiveAccountResolver | null = null;

export function setActiveAccountResolver(resolver: ActiveAccountResolver | null): void {
  activeAccountResolver = resolver;
}

export function hasActiveAccountResolver(): boolean {
  return activeAccountResolver !== null;
}

export async function resolveActiveAccount(
  companyId: string,
  agentId: string,
): Promise<ActiveAnthropicAccount> {
  if (!activeAccountResolver) {
    throw new Error(
      "Active Anthropic account resolver is not configured; call setActiveAccountResolver() during server bootstrap",
    );
  }
  return activeAccountResolver(companyId, agentId);
}

export interface ApplyActiveAccountResult {
  accountId: string;
  accountLabel: string;
  accountMode: ActiveAnthropicAccountMode;
  /** What the resolver injected, for telemetry. "credential_dir" / "api_key" / "noop" (bedrock). */
  injection: "credential_dir" | "api_key" | "noop";
}

/**
 * A candidate Anthropic account considered "healthy" for auto-failover —
 * resolver-side service decides what "healthy" means (e.g. utilization < 80%).
 */
export interface HealthyAccountCandidate {
  id: string;
  label: string;
  mode: ActiveAnthropicAccountMode;
  apiKeySecretId: string | null;
  /** Last 5h utilization percent (0..100) or null if unknown / not applicable. */
  lastUtilizationFiveHour: number | null;
}

export interface AutoFailoverHook {
  listHealthyCandidates(input: {
    companyId: string;
    currentAccountId: string;
  }): Promise<HealthyAccountCandidate[]>;
  setActiveAccount(input: {
    companyId: string;
    accountId: string;
    setBy: string;
  }): Promise<void>;
  logSwitch(input: {
    runId: string;
    fromAccountId: string;
    toAccountId: string;
    reason: string;
  }): Promise<void>;
}

let autoFailoverHook: AutoFailoverHook | null = null;

export function setAutoFailoverHook(hook: AutoFailoverHook | null): void {
  autoFailoverHook = hook;
}

export function getAutoFailoverHook(): AutoFailoverHook | null {
  return autoFailoverHook;
}

/**
 * Inject Anthropic-account-specific runtime credentials into the env that the
 * Claude CLI will see. Caller decides how to populate `loggedEnv` (we never
 * touch credential values here — `redactEnvForLogs` will mask api keys downstream).
 */
export async function applyActiveAnthropicAccountToEnv(input: {
  account: ActiveAnthropicAccount;
  env: Record<string, string>;
  resolveApiKey?: (secretId: string) => Promise<string>;
}): Promise<ApplyActiveAccountResult> {
  const { account, env } = input;
  const resolveApiKey = input.resolveApiKey ?? readApiKeyValue;

  if (account.mode === "oauth") {
    env.CLAUDE_CONFIG_DIR = accountDir(account.id);
    return {
      accountId: account.id,
      accountLabel: account.label,
      accountMode: "oauth",
      injection: "credential_dir",
    };
  }
  if (account.mode === "api_key") {
    if (!account.apiKeySecretId) {
      throw new Error(
        `Anthropic account "${account.id}" is mode=api_key but has no apiKeySecretId`,
      );
    }
    env.ANTHROPIC_API_KEY = await resolveApiKey(account.apiKeySecretId);
    return {
      accountId: account.id,
      accountLabel: account.label,
      accountMode: "api_key",
      injection: "api_key",
    };
  }
  // bedrock and any future modes — out of scope for this issue (MAS-253);
  // existing CLAUDE_CODE_USE_BEDROCK / ANTHROPIC_BEDROCK_BASE_URL flow is untouched.
  return {
    accountId: account.id,
    accountLabel: account.label,
    accountMode: account.mode,
    injection: "noop",
  };
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "code" in error && (error as { code?: string }).code === "ENOENT";
}
