import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, companySecretVersions } from "@paperclipai/db";
import type { AgentEnvConfig, EnvBinding, SecretProvider } from "@paperclipai/shared";
import { envBindingSchema } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { getSecretProvider, listSecretProviders } from "../secrets/provider-registry.js";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// RFC 7230 token: HTTP header field names are tokens, which permit hyphens and
// other punctuation that ENV_KEY_RE rejects (e.g. `X-API-Key`, `Content-Type`,
// `MCP-Session-Id`). Keep this distinct from ENV_KEY_RE so headers and env
// variables get the right validation.
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const REDACTED_SENTINEL = "***REDACTED***";

type BindingKeyKind = "env" | "header";

function bindingKeyRegex(kind: BindingKeyKind) {
  return kind === "header" ? HEADER_NAME_RE : ENV_KEY_RE;
}

function bindingKeyErrorLabel(kind: BindingKeyKind) {
  return kind === "header" ? "header name" : "environment variable name";
}

type CanonicalEnvBinding =
  | { type: "plain"; value: string }
  | { type: "secret_ref"; secretId: string; version: number | "latest" };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isSensitiveEnvKey(key: string) {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

function canonicalizeBinding(binding: EnvBinding): CanonicalEnvBinding {
  if (typeof binding === "string") {
    return { type: "plain", value: binding };
  }
  if (binding.type === "plain") {
    return { type: "plain", value: String(binding.value) };
  }
  return {
    type: "secret_ref",
    secretId: binding.secretId,
    version: binding.version ?? "latest",
  };
}

export function secretService(db: Db) {
  type NormalizeEnvOptions = {
    strictMode?: boolean;
    fieldPath?: string;
    keyKind?: BindingKeyKind;
  };

  async function getById(id: string) {
    return db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getByName(companyId: string, name: string) {
    return db
      .select()
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.name, name)))
      .then((rows) => rows[0] ?? null);
  }

  async function getSecretVersion(secretId: string, version: number) {
    return db
      .select()
      .from(companySecretVersions)
      .where(
        and(
          eq(companySecretVersions.secretId, secretId),
          eq(companySecretVersions.version, version),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function assertSecretInCompany(companyId: string, secretId: string) {
    const secret = await getById(secretId);
    if (!secret) throw notFound("Secret not found");
    if (secret.companyId !== companyId) throw unprocessable("Secret must belong to same company");
    return secret;
  }

  async function resolveSecretValue(
    companyId: string,
    secretId: string,
    version: number | "latest",
  ): Promise<string> {
    const secret = await assertSecretInCompany(companyId, secretId);
    const resolvedVersion = version === "latest" ? secret.latestVersion : version;
    const versionRow = await getSecretVersion(secret.id, resolvedVersion);
    if (!versionRow) throw notFound("Secret version not found");
    const provider = getSecretProvider(secret.provider as SecretProvider);
    return provider.resolveVersion({
      material: versionRow.material as Record<string, unknown>,
      externalRef: secret.externalRef,
    });
  }

  async function normalizeEnvConfig(
    companyId: string,
    envValue: unknown,
    opts?: NormalizeEnvOptions,
  ): Promise<AgentEnvConfig> {
    const record = asRecord(envValue);
    if (!record) throw unprocessable(`${opts?.fieldPath ?? "env"} must be an object`);

    const keyKind: BindingKeyKind = opts?.keyKind ?? "env";
    const keyRegex = bindingKeyRegex(keyKind);
    const keyLabel = bindingKeyErrorLabel(keyKind);

    const normalized: AgentEnvConfig = {};
    for (const [key, rawBinding] of Object.entries(record)) {
      if (!keyRegex.test(key)) {
        throw unprocessable(`Invalid ${keyLabel}: ${key}`);
      }

      const parsed = envBindingSchema.safeParse(rawBinding);
      if (!parsed.success) {
        throw unprocessable(`Invalid environment binding for key: ${key}`);
      }

      const binding = canonicalizeBinding(parsed.data as EnvBinding);
      if (binding.type === "plain") {
        if (opts?.strictMode && isSensitiveEnvKey(key) && binding.value.trim().length > 0) {
          throw unprocessable(
            `Strict secret mode requires secret references for sensitive key: ${key}`,
          );
        }
        if (binding.value === REDACTED_SENTINEL) {
          throw unprocessable(`Refusing to persist redacted placeholder for key: ${key}`);
        }
        normalized[key] = binding;
        continue;
      }

      await assertSecretInCompany(companyId, binding.secretId);
      normalized[key] = {
        type: "secret_ref",
        secretId: binding.secretId,
        version: binding.version,
      };
    }
    return normalized;
  }

  async function normalizeMcpServersForPersistence(
    companyId: string,
    mcpServersValue: unknown,
    opts?: { strictMode?: boolean },
  ): Promise<Record<string, Record<string, unknown>>> {
    const servers = asRecord(mcpServersValue);
    if (!servers) throw unprocessable("mcpServers must be an object");

    const normalized: Record<string, Record<string, unknown>> = {};
    for (const [serverName, rawServer] of Object.entries(servers)) {
      const server = asRecord(rawServer);
      if (!server) throw unprocessable(`mcpServers.${serverName} must be an object`);
      const next: Record<string, unknown> = { ...server };
      if (Object.prototype.hasOwnProperty.call(server, "env")) {
        next.env = await normalizeEnvConfig(companyId, server.env, {
          ...opts,
          fieldPath: `mcpServers.${serverName}.env`,
          keyKind: "env",
        });
      }
      if (Object.prototype.hasOwnProperty.call(server, "headers")) {
        next.headers = await normalizeEnvConfig(companyId, server.headers, {
          ...opts,
          fieldPath: `mcpServers.${serverName}.headers`,
          keyKind: "header",
        });
      }
      normalized[serverName] = next;
    }
    return normalized;
  }

  async function normalizeAdapterConfigForPersistenceInternal(
    companyId: string,
    adapterConfig: Record<string, unknown>,
    opts?: { strictMode?: boolean },
  ) {
    const normalized = { ...adapterConfig };
    if (Object.prototype.hasOwnProperty.call(adapterConfig, "env")) {
      normalized.env = await normalizeEnvConfig(companyId, adapterConfig.env, opts);
    }
    if (Object.prototype.hasOwnProperty.call(adapterConfig, "mcpServers")) {
      normalized.mcpServers = await normalizeMcpServersForPersistence(
        companyId,
        adapterConfig.mcpServers,
        opts,
      );
    }
    return normalized;
  }

  async function resolveBindingMap(
    companyId: string,
    record: Record<string, unknown>,
    secretKeys: Set<string>,
    keyKind: BindingKeyKind = "env",
  ): Promise<Record<string, string>> {
    const keyRegex = bindingKeyRegex(keyKind);
    const keyLabel = bindingKeyErrorLabel(keyKind);
    const resolved: Record<string, string> = {};
    for (const [key, rawBinding] of Object.entries(record)) {
      if (!keyRegex.test(key)) {
        throw unprocessable(`Invalid ${keyLabel}: ${key}`);
      }
      const parsed = envBindingSchema.safeParse(rawBinding);
      if (!parsed.success) {
        throw unprocessable(`Invalid environment binding for key: ${key}`);
      }
      const binding = canonicalizeBinding(parsed.data as EnvBinding);
      if (binding.type === "plain") {
        resolved[key] = binding.value;
      } else {
        resolved[key] = await resolveSecretValue(companyId, binding.secretId, binding.version);
        secretKeys.add(key);
      }
    }
    return resolved;
  }

  async function resolveMcpServersForRuntime(
    companyId: string,
    mcpServersValue: unknown,
    envSecretKeys: Set<string>,
    headerSecretKeys: Set<string>,
  ): Promise<Record<string, Record<string, unknown>>> {
    const servers = asRecord(mcpServersValue);
    if (!servers) return {};

    const resolved: Record<string, Record<string, unknown>> = {};
    for (const [serverName, rawServer] of Object.entries(servers)) {
      const server = asRecord(rawServer) ?? {};
      const next: Record<string, unknown> = { ...server };
      const envMap = asRecord(server.env);
      if (envMap) {
        next.env = await resolveBindingMap(companyId, envMap, envSecretKeys, "env");
      }
      const headersMap = asRecord(server.headers);
      if (headersMap) {
        next.headers = await resolveBindingMap(companyId, headersMap, headerSecretKeys, "header");
      }
      resolved[serverName] = next;
    }
    return resolved;
  }

  return {
    listProviders: () => listSecretProviders(),

    list: (companyId: string) =>
      db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.companyId, companyId))
        .orderBy(desc(companySecrets.createdAt)),

    getById,
    getByName,
    resolveSecretValue,

    create: async (
      companyId: string,
      input: {
        name: string;
        provider: SecretProvider;
        value: string;
        description?: string | null;
        externalRef?: string | null;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const existing = await getByName(companyId, input.name);
      if (existing) throw conflict(`Secret already exists: ${input.name}`);

      const provider = getSecretProvider(input.provider);
      const prepared = await provider.createVersion({
        value: input.value,
        externalRef: input.externalRef ?? null,
      });

      return db.transaction(async (tx) => {
        const secret = await tx
          .insert(companySecrets)
          .values({
            companyId,
            name: input.name,
            provider: input.provider,
            externalRef: prepared.externalRef,
            latestVersion: 1,
            description: input.description ?? null,
            createdByAgentId: actor?.agentId ?? null,
            createdByUserId: actor?.userId ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx.insert(companySecretVersions).values({
          secretId: secret.id,
          version: 1,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });

        return secret;
      });
    },

    rotate: async (
      secretId: string,
      input: { value: string; externalRef?: string | null },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");
      const provider = getSecretProvider(secret.provider as SecretProvider);
      const nextVersion = secret.latestVersion + 1;
      const prepared = await provider.createVersion({
        value: input.value,
        externalRef: input.externalRef ?? secret.externalRef ?? null,
      });

      return db.transaction(async (tx) => {
        await tx.insert(companySecretVersions).values({
          secretId: secret.id,
          version: nextVersion,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });

        const updated = await tx
          .update(companySecrets)
          .set({
            latestVersion: nextVersion,
            externalRef: prepared.externalRef,
            updatedAt: new Date(),
          })
          .where(eq(companySecrets.id, secret.id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (!updated) throw notFound("Secret not found");
        return updated;
      });
    },

    update: async (
      secretId: string,
      patch: { name?: string; description?: string | null; externalRef?: string | null },
    ) => {
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");

      if (patch.name && patch.name !== secret.name) {
        const duplicate = await getByName(secret.companyId, patch.name);
        if (duplicate && duplicate.id !== secret.id) {
          throw conflict(`Secret already exists: ${patch.name}`);
        }
      }

      return db
        .update(companySecrets)
        .set({
          name: patch.name ?? secret.name,
          description:
            patch.description === undefined ? secret.description : patch.description,
          externalRef:
            patch.externalRef === undefined ? secret.externalRef : patch.externalRef,
          updatedAt: new Date(),
        })
        .where(eq(companySecrets.id, secret.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: async (secretId: string) => {
      const secret = await getById(secretId);
      if (!secret) return null;
      await db.delete(companySecrets).where(eq(companySecrets.id, secretId));
      return secret;
    },

    normalizeAdapterConfigForPersistence: async (
      companyId: string,
      adapterConfig: Record<string, unknown>,
      opts?: { strictMode?: boolean },
    ) => normalizeAdapterConfigForPersistenceInternal(companyId, adapterConfig, opts),

    normalizeEnvBindingsForPersistence: async (
      companyId: string,
      envValue: unknown,
      opts?: NormalizeEnvOptions,
    ) => normalizeEnvConfig(companyId, envValue, opts),

    normalizeHireApprovalPayloadForPersistence: async (
      companyId: string,
      payload: Record<string, unknown>,
      opts?: { strictMode?: boolean },
    ) => {
      const normalized = { ...payload };
      const adapterConfig = asRecord(payload.adapterConfig);
      if (adapterConfig) {
        normalized.adapterConfig = await normalizeAdapterConfigForPersistenceInternal(
          companyId,
          adapterConfig,
          opts,
        );
      }
      return normalized;
    },

    resolveEnvBindings: async (companyId: string, envValue: unknown): Promise<{ env: Record<string, string>; secretKeys: Set<string> }> => {
      const record = asRecord(envValue);
      if (!record) return { env: {} as Record<string, string>, secretKeys: new Set<string>() };
      const resolved: Record<string, string> = {};
      const secretKeys = new Set<string>();

      for (const [key, rawBinding] of Object.entries(record)) {
        if (!ENV_KEY_RE.test(key)) {
          throw unprocessable(`Invalid environment variable name: ${key}`);
        }
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) {
          throw unprocessable(`Invalid environment binding for key: ${key}`);
        }
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type === "plain") {
          resolved[key] = binding.value;
        } else {
          resolved[key] = await resolveSecretValue(companyId, binding.secretId, binding.version);
          secretKeys.add(key);
        }
      }
      return { env: resolved, secretKeys };
    },

    resolveAdapterConfigForRuntime: async (companyId: string, adapterConfig: Record<string, unknown>): Promise<{ config: Record<string, unknown>; secretKeys: Set<string>; headerSecretKeys: Set<string> }> => {
      const resolved = { ...adapterConfig };
      const secretKeys = new Set<string>();
      const headerSecretKeys = new Set<string>();
      if (Object.prototype.hasOwnProperty.call(adapterConfig, "env")) {
        const record = asRecord(adapterConfig.env);
        resolved.env = record
          ? await resolveBindingMap(companyId, record, secretKeys, "env")
          : {};
      }
      if (Object.prototype.hasOwnProperty.call(adapterConfig, "mcpServers")) {
        resolved.mcpServers = await resolveMcpServersForRuntime(
          companyId,
          adapterConfig.mcpServers,
          secretKeys,
          headerSecretKeys,
        );
      }
      return { config: resolved, secretKeys, headerSecretKeys };
    },
  };
}
