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
 * - Company isolation: the acting company is taken exclusively from the
 *   invocation scope; plugins cannot self-declare a company ID. Any error
 *   after UUID-format validation is masked as `InvalidSecretRefError` so
 *   a plugin cannot use the error message to oracle whether a UUID belongs
 *   to another company.
 *
 * @see PLUGIN_SPEC.md §22 — Secrets
 * @see host-client-factory.ts — capability gating
 * @see services/secrets.ts — secretService used by agent env bindings
 */

import type { Db } from "@paperclipai/db";
import {
  collectSecretRefPaths,
  isUuidSecretRef,
  readConfigValueAtPath,
} from "./json-schema-secret-refs.js";

/**
 * Exported for the plugin-config-upload route which blocks new config saves
 * that contain secret-ref values until the config pipeline validates ownership.
 * Runtime resolution (this module) is now fully implemented; the upload gate
 * is a separate concern.
 */
export const PLUGIN_SECRET_REFS_DISABLED_MESSAGE =
  "Plugin secret references are not yet supported in plugin instance config updates";

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

  const secretPaths = collectSecretRefPaths(schema);

  // If schema declares secret-ref paths, extract only those values.
  if (secretPaths.size > 0) {
    for (const dotPath of secretPaths) {
      const current = readConfigValueAtPath(configJson as Record<string, unknown>, dotPath);
      if (typeof current === "string" && isUuidSecretRef(current)) {
        addRef(current, dotPath);
      }
    }
    return refs;
  }

  // Fallback: no schema or no secret-ref annotations — collect all UUIDs.
  // This preserves backwards compatibility for plugins that omit
  // instanceConfigSchema.
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
 * Minimal invocation context passed from `host-client-factory` to the handler.
 * Mirrors `WorkerHostCallContext` from the SDK without importing it.
 */
export interface PluginCallContext {
  invocationScope?: { companyId: string } | null;
  invalidInvocationScope?: boolean;
}

/**
 * Options for creating the plugin secrets handler.
 */
export interface PluginSecretsHandlerOptions {
  /** Database connection (kept for future per-plugin policy checks). */
  db: Db;
  /**
   * The plugin ID using this handler.
   * Used for rate-limiting and logging only; never included in error payloads.
   */
  pluginId: string;
  /**
   * Delegate that resolves a secret by company + UUID, enforcing company
   * ownership and recording an access event. Provided by `buildHostServices`
   * so the plugin handler does not duplicate the secrets-service internals.
   */
  resolveSecretValue: (
    companyId: string,
    secretId: string,
    version: number | "latest",
  ) => Promise<string>;
}

/**
 * The `HostServices.secrets` adapter for the plugin host-client factory.
 */
export interface PluginSecretsService {
  /**
   * Resolve a secret reference to its current plaintext value.
   *
   * @param params - Contains the `secretRef` (UUID of the secret)
   * @param context - Invocation context carrying the acting company scope
   * @returns The resolved secret value
   * @throws {InvalidSecretRefError} For any failure after UUID-format validation
   *   (missing scope, wrong company, unknown secret, provider error).
   *   All post-UUID errors are masked so plugins cannot oracle cross-company ownership.
   */
  resolve(params: PluginSecretsResolveParams, context?: PluginCallContext): Promise<string>;
}

/**
 * Create a `HostServices.secrets` adapter for a specific plugin.
 *
 * @example
 * ```ts
 * const svc = secretService(db);
 * const secretsHandler = createPluginSecretsHandler({
 *   db,
 *   pluginId,
 *   resolveSecretValue: svc.resolveSecretValue.bind(svc),
 * });
 * ```
 *
 * @param options - Database connection, plugin identity, and resolve delegate
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
  const { pluginId, resolveSecretValue } = options;

  // Rate limit: max 30 resolution attempts per plugin per minute
  const rateLimiter = createRateLimiter(30, 60_000);

  return {
    async resolve(params: PluginSecretsResolveParams, context?: PluginCallContext): Promise<string> {
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
      // 2. Require a valid invocation scope — fail closed if missing or
      //    corrupted. The company ID must come from the invocation scope
      //    (set by the dispatcher); plugins cannot self-declare it.
      // ---------------------------------------------------------------
      const actingCompanyId =
        !context?.invalidInvocationScope && typeof context?.invocationScope?.companyId === "string"
          ? context.invocationScope.companyId.trim()
          : null;

      if (!actingCompanyId) {
        // Mask as invalid ref: no company scope leaks cross-company information.
        throw invalidSecretRef(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 3. Resolve — ownership is enforced by resolveSecretValue
      //    (throws if secret.companyId !== actingCompanyId). All provider
      //    and ownership errors are masked as InvalidSecretRefError so
      //    plugins cannot oracle cross-company UUID membership.
      // ---------------------------------------------------------------
      try {
        return await resolveSecretValue(actingCompanyId, trimmedRef, "latest");
      } catch {
        // Never surface the real error to the worker — it may reveal
        // whether the UUID exists in another company.
        throw invalidSecretRef(trimmedRef);
      }
    },
  };
}
