/**
 * Plugin secrets host-side handler. Plugin workers may resolve shared
 * `secret_ref` config bindings only with an explicit company context.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecretBindings, companySecrets } from "@paperclipai/db";
import type { EnvSecretRefBinding, SecretProjectionClass, SecretVersionSelector } from "@paperclipai/shared";
import { envBindingSecretRefSchema } from "@paperclipai/shared";
import {
  collectSecretRefPaths,
  isUuidSecretRef,
  readConfigValueAtPath,
} from "./json-schema-secret-refs.js";
import { secretService } from "./secrets.js";
import { unprocessable } from "../errors.js";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function invalidSecretRef(secretRef: unknown): Error {
  const rendered = typeof secretRef === "string" ? secretRef : JSON.stringify(secretRef);
  const err = new Error(
    `Invalid secret reference for plugin: ${rendered ?? "<empty>"}. Use { type: "secret_ref", secretId, version? }`,
  );
  err.name = "InvalidSecretRefError";
  return err;
}

function requireCompanyId(companyId: unknown): string {
  if (typeof companyId !== "string" || companyId.trim().length === 0) {
    throw unprocessable("companyId is required for plugin secret resolution");
  }
  return companyId.trim();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSecretRefBinding(value: unknown): EnvSecretRefBinding | null {
  const parsed = envBindingSecretRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function assertSecretRefBinding(
  value: unknown,
  path: string,
  rejectLegacyUuid = false,
): EnvSecretRefBinding | null {
  if (rejectLegacyUuid && typeof value === "string" && isUuidSecretRef(value)) {
    throw unprocessable(
      `Plugin secret ref at ${path} must use { type: "secret_ref", secretId, version? }`,
    );
  }
  if (!isPlainRecord(value) || value.type !== "secret_ref") return null;
  const parsed = parseSecretRefBinding(value);
  if (!parsed) {
    throw unprocessable(`Invalid secret_ref binding at ${path}`);
  }
  return parsed;
}

export interface PluginConfigSecretRefBinding {
  secretId: string;
  configPath: string;
  versionSelector?: SecretVersionSelector;
  required?: boolean;
  label?: string | null;
  projectionClass?: SecretProjectionClass;
  projectionAllowlistKey?: string | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Extract shared object-shaped secret refs from plugin config. */
export function extractSecretRefBindingsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): PluginConfigSecretRefBinding[] {
  if (configJson == null || typeof configJson !== "object") return [];

  const refsByPath = new Map<string, PluginConfigSecretRefBinding>();
  const addRef = (binding: EnvSecretRefBinding, configPath: string) => {
    refsByPath.set(configPath, {
      secretId: binding.secretId,
      configPath,
      versionSelector: binding.version ?? "latest",
      required: true,
      label: configPath,
      projectionClass: binding.projectionClass,
      projectionAllowlistKey: binding.projectionAllowlistKey ?? null,
    });
  };

  const secretPaths = collectSecretRefPaths(schema);
  for (const dotPath of secretPaths) {
    const current = readConfigValueAtPath(configJson as Record<string, unknown>, dotPath);
    const binding = assertSecretRefBinding(current, dotPath, true);
    if (binding) addRef(binding, dotPath);
  }

  function walk(value: unknown, path: string): void {
    const binding = assertSecretRefBinding(value, path || "$");
    if (binding) {
      addRef(binding, path || "$");
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, path ? `${path}.${index}` : String(index)));
      return;
    }
    if (!isPlainRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key);
    }
  }

  walk(configJson, "");
  return [...refsByPath.values()];
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface PluginSecretsResolveParams {
  /** Shared secret reference object from company-scoped plugin config. */
  secretRef: string | EnvSecretRefBinding;
  /** Authorized company context for this worker invocation. */
  companyId?: string;
  /** Config path that produced this ref. Required when a secret appears in multiple paths. */
  configPath?: string;
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string | null;
  issueId?: string | null;
  heartbeatRunId?: string | null;
}

export interface PluginSecretsHandlerOptions {
  db: Db;
  pluginId: string;
}

export interface PluginSecretsStoreParams {
  companyId?: string;
  value: string;
}

export interface PluginSecretsDiscardParams {
  companyId?: string;
  secretId: string;
}

export interface PluginSecretsService {
  resolve(params: PluginSecretsResolveParams): Promise<string>;
  store(params: PluginSecretsStoreParams): Promise<{ secretId: string; configPath: string }>;
  discard(params: PluginSecretsDiscardParams): Promise<void>;
}

const PLUGIN_OWNED_SECRET_PREFIX = "plugin-secret.";
const MAX_PLUGIN_SECRET_VALUE_CHARS = 256 * 1024;

