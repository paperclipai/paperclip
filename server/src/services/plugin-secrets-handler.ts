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
  pluginCompanySettings,
} from "@paperclipai/db";
import { SECRET_PROVIDERS, type SecretProvider } from "@paperclipai/shared";

import { getSecretProvider } from "../secrets/provider-registry.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { secretService } from "./secrets.js";
import { logActivity } from "./activity-log.js";
import { HttpError } from "../errors.js";

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
// Validation Constants
// ---------------------------------------------------------------------------

/** UUID v4 regex for validating secretRef format. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Secret name restricted to alphanumeric, underscores, and dashes. */
const SECRET_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Must equal the largest window used in any checkRateLimit call in this file. */
const MAX_RATE_LIMIT_WINDOW_MS = 60_000;

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
// Rate Limiting (Module Level for durability across worker restarts)
// ---------------------------------------------------------------------------

/** Global sliding-window state store keyed by pluginId + companyId + operation. */
const _limiterState = new Map<string, number[]>();

function checkRateLimit(key: string, maxAttempts: number, windowMs: number): boolean {
  const now = Date.now();
  const windowStart = now - windowMs;
  const existing = (_limiterState.get(key) ?? []).filter((ts) => ts > windowStart);
  
  if (existing.length >= maxAttempts) return false;
  
  existing.push(now);
  _limiterState.set(key, existing);
  
  return true;
}

/**
 * Periodically evict fully expired rate limiter entries to prevent memory leaks
 * over long-running process lifetimes with high plugin churn.
 */
setInterval(() => {
  const now = Date.now();
  const windowStart = now - MAX_RATE_LIMIT_WINDOW_MS;
  for (const [key, timestamps] of _limiterState.entries()) {
    const valid = timestamps.filter((ts) => ts > windowStart);
    if (valid.length === 0) {
      _limiterState.delete(key);
    } else if (valid.length !== timestamps.length) {
      _limiterState.set(key, valid);
    }
  }
}, 60_000).unref?.();

/**
 * Reset rate limiters (FOR TESTING ONLY)
 * @internal
 */
