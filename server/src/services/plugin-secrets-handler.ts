/**
 * Plugin secrets host-side handler — resolves secret references through the
 * Paperclip secret provider system.
 *
 * When a plugin worker calls `ctx.secrets.resolve(secretRef)`, the JSON-RPC
 * request arrives at the host with `{ secretRef }`. This module provides the
 * concrete `HostServices.secrets` adapter that:
 *
 * 1. Parses the `secretRef` string to identify the secret.
 * 2. Looks up the secret record and its latest version in the database.
 * 3. Delegates to the configured `SecretProviderModule` to decrypt /
 *    resolve the raw value.
 * 4. Returns the resolved plaintext value to the worker.
 *
 * ## Secret Reference Format
 *
 * A `secretRef` can be provided in two formats:
 *
 * - **Bare UUID**: `"a1b2c3d4-e5f6-7890-abcd-ef1234567890"` — the primary
 *   key (`id`) of a row in the `company_secrets` table.
 * - **Prefixed UUID**: `"secret:a1b2c3d4-e5f6-7890-abcd-ef1234567890"` —
 *   the `secret:` prefix is stripped before lookup.
 *
 * Operators may place UUIDs into plugin config values; plugins may also
 * store secret references programmatically (e.g. after creating a secret
 * via the platform REST API). Both paths are supported.
 *
 * ## Security Invariants
 *
 * - Resolved values are **never** logged, persisted, or included in error
 *   messages (per PLUGIN_SPEC.md §22).
 * - The handler is capability-gated: only plugins with `secrets.read-ref`
 *   declared in their manifest may call it (enforced by `host-client-factory`).
 * - The host handler itself does not cache resolved values. Each call goes
 *   through the secret provider to honour rotation.
 * - Company isolation is enforced: secrets are only resolvable if they
 *   belong to a company the plugin is associated with (per AGENTS.md §5).
 * - Per-plugin rate limiting (30 attempts/minute, process-local) provides
 *   best-effort defence against UUID enumeration. In multi-instance
 *   deployments this limit is per-process; defence-in-depth relies on
 *   UUID entropy (122 bits) and company scoping.
 *
 * @see PLUGIN_SPEC.md §22 — Secrets
 * @see host-client-factory.ts — capability gating
 * @see services/secrets.ts — secretService used by agent env bindings
 */

import { eq, and, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySecrets,
  companySecretVersions,
  pluginCompanySettings,
} from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { getSecretProvider } from "../secrets/provider-registry.js";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Create a sanitised error that never leaks secret material.
 * Only the ref identifier is included; never the resolved value.
 */
function secretNotFound(secretRef: string): Error {
  const err = new Error(`Secret not found: ${secretRef}`);
  err.name = "SecretNotFoundError";
  return err;
}

function secretVersionNotFound(secretRef: string): Error {
  const err = new Error(`No version found for secret: ${secretRef}`);
  err.name = "SecretVersionNotFoundError";
  return err;
}

function invalidSecretRef(secretRef: string): Error {
  const err = new Error(`Invalid secret reference: ${secretRef}`);
  err.name = "InvalidSecretRefError";
  return err;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Regex for validating a RFC-4122 UUID (any version). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `secret:` prefix that the platform may return on stored refs. */
const SECRET_PREFIX = "secret:";

/** Maximum length for a raw secretRef string (before parsing). */
const MAX_SECRET_REF_LENGTH = 256;

/**
 * Check whether a secretRef looks like a valid UUID.
 */
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Parse a secret reference string and extract the UUID.
 *
 * Accepts bare UUIDs or `secret:`-prefixed UUIDs.  Returns the normalised
 * UUID string, or `null` if the ref does not contain a valid UUID.
 *
 * Examples:
 * - `"a1b2c3d4-..."` → `"a1b2c3d4-..."`
 * - `"secret:a1b2c3d4-..."` → `"a1b2c3d4-..."`
 * - `"MY_API_KEY"` → `null`
 * - `""` → `null`
 */
export function parseSecretRef(raw: string): string | null {
  if (!raw || raw.length > MAX_SECRET_REF_LENGTH) return null;
  const stripped = raw.startsWith(SECRET_PREFIX)
    ? raw.slice(SECRET_PREFIX.length)
    : raw;
  if (!stripped || !isUuid(stripped)) return null;
  return stripped;
}

/**
 * Collect the property paths (dot-separated keys) whose schema node declares
 * `format: "secret-ref"`. Only top-level and nested `properties` are walked —
 * this mirrors the flat/nested object shapes that `JsonSchemaForm` renders.
 */
function collectSecretRefPaths(
  schema: Record<string, unknown> | null | undefined,
): Set<string> {
  const paths = new Set<string>();
  if (!schema || typeof schema !== "object") return paths;

  function walk(node: Record<string, unknown>, prefix: string): void {
    const props = node.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props || typeof props !== "object") return;
    for (const [key, propSchema] of Object.entries(props)) {
      if (!propSchema || typeof propSchema !== "object") continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (propSchema.format === "secret-ref") {
        paths.add(path);
      }
      // Recurse into nested object schemas
      if (propSchema.type === "object") {
        walk(propSchema, path);
      }
    }
  }

  walk(schema, "");
  return paths;
}

