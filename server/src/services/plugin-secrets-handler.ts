/**
 * Plugin secrets host-side handler — resolves secret references through the
 * Paperclip secret provider system.
 *
 * When a plugin worker calls `ctx.secrets.resolve(secretRef)`, the JSON-RPC
 * request arrives at the host worker manager, which dispatches it to the
 * `resolve` method in this handler.
 *
 * ## Security
 *
 * 1. **Capability Gating**: Every call is checked by the `PluginCapabilityValidator`.
 *    The worker manager ensures the plugin has `secrets.read-ref` before
 *    calling this handler.
 *
 * 2. **Scope Isolation**: A plugin may **only** resolve secrets that are
 *    explicitly referenced in its own `plugin_config`. Brute-force UUID
 *    enumeration is prevented by both rate-limiting and a whitelist check.
 *
 * 3. **Material Safety**: The resolved plaintext material is returned as a
 *    JSON-RPC response to the plugin worker. It is the worker's responsibility
 *    to never cache, log, or persist this value.
 *
 * Only the ref identifier is included; never the resolved value.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySecrets,
  companySecretVersions,
  pluginConfig,
} from "@paperclipai/db";
import { SECRET_PROVIDERS, type SecretProvider } from "@paperclipai/shared";

import { getSecretProvider } from "../secrets/provider-registry.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { secretService } from "./secrets.js";

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

/** UUID v4 regex for validating secretRef format. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check whether a secretRef looks like a valid UUID.
 */
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
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
  /** The secret reference string (a secret UUID). */
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
   * Used for logging context only; never included in error payloads
   * that reach the plugin worker.
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
   * @param params - Contains the `secretRef` (UUID of the secret)
   * @returns The resolved secret value
   * @throws {Error} If the secret is not found, has no versions, or
   *   the provider fails to resolve
   */
  resolve(params: PluginSecretsResolveParams): Promise<string>;

  /**
   * Create a new secret in the Paperclip vault.
   *
   * @param params - Contains name, value, and description
   * @returns The generated secret reference UUID
   */
  write(params: { name: string; value: string; description?: string }): Promise<string>;
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
  const registry = pluginRegistryService(db);

  // Resolve default provider from environment
  const configuredDefaultProvider = process.env.PAPERCLIP_SECRETS_PROVIDER;
  const defaultProvider = (
    configuredDefaultProvider && SECRET_PROVIDERS.includes(configuredDefaultProvider as SecretProvider)
      ? configuredDefaultProvider
      : "local_encrypted"
  ) as SecretProvider;

  // Rate limiters:
  // - resolve: max 30 resolution attempts per plugin per minute
  // - write: max 10 creation attempts per plugin per minute (conservative to prevent abuse)
  const resolveRateLimiter = createRateLimiter(30, 60_000);
  const writeRateLimiter = createRateLimiter(10, 60_000);

  let cachedAllowedRefs: Set<string> | null = null;
  let cachedAllowedRefsExpiry = 0;
  const CONFIG_CACHE_TTL_MS = 30_000; // 30 seconds, matches event bus TTL

  return {
    async resolve(params: PluginSecretsResolveParams): Promise<string> {
      const { secretRef } = params;

      // ---------------------------------------------------------------
      // 0. Rate limiting — prevent brute-force UUID enumeration
      // ---------------------------------------------------------------
      if (!resolveRateLimiter.check(pluginId)) {
        const err = new Error("Rate limit exceeded for secret resolution");
        err.name = "RateLimitExceededError";
        throw err;
      }

      // ---------------------------------------------------------------
      // 1. Validate the ref format
      // ---------------------------------------------------------------
      if (!secretRef || typeof secretRef !== "string" || secretRef.trim().length === 0) {
        throw invalidSecretRef(secretRef ?? "<empty>");
      }

      const trimmedRef = secretRef.trim();

      if (!isUuid(trimmedRef)) {
        throw invalidSecretRef(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 1b. Scope check — only allow secrets referenced in this plugin's config
      // ---------------------------------------------------------------
      const now = Date.now();
      if (!cachedAllowedRefs || now > cachedAllowedRefsExpiry) {
        const [configRow, plugin] = await Promise.all([
          db
            .select()
            .from(pluginConfig)
            .where(eq(pluginConfig.pluginId, pluginId))
            .then((rows) => rows[0] ?? null),
          registry.getById(pluginId),
        ]);

        const schema = (plugin?.manifestJson as unknown as Record<string, unknown> | null)
          ?.instanceConfigSchema as Record<string, unknown> | undefined;
        cachedAllowedRefs = extractSecretRefsFromConfig(configRow?.configJson, schema);
        cachedAllowedRefsExpiry = now + CONFIG_CACHE_TTL_MS;
      }

      if (!cachedAllowedRefs.has(trimmedRef)) {
        // Return "not found" to avoid leaking whether the secret exists
        throw secretNotFound(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 2. Look up the secret record by UUID
      // ---------------------------------------------------------------
      const secret = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.id, trimmedRef))
        .then((rows) => rows[0] ?? null);

      if (!secret) {
        throw secretNotFound(trimmedRef);
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
        throw secretVersionNotFound(trimmedRef);
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

    async write(params: { name: string; value: string; description?: string }): Promise<string> {
      // ---------------------------------------------------------------
      // 0. Rate limiting — prevent resource exhaustion
      // ---------------------------------------------------------------
      if (!writeRateLimiter.check(pluginId)) {
        const err = new Error("Rate limit exceeded for secret creation");
        err.name = "RateLimitExceededError";
        throw err;
      }

      // ---------------------------------------------------------------
      // 1. Resolve owning company (Critical Security: Anti-Injection)
      // ---------------------------------------------------------------
      const plugin = await registry.getById(pluginId);
      if (!plugin) {
        throw new Error("Plugin not found");
      }
      const companyId = plugin.companyId;

      // ---------------------------------------------------------------
      // 2. Safety check — reserved prefixes
      // ---------------------------------------------------------------
      const upperName = params.name.toUpperCase();
      if (upperName.startsWith("PAPERCLIP_") || upperName.startsWith("BETTER_AUTH_")) {
        throw new Error(`Secret name "${params.name}" is reserved for system use.`);
      }

      // ---------------------------------------------------------------
      // 3. Secure Creation
      // ---------------------------------------------------------------
      // Crucial Security Requirement: Delegate to secretService to ensure
      // proper provider-level encryption (e.g. AES-256-GCM) is applied before
      // the secret is ever persisted to the database.
      const secret = await secretService(db).create(
        companyId,
        {
          name: params.name,
          provider: defaultProvider,
          value: params.value,
          description: params.description,
        },
        { agentId: null, userId: null } // Attributed to system/plugin via companyId context
      );

      return secret.id;
    },
  };
}
