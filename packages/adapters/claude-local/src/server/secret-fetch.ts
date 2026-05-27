/**
 * Fetches the Tier 1 Anthropic API key (`ANTHROPIC_API_KEY_BLUEPRINT_WORKER`) for
 * the claude_local Tier 0 → Tier 1 failover path. See ROCAA-29.
 *
 * Security & performance contract (audited surface):
 *
 *   1. The secret is **cached in-process** with a TTL. We never refetch per request —
 *      that would burn GCP Secret Manager quota and add per-request latency to every
 *      Tier 1 spawn during a rate-limit storm.
 *   2. The cached value is **never logged**. Only the secret *name* and the *source*
 *      (`env_var` | `gcp_secret_manager`) are exposed to callers, never the bytes.
 *   3. The Anthropic-API-key shape is sanity-checked (`/^sk-/`) before caching so a
 *      misconfigured Secret Manager payload (HTML error page, IAM policy denial body,
 *      etc.) fails closed instead of being passed to the SDK as a "key".
 *   4. Dependencies (`@google-cloud/secret-manager`) are loaded via **dynamic import**
 *      so the rest of the adapter remains usable on hosts that have not installed the
 *      GCP SDK (CI, local dev, on-prem). A clear error is surfaced if Tier 1 needs the
 *      SDK and it is not available.
 *   5. `PAPERCLIP_ANTHROPIC_BLUEPRINT_WORKER_KEY` env var is honored as an explicit
 *      override for local development & tests. When present, Secret Manager is not
 *      contacted at all — operators see this in the meta event (`source: "env_var"`)
 *      so the audit trail still reflects which credential was actually used.
 *
 * Loop-prevention is **not** this module's concern; that lives in the wiring layer
 * (ROCAA-28). This module is a one-shot lookup that returns or throws.
 */

export const BLUEPRINT_WORKER_SECRET_NAME = "ANTHROPIC_API_KEY_BLUEPRINT_WORKER";

/** Env-var override for local dev / tests. Bypasses Secret Manager entirely when set. */
export const BLUEPRINT_WORKER_ENV_OVERRIDE = "PAPERCLIP_ANTHROPIC_BLUEPRINT_WORKER_KEY";

/**
 * Where the secret was sourced from. Surfaced in failover meta events so operators
 * can tell at a glance whether Tier 1 used the production GCP-managed key or a
 * locally-overridden value.
 */
export type SecretSource = "env_var" | "gcp_secret_manager";

export interface FetchedSecret {
  /** The secret bytes. Do NOT log this value; the meta layer logs `name` + `source` only. */
  value: string;
  /** Stable name (matches `BLUEPRINT_WORKER_SECRET_NAME` in production). */
  name: string;
  source: SecretSource;
  /** Epoch ms when this entry was fetched. */
  fetchedAt: number;
}

export interface SecretFetcherOptions {
  /** GCP project id. Defaults to `GCP_PROJECT` / `GOOGLE_CLOUD_PROJECT` env. */
  projectId?: string;
  /** Optional override for the secret resource name (`projects/.../secrets/.../versions/latest`). */
  resourceName?: string;
  /** Cache TTL in ms. Default 10 minutes. */
  ttlMs?: number;
  /**
   * Injection seam used by tests: when provided, this function is called instead of
   * dynamically importing `@google-cloud/secret-manager`. Production code never sets this.
   */
  secretManagerClientFactory?: () => Promise<SecretManagerLike>;
  /** Injection seam for `process.env`; defaults to `process.env`. */
  envOverride?: NodeJS.ProcessEnv;
}

