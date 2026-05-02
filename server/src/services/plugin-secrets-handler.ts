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
 * A `secretRef` is a **secret UUID** — the primary key (`id`) of a row in
 * the `company_secrets` table. Operators place these UUIDs into plugin
 * config values; plugin workers resolve them at execution time via
 * `ctx.secrets.resolve(secretId)`.
 *
 * ## Security Invariants
 *
 * - Resolved values are **never** logged, persisted, or included in error
 *   messages (per PLUGIN_SPEC.md §22).
 * - The handler is capability-gated: only plugins with `secrets.read-ref`
 *   declared in their manifest may call it (enforced by `host-client-factory`).
 * - The host handler itself does not cache resolved values. Each call goes
 *   through the secret provider to honour rotation.
 *
 * @see PLUGIN_SPEC.md §22 — Secrets
 * @see host-client-factory.ts — capability gating
 * @see services/secrets.ts — secretService used by agent env bindings
 */

import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, companySecretVersions, pluginConfig } from "@paperclipai/db";
import { SECRET_PROVIDERS, type SecretProvider } from "@paperclipai/shared";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { secretService } from "./secrets.js";
import { companyService } from "./companies.js";
import { logActivity } from "./activity-log.js";
import {
  collectSecretRefPaths,
  isUuidSecretRef,
  readConfigValueAtPath,
} from "./json-schema-secret-refs.js";
import { assertPluginAuthorizedForCompany } from "./plugin-company-auth.js";

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
// Write-path validation constants
// ---------------------------------------------------------------------------