/**
 * Extract secret reference UUIDs from a plugin's configJson, scoped to only
 * the fields annotated with `format: "secret-ref"` in the schema.
 *
 * When no schema is provided, falls back to collecting all UUID-shaped strings
 * (backwards-compatible for plugins without a declared instanceConfigSchema).
 */
export function extractSecretRefsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Set<string> {
  const refs = new Set<string>();
  if (configJson == null || typeof configJson !== "object") return refs;

  const secretPaths = collectSecretRefPaths(schema);

  // If schema declares secret-ref paths, extract only those values.
  if (secretPaths.size > 0) {
    for (const dotPath of secretPaths) {
      const keys = dotPath.split(".");
      let current: unknown = configJson;
      for (const k of keys) {
        if (current == null || typeof current !== "object") { current = undefined; break; }
        current = (current as Record<string, unknown>)[k];
      }
      if (typeof current === "string" && isUuid(current)) {
        refs.add(current);
      }
    }
    return refs;
  }

  // Fallback: no schema or no secret-ref annotations — collect all UUIDs.
  // This preserves backwards compatibility for plugins that omit
  // instanceConfigSchema.
  function walkAll(value: unknown): void {
    if (typeof value === "string") {
      if (isUuid(value)) refs.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walkAll(item);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walkAll(v);
    }
  }

  walkAll(configJson);
  return refs;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Input shape for the `secrets.resolve` handler.
 *
 * Matches `WorkerToHostMethods["secrets.resolve"][0]` from `protocol.ts`.
 */
export interface PluginSecretsResolveParams {
  /**
   * The secret reference string — a UUID identifying a row in the
   * `company_secrets` table. May optionally carry a `secret:` prefix
   * (e.g. `"secret:550e8400-e29b-41d4-a716-446655440000"`).
   */
  secretRef: string;
}

/**
 * Options for creating the plugin secrets handler.
 */
export interface PluginSecretsHandlerOptions {
  /** Database connection. */
  db: Db;
  /**
   * The plugin ID using this handler.
   * Used for company-scoping and rate-limiting; never included in error
   * payloads that reach the plugin worker.
   */
  pluginId: string;
}

/**
 * The `HostServices.secrets` adapter for the plugin host-client factory.
 */
export interface PluginSecretsService {
  /**
   * Resolve a secret reference to its current plaintext value.
   *
   * @param params - Contains the `secretRef` (UUID, optionally `secret:`-prefixed)
   * @returns The resolved secret value
   * @throws {Error} If the ref is invalid, the secret is not found, has no
   *   versions, or the provider fails to resolve
   */
  resolve(params: PluginSecretsResolveParams): Promise<string>;
}

/**
 * Create a `HostServices.secrets` adapter for a specific plugin.
 *
 * The returned service looks up secrets by UUID, fetches the latest version
 * material, and delegates to the appropriate `SecretProviderModule` for
 * decryption.
 *
 * @example
 * ```ts
 * const secretsHandler = createPluginSecretsHandler({ db, pluginId });
 * const handlers = createHostClientHandlers({
 *   pluginId,
 *   capabilities: manifest.capabilities,
 *   services: {
 *     secrets: secretsHandler,
 *     // ...
 *   },
 * });
 * ```
 *
 * @param options - Database connection and plugin identity
 * @returns A `PluginSecretsService` suitable for `HostServices.secrets`
 */

/** Simple sliding-window rate limiter for secret resolution attempts. */
function createRateLimiter(maxAttempts: number, windowMs: number) {
  const attempts = new Map<string, number[]>();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const windowStart = now - windowMs;
      const existing = (attempts.get(key) ?? []).filter((ts) => ts > windowStart);
      if (existing.length >= maxAttempts) return false;
      existing.push(now);
      attempts.set(key, existing);
      return true;
    },
  };
}

