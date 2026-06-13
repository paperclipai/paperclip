/**
 * Resolved plugin instance config shape.
 *
 * Operator-set values come from paperclip's plugin instance config UI. The
 * three credential fields can be either:
 *   - a paperclip secret reference (UUID), resolved via `ctx.secrets.resolve()`
 *   - or, in v0.1 / local_trusted mode where the host has not yet enabled
 *     plugin secret refs, the **plaintext value itself**.
 *
 * `resolveConfig` tries the secret resolver first and silently falls back to
 * treating the field as a plaintext literal when resolution fails. Plain
 * values are never logged or persisted to non-secret storage.
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
  const parts = trimmed.split("/");
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) {
    throw new ConfigError(`Invalid repo "${repo}": expected "owner/name"`);
  }
  if (!isGitHubRepoSegment(owner) || !isGitHubRepoSegment(name)) {
    throw new ConfigError(`Invalid repo "${repo}": expected safe GitHub owner/name`);
  }
  return { owner, name };
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
  const repo = parseRepo(cfg.repo);

  const [appIdStr, privateKeyPem, installationIdStr] = await Promise.all([
    maybeResolve(cfg.appId, secretsResolve),
    maybeResolve(cfg.privateKeyPem, secretsResolve),
    maybeResolve(cfg.installationId, secretsResolve),
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
    repo: `${repo.owner}/${repo.name}`,
    defaultBranch: cfg.defaultBranch ?? "main",
    mergeQueueEnabled: cfg.mergeQueueEnabled ?? true,
  };
}

function isGitHubRepoSegment(segment: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(segment);
}

/**
 * Resolve a string field as a paperclip secret reference; if the host rejects
 * the reference (paperclip has not enabled per-plugin secret refs yet, or the
 * value is plaintext rather than a UUID), fall back to using the raw value.
 *
 * This lets the same plugin code work in both modes without a config-shape
 * migration when paperclip flips the feature on.
 */
async function maybeResolve(
  value: string,
  secretsResolve: (ref: string) => Promise<string>,
): Promise<string> {
  try {
    return await secretsResolve(value);
  } catch {
    return value;
  }
}