/** Allowed secret name characters: alphanumeric, underscore, dash. */
const SECRET_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Reserved name prefixes that plugins must not use. */
const RESERVED_PREFIXES = ["PAPERCLIP_", "BETTER_AUTH_"] as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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
      const current = readConfigValueAtPath(configJson as Record<string, unknown>, dotPath);
      if (typeof current === "string" && isUuidSecretRef(current)) {
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
      if (isUuidSecretRef(value)) refs.add(value);
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
   * Create or rotate a named secret. Attribution uses actorType: "plugin".
   *
   * @param params - companyId, name, value, optional description
   * @returns The secret UUID
   */
  write(params: { companyId: string; name: string; value: string; description?: string }): Promise<string>;

  /**
   * Delete a plugin-owned secret. No-ops if secret does not exist.
   * Throws if the secret is owned by a different actor.
   *
   * @param params - companyId, name
   */
  delete(params: { companyId: string; name: string }): Promise<undefined>;
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

  // Rate limit: max 30 resolve attempts per plugin per minute
  const rateLimiter = createRateLimiter(30, 60_000);
  // Rate limit: max 20 write/delete operations per plugin per minute
  const writeLimiter = createRateLimiter(20, 60_000);

  let cachedAllowedRefs: Set<string> | null = null;
  let cachedAllowedRefsExpiry = 0;
  const CONFIG_CACHE_TTL_MS = 30_000; // 30 seconds, matches event bus TTL

  return {
    async resolve(params: PluginSecretsResolveParams): Promise<string> {
      const { secretRef } = params;

      // ---------------------------------------------------------------
      // 0. Rate limiting — prevent brute-force UUID enumeration
      // ---------------------------------------------------------------
      if (!rateLimiter.check(pluginId)) {
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

      if (!isUuidSecretRef(trimmedRef)) {
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

    async write(params: { companyId: string; name: string; value: string; description?: string }): Promise<string> {
      const { companyId, name, value, description } = params;
      const pluginActorId = `plugin:${pluginId}`;

      // ---------------------------------------------------------------
      // 0. Rate limiting — prevent storage/cost DoS
      // ---------------------------------------------------------------
      if (!writeLimiter.check(pluginId)) {
        const err = new Error("Rate limit exceeded for secret write operations");
        err.name = "RateLimitExceededError";
        throw err;
      }

      // ---------------------------------------------------------------
      // 1. Input validation
      // ---------------------------------------------------------------
      if (!name || name.trim().length === 0) {
        throw new Error("Secret name must not be empty.");
      }
      if (name.length > 255) {
        throw new Error("Secret name must not exceed 255 characters.");
      }
      if (!SECRET_NAME_RE.test(name)) {
        throw new Error("Secret name must only contain alphanumeric characters, underscores, and dashes.");
      }
      if (!value || value.trim().length === 0) {
        throw new Error("Secret value must not be empty.");
      }
      if (Buffer.byteLength(value, "utf8") > 65_536) {
        throw new Error("Secret value must not exceed 64 KiB.");
      }

      const upperName = name.toUpperCase();
      for (const prefix of RESERVED_PREFIXES) {
        if (upperName.startsWith(prefix)) {
          throw new Error(`Secret name "${name}" is reserved for system use.`);
        }
      }

      // ---------------------------------------------------------------
      // 2. Company existence check + plugin authorization
      // ---------------------------------------------------------------
      const company = await companyService(db).getById(companyId);
      if (!company) {
        throw new Error(`Company not found: ${companyId}`);
      }
      await assertPluginAuthorizedForCompany(db, pluginId, companyId);

      // ---------------------------------------------------------------
      // 3. Resolve default provider from environment
      // ---------------------------------------------------------------
      const configuredDefaultProvider = process.env.PAPERCLIP_SECRETS_PROVIDER;
      const defaultProvider = (
        configuredDefaultProvider && SECRET_PROVIDERS.includes(configuredDefaultProvider as SecretProvider)
          ? configuredDefaultProvider
          : "local_encrypted"
      ) as SecretProvider;

      // ---------------------------------------------------------------
      // 4. Ownership check — create or rotate
      // ---------------------------------------------------------------
      const svc = secretService(db);
      const existing = await svc.getByName(companyId, name);

      if (existing) {
        if (existing.createdByUserId !== pluginActorId) {
          throw new Error(`Collision: A secret named "${name}" already exists and was not created by this plugin.`);
        }
        const rotated = await svc.rotate(
          existing.id,
          { value, externalRef: existing.externalRef },
          { userId: pluginActorId, agentId: null },
        );
        await logActivity(db, {
          companyId,
          actorType: "plugin",
          actorId: pluginActorId,
          action: "secret.rotated",
          entityType: "secret",
          entityId: rotated.id,
          details: { name },
        });
        return rotated.id;
      }

      const created = await svc.create(
        companyId,
        { name, provider: defaultProvider, value, description },
        { userId: pluginActorId, agentId: null },
      );
      await logActivity(db, {
        companyId,
        actorType: "plugin",
        actorId: pluginActorId,
        action: "secret.created",
        entityType: "secret",
        entityId: created.id,
        details: { name },
      });
      return created.id;
    },

    async delete(params: { companyId: string; name: string }): Promise<undefined> {
      const { companyId, name } = params;
      const pluginActorId = `plugin:${pluginId}`;

      // ---------------------------------------------------------------
      // 0. Rate limiting
      // ---------------------------------------------------------------
      if (!writeLimiter.check(pluginId)) {
        const err = new Error("Rate limit exceeded for secret write operations");
        err.name = "RateLimitExceededError";
        throw err;
      }

      // ---------------------------------------------------------------
      // 1. Input validation (mirrors write path)
      // ---------------------------------------------------------------
      if (!name || name.trim().length === 0) {
        throw new Error("Secret name must not be empty.");
      }
      if (name.length > 255) {
        throw new Error("Secret name must not exceed 255 characters.");
      }
      if (!SECRET_NAME_RE.test(name)) {
        throw new Error("Secret name must only contain alphanumeric characters, underscores, and dashes.");
      }

      // ---------------------------------------------------------------
      // 2. Company existence check + plugin authorization
      // ---------------------------------------------------------------
      const company = await companyService(db).getById(companyId);
      if (!company) {
        throw new Error(`Company not found: ${companyId}`);
      }
      await assertPluginAuthorizedForCompany(db, pluginId, companyId);

      const svc = secretService(db);
      const existing = await svc.getByName(companyId, name);

      if (!existing) return undefined;

      if (existing.createdByUserId !== pluginActorId) {
        throw new Error(`Secret "${name}" is not owned by this plugin and cannot be deleted.`);
      }

      await svc.remove(existing.id);
      await logActivity(db, {
        companyId,
        actorType: "plugin",
        actorId: pluginActorId,
        action: "secret.deleted",
        entityType: "secret",
        entityId: existing.id,
        details: { name },
      });
      return undefined;
    },
  };
}