export function _resetRateLimiters(): void {
  _limiterState.clear();
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
   * Create or update a secret in the Paperclip vault.
   *
   * @param params - Contains companyId, name, value, and description
   * @returns The generated secret reference UUID
   */
  write(params: { companyId: string; name: string; value: string; description?: string }): Promise<string>;
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

  let cachedAllowedRefs: Set<string> | null = null;
  let cachedAllowedRefsExpiry = 0;
  const CONFIG_CACHE_TTL_MS = 30_000; // 30 seconds, matches event bus TTL

  return {
    async resolve(params: PluginSecretsResolveParams): Promise<string> {
      const { secretRef } = params;

      // ---------------------------------------------------------------
      // 0. Early per-plugin resolve guard (before any DB I/O)
      // ---------------------------------------------------------------
      // Prevents unbounded DB queries for non-existent UUIDs.
      if (!checkRateLimit(`${pluginId}:resolve:global`, 100, MAX_RATE_LIMIT_WINDOW_MS)) {
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
      // 2. Look up the secret record by UUID
      // ---------------------------------------------------------------
      const secret = await db
        .select({ 
          id: companySecrets.id,
          companyId: companySecrets.companyId,
          provider: companySecrets.provider,
          externalRef: companySecrets.externalRef,
          latestVersion: companySecrets.latestVersion,
          createdByUserId: companySecrets.createdByUserId
        })
        .from(companySecrets)
        .where(eq(companySecrets.id, trimmedRef))
        .then((rows) => rows[0] ?? null);

      if (!secret) {
        throw secretNotFound(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 2b. Rate limiting — prevent brute-force UUID enumeration
      // ---------------------------------------------------------------
      // We use the verified companyId from the secret record to prevent
      // bypasses via fake caller-supplied company IDs.
      if (!checkRateLimit(`${pluginId}:${secret.companyId}:resolve`, 30, MAX_RATE_LIMIT_WINDOW_MS)) {
        const err = new Error("Rate limit exceeded for secret resolution");
        err.name = "RateLimitExceededError";
        throw err;
      }

      // ---------------------------------------------------------------
      // 3. Ownership & Multi-Tenant Scoping
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
        // Fallback: Check if the plugin explicitly created this secret.
        // This handles the secure onboarding use-case where a plugin creates
        // a secret via `write` and then immediately needs to `resolve` it.
        //
        // CRITICAL SECURITY: We must also check that the secret belongs to a
        // company that has this plugin enabled.
        const settings = await db
          .select()
          .from(pluginCompanySettings)
          .where(
            and(
              eq(pluginCompanySettings.pluginId, pluginId),
              eq(pluginCompanySettings.companyId, secret.companyId),
              eq(pluginCompanySettings.enabled, true),
            ),
          )
          .then((rows) => rows[0] ?? null);
        
        if (
          secret.createdByUserId !== `plugin:${pluginId}` || 
          !settings
        ) {
          // Return "not found" to avoid leaking cross-tenant secrets
          throw secretNotFound(trimmedRef);
        }
      }

      // ---------------------------------------------------------------
      // 4. Fetch the latest version's material
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
      // 5. Resolve through the appropriate secret provider
      // ---------------------------------------------------------------
      const provider = getSecretProvider(secret.provider as SecretProvider);
      const resolved = await provider.resolveVersion({
        material: versionRow.material as Record<string, unknown>,
        externalRef: secret.externalRef,
      });

      return resolved;
    },

    async write(params: { companyId: string; name: string; value: string; description?: string }): Promise<string> {
      const { companyId } = params;

      // ---------------------------------------------------------------
      // 0. Global Rate limit (Defence in depth)
      // ---------------------------------------------------------------
      // Blunt guard against massive parallel requests with unique fake companyIds
      if (!checkRateLimit(`${pluginId}:global:write`, 50, MAX_RATE_LIMIT_WINDOW_MS)) {
        const err = new Error("Global rate limit exceeded for secret creation");
        err.name = "RateLimitExceededError";
        throw err;
      }

      // ---------------------------------------------------------------
      // 1. Validation — ensure plugin is allowed to act for this company
      // ---------------------------------------------------------------
      // Critical Security: We DO NOT trust the companyId in the payload.
      // We verify that the plugin is actually installed and enabled for this
      // specific company in the database.
      const settings = await db
        .select()
        .from(pluginCompanySettings)
        .where(
          and(
            eq(pluginCompanySettings.pluginId, pluginId),
            eq(pluginCompanySettings.companyId, companyId),
            eq(pluginCompanySettings.enabled, true),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!settings) {
        throw new Error(`Plugin not enabled for company: ${companyId}`);
      }

      // ---------------------------------------------------------------
      // 1b. Scoped Rate limiting — prevent resource exhaustion
      // ---------------------------------------------------------------
      // Now that companyId is verified, apply the specific rate limit.
      if (!checkRateLimit(`${pluginId}:${companyId}:write`, 10, MAX_RATE_LIMIT_WINDOW_MS)) {
        const err = new Error("Rate limit exceeded for secret creation");
        err.name = "RateLimitExceededError";
        throw err;
      }

      // ---------------------------------------------------------------
      // 2. Input validation
      // ---------------------------------------------------------------
      
      // Name validation
      if (!params.name || params.name.trim().length === 0) {
        throw new Error("Secret name must not be empty.");
      }
      if (params.name.length > 255) {
        throw new Error("Secret name must not exceed 255 characters.");
      }
      if (!SECRET_NAME_RE.test(params.name)) {
        throw new Error("Secret name must only contain alphanumeric characters, underscores, and dashes.");
      }

      // Value validation
      if (!params.value || params.value.trim().length === 0) {
        throw new Error("Secret value must not be empty.");
      }
      if (Buffer.byteLength(params.value, "utf8") > 65_536) {
        throw new Error("Secret value must not exceed 64 KiB.");
      }
      if (params.value.includes("\0")) {
        throw new Error("Secret value must not contain null bytes.");
      }

      // Description validation
      if (params.description !== undefined && params.description !== null && Buffer.byteLength(params.description, "utf8") > 1024) {
        throw new Error("Secret description must not exceed 1024 bytes.");
      }

      // ---------------------------------------------------------------
      // 3. Safety check — reserved prefixes
      // ---------------------------------------------------------------
      const upperName = params.name.toUpperCase();
      if (upperName.startsWith("PAPERCLIP_") || upperName.startsWith("BETTER_AUTH_")) {
        throw new Error(`Secret name "${params.name}" is reserved for system use.`);
      }

      // ---------------------------------------------------------------
      // 4. Collision & Ownership Protection
      // ---------------------------------------------------------------
      // Check if a secret with this name already exists for the company.
      // Plugins are allowed to UPDATE their own secrets, but not hijack
      // secrets created by humans or other agents.
      const existing = await secretService(db).getByName(companyId, params.name);
      const pluginActorId = `plugin:${pluginId}`;

      if (existing) {
        if (existing.createdByUserId !== pluginActorId) {
          throw new Error(`Collision: A secret named "${params.name}" already exists and was not created by this plugin.`);
        }
        
        // Update (rotate) the existing secret
        const updated = await secretService(db).rotate(
          existing.id, 
          { 
            value: params.value,
            description: params.description
          },
          { userId: pluginActorId, agentId: null }
        );

        // Audit Logging (Fire and forget to prevent rollback on audit failure)
        logActivity(db, {
          companyId,
          actorType: "system",
          actorId: pluginId,
          action: "secret.rotated",
          entityType: "secret",
          entityId: updated.id,
          details: { name: params.name },
        }).catch((err) => console.warn("[plugin-secrets-handler] Failed to write audit log for secret rotation:", err));

        return updated.id;
      }

      // ---------------------------------------------------------------
      // 5. Secure Creation / Update
      // ---------------------------------------------------------------
      // Crucial Security Requirement: Delegate to secretService to ensure
      // proper provider-level encryption (e.g. AES-256-GCM) is applied before
      // the secret is ever persisted to the database.
      try {
        const secret = await secretService(db).create(
          companyId,
          {
            name: params.name,
            provider: defaultProvider,
            value: params.value,
            description: params.description,
          },
          { userId: pluginActorId, agentId: null }
        );

        // Audit Logging (Fire and forget to prevent rollback on audit failure)
        logActivity(db, {
          companyId,
          actorType: "system",
          actorId: pluginId,
          action: "secret.created",
          entityType: "secret",
          entityId: secret.id,
          details: { name: params.name },
        }).catch((err) => console.warn("[plugin-secrets-handler] Failed to write audit log for secret creation:", err));

        return secret.id;
      } catch (err: any) {
        // Handle TOCTOU race: if creation fails due to a name conflict that 
        // happened between our check and the insert, perform one final 
        // ownership check to provide the correct error message.
        if (err instanceof HttpError && err.status === 409) {
          const raced = await secretService(db).getByName(companyId, params.name);
          if (raced && raced.createdByUserId !== pluginActorId) {
            throw new Error(`Collision: A secret named "${params.name}" already exists and was not created by this plugin.`);
          }
          // If it IS our secret now (won the race), we can try to rotate it
          if (raced) {
            const updated = await secretService(db).rotate(
              raced.id, 
              { 
                value: params.value,
                description: params.description
              },
              { userId: pluginActorId, agentId: null }
            );

            logActivity(db, {
              companyId,
              actorType: "system",
              actorId: pluginId,
              action: "secret.rotated",
              entityType: "secret",
              entityId: updated.id,
              details: { name: params.name },
            }).catch((err) => console.warn("[plugin-secrets-handler] Failed to write audit log for secret rotation (TOCTOU):", err));

            return updated.id;
          }
        }
        throw err;
      }
    },
  };
}
