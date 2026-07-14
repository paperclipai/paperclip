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

import type { Db } from "@paperclipai/db";
import {
  isUuidSecretRef,
} from "./json-schema-secret-refs.js";

export const PLUGIN_SECRET_REFS_DISABLED_MESSAGE =
  "Plugin secret references are disabled until company-scoped plugin config lands";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function invalidSecretRef(secretRef: string): Error {
  const err = new Error(`Invalid secret reference: ${secretRef}`);
  err.name = "InvalidSecretRefError";
  return err;
}

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
  return new Set(extractSecretRefPathsFromConfig(configJson, schema).keys());
}

export function extractSecretRefPathsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  const addRef = (secretRef: string, path: string) => {
    const existing = refs.get(secretRef) ?? new Set<string>();
    existing.add(path);
    refs.set(secretRef, existing);
  };
  if (configJson == null || typeof configJson !== "object") return new Map();

  // A declared schema is authoritative. Traverse schema and config together so
  // array item schemas resolve to their concrete config indexes instead of
  // falling back to UUID-shape discovery.
  if (schema != null) {
    collectSchemaSecretRefs(configJson, schema, "", addRef);
    return refs;
  }

  // Legacy fallback for plugins that omit instanceConfigSchema entirely.
  function walkAll(value: unknown): void {
    if (typeof value === "string") {
      if (isUuidSecretRef(value)) addRef(value, "$");
    } else if (Array.isArray(value)) {
      for (const item of value) walkAll(item);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walkAll(v);
    }
  }

  walkAll(configJson);
  return refs;
}

function collectSchemaSecretRefs(
  configValue: unknown,
  schemaNode: Record<string, unknown>,
  path: string,
  addRef: (secretRef: string, path: string) => void,
): void {
  if (schemaNode.format === "secret-ref") {
    if (typeof configValue === "string" && isUuidSecretRef(configValue)) {
      addRef(configValue, path || "$");
    }
    return;
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schemaNode[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (isSchemaNode(branch)) collectSchemaSecretRefs(configValue, branch, path, addRef);
    }
  }

  if (Array.isArray(configValue)) {
    const prefixItems = Array.isArray(schemaNode.prefixItems) ? schemaNode.prefixItems : [];
    for (let index = 0; index < prefixItems.length && index < configValue.length; index += 1) {
      const itemSchema = prefixItems[index];
      if (isSchemaNode(itemSchema)) {
        collectSchemaSecretRefs(configValue[index], itemSchema, appendPath(path, String(index)), addRef);
      }
    }

    const items = schemaNode.items;
    if (Array.isArray(items)) {
      for (let index = 0; index < items.length && index < configValue.length; index += 1) {
        const itemSchema = items[index];
        if (isSchemaNode(itemSchema)) {
          collectSchemaSecretRefs(configValue[index], itemSchema, appendPath(path, String(index)), addRef);
        }
      }
    } else if (isSchemaNode(items)) {
      for (let index = prefixItems.length; index < configValue.length; index += 1) {
        collectSchemaSecretRefs(configValue[index], items, appendPath(path, String(index)), addRef);
      }
    }
    return;
  }

  if (!configValue || typeof configValue !== "object") return;
  const configObject = configValue as Record<string, unknown>;
  const properties = isSchemaNode(schemaNode.properties)
    ? schemaNode.properties as Record<string, unknown>
    : {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!isSchemaNode(propertySchema)) continue;
    collectSchemaSecretRefs(configObject[key], propertySchema, appendPath(path, key), addRef);
  }

  if (isSchemaNode(schemaNode.additionalProperties)) {
    for (const [key, value] of Object.entries(configObject)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      collectSchemaSecretRefs(value, schemaNode.additionalProperties, appendPath(path, key), addRef);
    }
  }
}

function isSchemaNode(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function appendPath(prefix: string, segment: string): string {
  return prefix ? `${prefix}.${segment}` : segment;
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
  const { pluginId } = options;

  // Rate limit: max 30 resolution attempts per plugin per minute
  const rateLimiter = createRateLimiter(30, 60_000);

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

      // Fail closed until plugin config and worker runtime both carry an
      // explicit company scope for secret bindings and resolution.
      throw new Error(PLUGIN_SECRET_REFS_DISABLED_MESSAGE);
    },
  };
}