function pluginOwnedConfigPath(secretId: string): string {
  return `${PLUGIN_OWNED_SECRET_PREFIX}${secretId}`;
}

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
  const rateLimiter = createRateLimiter(30, 60_000);

  async function lookupBinding(input: {
    companyId: string;
    secretId: string;
    versionSelector: SecretVersionSelector;
    configPath?: string;
  }) {
    const conditions = [
      eq(companySecretBindings.companyId, input.companyId),
      eq(companySecretBindings.targetType, "plugin"),
      eq(companySecretBindings.targetId, pluginId),
      eq(companySecretBindings.secretId, input.secretId),
    ];
    if (input.configPath) {
      conditions.push(eq(companySecretBindings.configPath, input.configPath));
    }
    const rows = await db
      .select()
      .from(companySecretBindings)
      .where(and(...conditions));
    const matchingVersion = rows.filter(
      (row) => row.versionSelector === String(input.versionSelector),
    );
    return matchingVersion;
  }

  return {
    async resolve(params: PluginSecretsResolveParams): Promise<string> {
      if (typeof params.secretRef === "string") {
        throw invalidSecretRef(params.secretRef.trim() || "<empty>");
      }

      const bindingRef = parseSecretRefBinding(params.secretRef);
      if (!bindingRef) throw invalidSecretRef(params.secretRef);

      const companyId = requireCompanyId(params.companyId);

      if (!rateLimiter.check(`${companyId}:${pluginId}`)) {
        const err = new Error("Rate limit exceeded for secret resolution");
        err.name = "RateLimitExceededError";
        throw err;
      }

      const versionSelector = bindingRef.version ?? "latest";
      const bindings = await lookupBinding({
        companyId,
        secretId: bindingRef.secretId,
        versionSelector,
        configPath: params.configPath,
      });

      if (bindings.length === 0) {
        throw unprocessable(
          `Secret is not bound to plugin:${pluginId}${params.configPath ? ` at ${params.configPath}` : ""}`,
          { code: "binding_missing" },
        );
      }
      if (bindings.length > 1) {
        throw unprocessable(
          "Plugin secret reference is ambiguous; pass configPath when resolving this secret",
          { code: "binding_ambiguous" },
        );
      }

      const binding = bindings[0]!;
      return secretService(db).resolveSecretValue(companyId, bindingRef.secretId, versionSelector, {
        bindingContext: {
          consumerType: "plugin",
          consumerId: pluginId,
          configPath: binding.configPath,
          actorType: params.actorType ?? "plugin",
          actorId: params.actorId ?? pluginId,
          issueId: params.issueId ?? null,
          heartbeatRunId: params.heartbeatRunId ?? null,
          pluginId,
        },
        accessContext: {
          consumerType: "plugin_worker",
          consumerId: pluginId,
          configPath: binding.configPath,
          actorType: params.actorType ?? "plugin",
          actorId: params.actorId ?? pluginId,
          issueId: params.issueId ?? null,
          heartbeatRunId: params.heartbeatRunId ?? null,
          pluginId,
        },
      });
    },

    async store(params: PluginSecretsStoreParams): Promise<{ secretId: string; configPath: string }> {
      const companyId = requireCompanyId(params.companyId);
      if (!rateLimiter.check(`${companyId}:${pluginId}:write`)) {
        const err = new Error("Rate limit exceeded for secret writes");
        err.name = "RateLimitExceededError";
        throw err;
      }
      const value = typeof params.value === "string" ? params.value : "";
      if (!value) throw unprocessable("Refusing to store an empty secret");
      if (value.length > MAX_PLUGIN_SECRET_VALUE_CHARS) {
        throw unprocessable("Secret value is too large");
      }
      const created = await secretService(db).create(companyId, {
        name: `plugin-session-${randomUUID()}`,
        provider: "local_encrypted",
        value,
      });
      const configPath = pluginOwnedConfigPath(created.id);
      try {
        await secretService(db).createBinding({
          companyId,
          secretId: created.id,
          targetType: "plugin",
          targetId: pluginId,
          configPath,
          versionSelector: "latest",
          projectionClass: "unclassified",
        });
      } catch (error) {
        await secretService(db).remove(created.id).catch(() => undefined);
        throw error;
      }
      return { secretId: created.id, configPath };
    },

    async discard(params: PluginSecretsDiscardParams): Promise<void> {
      const companyId = requireCompanyId(params.companyId);
      const secretId = params.secretId.trim();
      if (!secretId) throw unprocessable("secretId is required");
      if (!rateLimiter.check(`${companyId}:${pluginId}:write`)) {
        const err = new Error("Rate limit exceeded for secret writes");
        err.name = "RateLimitExceededError";
        throw err;
      }
      const configPath = pluginOwnedConfigPath(secretId);
      const owned = await db
        .select({ id: companySecretBindings.id })
        .from(companySecretBindings)
        .where(and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "plugin"),
          eq(companySecretBindings.targetId, pluginId),
          eq(companySecretBindings.secretId, secretId),
          eq(companySecretBindings.configPath, configPath),
        ));
      if (owned.length === 0) {
        throw unprocessable("Secret is not a plugin-owned session binding");
      }
      await db
        .delete(companySecretBindings)
        .where(and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "plugin"),
          eq(companySecretBindings.targetId, pluginId),
          eq(companySecretBindings.secretId, secretId),
          eq(companySecretBindings.configPath, configPath),
        ));
      const secret = await db
        .select({ id: companySecrets.id, companyId: companySecrets.companyId })
        .from(companySecrets)
        .where(eq(companySecrets.id, secretId))
        .then((rows) => rows[0] ?? null);
      if (!secret || secret.companyId !== companyId) return;
      const remaining = await db
        .select({ id: companySecretBindings.id })
        .from(companySecretBindings)
        .where(eq(companySecretBindings.secretId, secretId));
      if (remaining.length === 0) {
        await secretService(db).remove(secretId);
      }
    },
  };
}