export function createPluginSecretsHandler(
  options: PluginSecretsHandlerOptions,
): PluginSecretsService {
  const { db, pluginId } = options;

  // Rate limit: max 30 resolution attempts per plugin per minute.
  // NOTE: This limiter is process-local. In multi-instance deployments the
  // effective limit is 30 × N where N is the number of instances.
  // Defence-in-depth relies on UUID entropy (122 bits) and the company
  // scoping below — not solely on this rate limiter.
  const rateLimiter = createRateLimiter(30, 60_000);

  // Cache the set of company IDs this plugin is associated with.
  // Plugins are instance-wide, but plugin_company_settings maps them
  // to specific companies. We use this to enforce company boundaries
  // on secret lookups (AGENTS.md §5).
  let cachedCompanyIds: string[] | null = null;
  let cachedCompanyIdsExpiry = 0;
  const COMPANY_CACHE_TTL_MS = 30_000;

  async function getPluginCompanyIds(): Promise<string[]> {
    const now = Date.now();
    if (cachedCompanyIds && now < cachedCompanyIdsExpiry) {
      return cachedCompanyIds;
    }
    const rows = await db
      .select({ companyId: pluginCompanySettings.companyId })
      .from(pluginCompanySettings)
      .where(eq(pluginCompanySettings.pluginId, pluginId));
    cachedCompanyIds = rows.map((r) => r.companyId);
    cachedCompanyIdsExpiry = now + COMPANY_CACHE_TTL_MS;
    return cachedCompanyIds;
  }

  return {
    async resolve(params: PluginSecretsResolveParams): Promise<string> {
      const { secretRef } = params;

      // ---------------------------------------------------------------
      // 0. Rate limiting — best-effort defence against UUID enumeration
      // ---------------------------------------------------------------
      if (!rateLimiter.check(pluginId)) {
        const err = new Error("Rate limit exceeded for secret resolution");
        err.name = "RateLimitExceededError";
        throw err;
      }

      // ---------------------------------------------------------------
      // 1. Validate and parse the ref format
      // ---------------------------------------------------------------
      if (!secretRef || typeof secretRef !== "string" || secretRef.trim().length === 0) {
        throw invalidSecretRef(secretRef ?? "<empty>");
      }

      const trimmed = secretRef.trim();
      const secretId = parseSecretRef(trimmed);

      if (!secretId) {
        throw invalidSecretRef(trimmed);
      }

      // ---------------------------------------------------------------
      // 2. Look up the secret record by UUID, scoped to the plugin's
      //    associated companies (AGENTS.md §5 — company boundaries).
      //
      //    If the plugin has no company settings rows it is enabled for
      //    all companies by default, so we skip the company filter.
      //    In that case, isolation relies on capability gating and UUID
      //    entropy.
      // ---------------------------------------------------------------
      const companyIds = await getPluginCompanyIds();

      const conditions = companyIds.length > 0
        ? and(
            eq(companySecrets.id, secretId),
            inArray(companySecrets.companyId, companyIds),
          )
        : eq(companySecrets.id, secretId);

      const secret = await db
        .select()
        .from(companySecrets)
        .where(conditions)
        .then((rows) => rows[0] ?? null);

      if (!secret) {
        throw secretNotFound(trimmed);
      }

      // ---------------------------------------------------------------
      // 3. Fetch the latest version's material
      // ---------------------------------------------------------------
      const versionRow = await db
        .select()
        .from(companySecretVersions)
        .where(
          and(
            eq(companySecretVersions.secretId, secret.id),
            eq(companySecretVersions.version, secret.latestVersion),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!versionRow) {
        throw secretVersionNotFound(trimmed);
      }

      // ---------------------------------------------------------------
      // 4. Resolve through the appropriate secret provider
      // ---------------------------------------------------------------
      const provider = getSecretProvider(secret.provider as SecretProvider);
      const resolved = await provider.resolveVersion({
        material: versionRow.material as Record<string, unknown>,
        externalRef: secret.externalRef,
      });

      return resolved;
    },
  };
}