/** Minimal subset of `@google-cloud/secret-manager`'s `SecretManagerServiceClient` we depend on. */
export interface SecretManagerLike {
  accessSecretVersion(request: { name: string }): Promise<
    [{ payload?: { data?: string | Uint8Array | null } | null } | null]
  >;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class SecretFetchError extends Error {
  readonly code:
    | "missing_sdk"
    | "missing_project"
    | "secret_manager_failure"
    | "empty_payload"
    | "malformed_key";
  readonly cause?: unknown;
  constructor(
    code: SecretFetchError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "SecretFetchError";
    this.code = code;
    this.cause = options?.cause;
  }
}

/**
 * Module-level cache. Keyed by `name|projectId|resourceName` so that overriding the
 * resource name in a test does not collide with the production cache slot.
 */
const cache = new Map<string, { secret: FetchedSecret; expiresAt: number }>();

/** Test-only. Clears the in-process secret cache. */
export function __resetSecretCacheForTests(): void {
  cache.clear();
}

function cacheKey(name: string, projectId: string | null, resourceName: string | null): string {
  return `${name}|${projectId ?? ""}|${resourceName ?? ""}`;
}

function looksLikeAnthropicKey(value: string): boolean {
  // Anthropic keys begin with `sk-` (subscription/account keys begin with `sk-ant-`,
  // but we accept both since the secret payload is operator-controlled and may rotate).
  return /^sk-[A-Za-z0-9_-]{8,}$/.test(value.trim());
}

async function loadDefaultSecretManagerClient(): Promise<SecretManagerLike> {
  try {
    // Dynamic import so consumers without the GCP SDK installed don't pay the cost.
    // The `@ts-ignore` is intentional: the package is an optional runtime dep, not
    // present in this package's dependency tree, and is loaded only when Tier 1
    // actually fires in production.
    // @ts-ignore — optional runtime dependency; resolved at runtime in production hosts.
    const mod = (await import("@google-cloud/secret-manager")) as unknown as {
      SecretManagerServiceClient: new () => SecretManagerLike;
    };
    return new mod.SecretManagerServiceClient();
  } catch (err) {
    throw new SecretFetchError(
      "missing_sdk",
      "Tier 1 failover requires @google-cloud/secret-manager. Install it in the host environment " +
        "(`pnpm add -F @paperclipai/adapter-claude-local @google-cloud/secret-manager`) or set " +
        `${BLUEPRINT_WORKER_ENV_OVERRIDE} to provide the API key directly.`,
      { cause: err },
    );
  }
}

/**
 * Returns the cached Anthropic Tier 1 API key, fetching it from GCP Secret Manager on
 * first call (or when the cache entry has expired). Throws `SecretFetchError` with a
 * stable `code` field on any failure so callers can shape user-facing messaging.
 */
export async function fetchBlueprintWorkerKey(
  options: SecretFetcherOptions = {},
): Promise<FetchedSecret> {
  const env = options.envOverride ?? process.env;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();

  // 1. Honor the env-var override first (local dev / tests / break-glass).
  const overrideRaw = env[BLUEPRINT_WORKER_ENV_OVERRIDE];
  if (typeof overrideRaw === "string" && overrideRaw.trim().length > 0) {
    const trimmed = overrideRaw.trim();
    if (!looksLikeAnthropicKey(trimmed)) {
      throw new SecretFetchError(
        "malformed_key",
        `${BLUEPRINT_WORKER_ENV_OVERRIDE} is set but does not look like an Anthropic API key (expected /^sk-/).`,
      );
    }
    const key = cacheKey(BLUEPRINT_WORKER_SECRET_NAME, null, "env_var");
    const existing = cache.get(key);
    if (existing && existing.expiresAt > now) {
      return existing.secret;
    }
    const secret: FetchedSecret = {
      value: trimmed,
      name: BLUEPRINT_WORKER_SECRET_NAME,
      source: "env_var",
      fetchedAt: now,
    };
    cache.set(key, { secret, expiresAt: now + ttlMs });
    return secret;
  }

  // 2. Resolve project + resource name.
  const projectId =
    options.projectId ?? env.GCP_PROJECT ?? env.GOOGLE_CLOUD_PROJECT ?? null;
  const resourceName =
    options.resourceName ??
    (projectId
      ? `projects/${projectId}/secrets/${BLUEPRINT_WORKER_SECRET_NAME}/versions/latest`
      : null);

  if (!resourceName) {
    throw new SecretFetchError(
      "missing_project",
      `Cannot fetch ${BLUEPRINT_WORKER_SECRET_NAME}: no GCP project id available. Set GCP_PROJECT or pass projectId, ` +
        `or set ${BLUEPRINT_WORKER_ENV_OVERRIDE} to provide the key directly.`,
    );
  }

  // 3. Return cached value when fresh.
  const key = cacheKey(BLUEPRINT_WORKER_SECRET_NAME, projectId, resourceName);
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.secret;
  }

  // 4. Fetch from Secret Manager.
  const factory =
    options.secretManagerClientFactory ?? loadDefaultSecretManagerClient;
  let client: SecretManagerLike;
  try {
    client = await factory();
  } catch (err) {
    if (err instanceof SecretFetchError) throw err;
    throw new SecretFetchError(
      "secret_manager_failure",
      `Failed to initialize Secret Manager client: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let response: Awaited<ReturnType<SecretManagerLike["accessSecretVersion"]>>;
  try {
    response = await client.accessSecretVersion({ name: resourceName });
  } catch (err) {
    throw new SecretFetchError(
      "secret_manager_failure",
      `Secret Manager accessSecretVersion(${resourceName}) failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const data = response?.[0]?.payload?.data;
  if (data == null) {
    throw new SecretFetchError(
      "empty_payload",
      `Secret Manager returned no payload for ${resourceName}.`,
    );
  }

  const decoded = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  const trimmed = decoded.trim();
  if (!looksLikeAnthropicKey(trimmed)) {
    // Do NOT include the payload in the error message — it may be an HTML error page,
    // IAM denial body, or a real key fragment. Length is OK to share.
    throw new SecretFetchError(
      "malformed_key",
      `Secret payload for ${resourceName} does not look like an Anthropic API key (length=${trimmed.length}).`,
    );
  }

  const secret: FetchedSecret = {
    value: trimmed,
    name: BLUEPRINT_WORKER_SECRET_NAME,
    source: "gcp_secret_manager",
    fetchedAt: now,
  };
  cache.set(key, { secret, expiresAt: now + ttlMs });
  return secret;
}
