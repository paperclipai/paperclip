/**
 * Resolved plugin instance config shape.
 *
 * Operator-set values come from paperclip's plugin instance config UI. Secret
 * fields are stored as **references** (e.g. "GITHUB_APP_COMPLIANCE_FIRST_KEY")
 * and resolved via `ctx.secrets.resolve()` at call time — never cached on
 * disk or in logs.
 */
export interface ResolvedConfig {
  /** Numeric GitHub App ID (resolved from secret ref). */
  appId: number;
  /** PEM-encoded private key (resolved from secret ref). */
  privateKeyPem: string;
  /** Installation ID this token mints for. */
  installationId: number;
  /** `owner/name`. */
  repo: string;
  /** Default base branch for new PRs. */
  defaultBranch: string;
  /** Whether merge queue enforcement is on. */
  mergeQueueEnabled: boolean;
}

export interface RawConfig {
  appId?: string;
  privateKeyPem?: string;
  installationId?: string;
  repo?: string;
  defaultBranch?: string;
  mergeQueueEnabled?: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseRepo(repo: string): { owner: string; name: string } {
  const trimmed = repo.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new ConfigError(`Invalid repo "${repo}": expected "owner/name"`);
  }
  return { owner: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) };
}

/**
 * Validate the raw config object and resolve secret refs to actual values.
 * Each secret ref is resolved via `secretsResolve` — this is the only place
 * plaintext secret values appear and they are not stored anywhere by us.
 */
export async function resolveConfig(
  raw: unknown,
  secretsResolve: (ref: string) => Promise<string>,
): Promise<ResolvedConfig> {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError("Plugin config is missing or not an object");
  }
  const cfg = raw as RawConfig;
  if (!cfg.appId) throw new ConfigError("appId secret ref is required");
  if (!cfg.privateKeyPem) throw new ConfigError("privateKeyPem secret ref is required");
  if (!cfg.installationId) throw new ConfigError("installationId secret ref is required");
  if (!cfg.repo) throw new ConfigError("repo (owner/name) is required");
  parseRepo(cfg.repo);

  const [appIdStr, privateKeyPem, installationIdStr] = await Promise.all([
    secretsResolve(cfg.appId),
    secretsResolve(cfg.privateKeyPem),
    secretsResolve(cfg.installationId),
  ]);

  const appId = Number(appIdStr);
  if (!Number.isFinite(appId) || appId <= 0) {
    throw new ConfigError(`appId resolved to non-positive number: ${appIdStr}`);
  }
  const installationId = Number(installationIdStr);
  if (!Number.isFinite(installationId) || installationId <= 0) {
    throw new ConfigError(`installationId resolved to non-positive number: ${installationIdStr}`);
  }

  return {
    appId,
    privateKeyPem,
    installationId,
    repo: cfg.repo,
    defaultBranch: cfg.defaultBranch ?? "main",
    mergeQueueEnabled: cfg.mergeQueueEnabled ?? true,
  };
}
