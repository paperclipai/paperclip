import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companySecrets, companySecretVersions } from "@paperclipai/db";
import type { AgentEnvConfig, EnvBinding, SecretProvider } from "@paperclipai/shared";
import { envBindingSchema } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { getSecretProvider, listSecretProviders } from "../secrets/provider-registry.js";
import { rekeyLocalEncryptedMaterial } from "../secrets/local-encrypted-provider.js";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const REDACTED_SENTINEL = "***REDACTED***";

type CanonicalEnvBinding =
  | { type: "plain"; value: string }
  | { type: "secret_ref"; secretId: string; version: number | "latest" };

export type LocalEncryptedMasterKeyRekeyResult = {
  dryRun: boolean;
  provider: "local_encrypted";
  companyCount: number;
  secretCount: number;
  versionCount: number;
  companies: Array<{
    companyId: string;
    secretCount: number;
    versionCount: number;
  }>;
};

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

    const normalized: AgentEnvConfig = {};
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

  async function normalizeAdapterConfigForPersistenceInternal(
    companyId: string,
    adapterConfig: Record<string, unknown>,
    opts?: { strictMode?: boolean },
  ) {
    const normalized = { ...adapterConfig };
    if (!Object.prototype.hasOwnProperty.call(adapterConfig, "env")) {
      return normalized;
    }
    normalized.env = await normalizeEnvConfig(companyId, adapterConfig.env, opts);
    return normalized;
  }

  async function loadLocalEncryptedVersionRows(companyId?: string) {
    const conditions = [eq(companySecrets.provider, "local_encrypted")];
    if (companyId) conditions.push(eq(companySecrets.companyId, companyId));

    return db
      .select({
        versionId: companySecretVersions.id,
        secretId: companySecretVersions.secretId,
        companyId: companySecrets.companyId,
        material: companySecretVersions.material,
      })
      .from(companySecretVersions)
      .innerJoin(companySecrets, eq(companySecretVersions.secretId, companySecrets.id))
      .where(and(...conditions));
  }

  function summarizeLocalEncryptedRows(
    rows: Awaited<ReturnType<typeof loadLocalEncryptedVersionRows>>,
    dryRun: boolean,
  ): LocalEncryptedMasterKeyRekeyResult {
    const companySecretIds = new Map<string, Set<string>>();
    const companyVersionCounts = new Map<string, number>();
    const secretIds = new Set<string>();

    for (const row of rows) {
      secretIds.add(row.secretId);
      const currentSecretIds = companySecretIds.get(row.companyId) ?? new Set<string>();
      currentSecretIds.add(row.secretId);
      companySecretIds.set(row.companyId, currentSecretIds);
      companyVersionCounts.set(row.companyId, (companyVersionCounts.get(row.companyId) ?? 0) + 1);
    }

    const companies = Array.from(companySecretIds.entries())
      .map(([rowCompanyId, rowSecretIds]) => ({
        companyId: rowCompanyId,
        secretCount: rowSecretIds.size,
        versionCount: companyVersionCounts.get(rowCompanyId) ?? 0,
      }))
      .sort((left, right) => left.companyId.localeCompare(right.companyId));

    return {
      dryRun,
      provider: "local_encrypted",
      companyCount: companies.length,
      secretCount: secretIds.size,
      versionCount: rows.length,
      companies,
    };
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

    rekeyLocalEncryptedMasterKey: async (input: {
      oldMasterKey: Buffer;
      newMasterKey: Buffer;
      dryRun?: boolean;
      companyId?: string;
      actorId?: string;
    }): Promise<LocalEncryptedMasterKeyRekeyResult> => {
      if (input.oldMasterKey.equals(input.newMasterKey)) {
        throw unprocessable("Old and new local secrets master keys must differ");
      }

      const dryRun = input.dryRun ?? true;
      const rows = await loadLocalEncryptedVersionRows(input.companyId);
      const summary = summarizeLocalEncryptedRows(rows, dryRun);
      const rekeyedRows = rows.map((row) => {
        try {
          return {
            ...row,
            material: rekeyLocalEncryptedMaterial(
              row.material,
              input.oldMasterKey,
              input.newMasterKey,
            ),
          };
        } catch {
          throw unprocessable(
            `Could not decrypt local_encrypted secret version ${row.versionId} with the old master key`,
          );
        }
      });

      if (dryRun || rekeyedRows.length === 0) {
        return summary;
      }

      await db.transaction(async (tx) => {
        for (const row of rekeyedRows) {
          await tx
            .update(companySecretVersions)
            .set({ material: row.material })
            .where(eq(companySecretVersions.id, row.versionId));
        }

        for (const companySummary of summary.companies) {
          await tx.insert(activityLog).values({
            companyId: companySummary.companyId,
            actorType: "system",
            actorId: input.actorId ?? "paperclipai-cli",
            action: "secret.local_master_key_rekeyed",
            entityType: "local_encrypted_master_key",
            entityId: companySummary.companyId,
            details: {
              provider: "local_encrypted",
              secretCount: companySummary.secretCount,
              versionCount: companySummary.versionCount,
            },
          });
        }
      });

      return summary;
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

    resolveAdapterConfigForRuntime: async (companyId: string, adapterConfig: Record<string, unknown>): Promise<{ config: Record<string, unknown>; secretKeys: Set<string> }> => {
      const resolved = { ...adapterConfig };
      const secretKeys = new Set<string>();
      if (!Object.prototype.hasOwnProperty.call(adapterConfig, "env")) {
        return { config: resolved, secretKeys };
      }
      const record = asRecord(adapterConfig.env);
      if (!record) {
        resolved.env = {};
        return { config: resolved, secretKeys };
      }
      const env: Record<string, string> = {};
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
          env[key] = binding.value;
        } else {
          env[key] = await resolveSecretValue(companyId, binding.secretId, binding.version);
          secretKeys.add(key);
        }
      }
      resolved.env = env;
      return { config: resolved, secretKeys };
    },
  };
}
