import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyProviderCredentials,
  companySecrets,
} from "@paperclipai/db";
import type {
  ProviderCredentialProviderGroup,
  ProviderCredentialSummary,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUniqueViolation(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return String(error.code ?? "") === "23505";
}

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeEnvKey(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeLabel(value: string): string {
  return value.trim();
}

function sanitizeSegment(value: string): string {
  const collapsed = value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return collapsed || "KEY";
}

function summarizeConstraint(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const detail = typeof error.detail === "string" ? error.detail : null;
  if (detail) return detail;
  const constraint = typeof error.constraint_name === "string"
    ? error.constraint_name
    : typeof error.constraint === "string"
      ? error.constraint
      : null;
  return constraint ? `Constraint violation: ${constraint}` : null;
}

function mapJoinedCredentialRow(row: {
  id: string;
  companyId: string;
  provider: string;
  envKey: string;
  label: string;
  secretId: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  secretName: string;
  secretLatestVersion: number;
  secretUpdatedAt: Date;
}): ProviderCredentialSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    provider: row.provider,
    envKey: row.envKey,
    label: row.label,
    secretId: row.secretId,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    secretName: row.secretName,
    secretLatestVersion: row.secretLatestVersion,
    secretUpdatedAt: row.secretUpdatedAt,
  };
}

export function providerCredentialService(db: Db) {
  const secrets = secretService(db);

  async function generateSecretName(companyId: string, envKey: string, provider: string, label: string): Promise<string> {
    const base = `${sanitizeSegment(envKey)}__${sanitizeSegment(provider)}__${sanitizeSegment(label)}`;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const suffix = attempt === 0 ? "" : `_${randomUUID().slice(0, 8).toUpperCase()}`;
      const candidate = `${base}${suffix}`;
      const existing = await secrets.getByName(companyId, candidate);
      if (!existing) return candidate;
    }
    return `${base}_${randomUUID().slice(0, 8).toUpperCase()}`;
  }

  async function list(companyId: string): Promise<ProviderCredentialSummary[]> {
    const rows = await db
      .select({
        id: companyProviderCredentials.id,
        companyId: companyProviderCredentials.companyId,
        provider: companyProviderCredentials.provider,
        envKey: companyProviderCredentials.envKey,
        label: companyProviderCredentials.label,
        secretId: companyProviderCredentials.secretId,
        isDefault: companyProviderCredentials.isDefault,
        createdAt: companyProviderCredentials.createdAt,
        updatedAt: companyProviderCredentials.updatedAt,
        secretName: companySecrets.name,
        secretLatestVersion: companySecrets.latestVersion,
        secretUpdatedAt: companySecrets.updatedAt,
      })
      .from(companyProviderCredentials)
      .innerJoin(companySecrets, eq(companySecrets.id, companyProviderCredentials.secretId))
      .where(eq(companyProviderCredentials.companyId, companyId))
      .orderBy(
        asc(companyProviderCredentials.provider),
        desc(companyProviderCredentials.isDefault),
        asc(companyProviderCredentials.label),
        desc(companyProviderCredentials.updatedAt),
      );

    return rows.map((row) => mapJoinedCredentialRow(row));
  }

  async function listByProvider(companyId: string): Promise<ProviderCredentialProviderGroup[]> {
    const credentials = await list(companyId);
    const grouped = new Map<string, ProviderCredentialProviderGroup>();

    for (const credential of credentials) {
      const key = credential.provider;
      const bucket = grouped.get(key) ?? {
        provider: key,
        credentials: [],
        defaultCredentialId: null,
      };
      bucket.credentials.push(credential);
      if (credential.isDefault && bucket.defaultCredentialId === null) {
        bucket.defaultCredentialId = credential.id;
      }
      grouped.set(key, bucket);
    }

    return Array.from(grouped.values()).sort((left, right) =>
      String(left.provider).localeCompare(String(right.provider)),
    );
  }

  async function getById(id: string): Promise<ProviderCredentialSummary | null> {
    const rows = await db
      .select({
        id: companyProviderCredentials.id,
        companyId: companyProviderCredentials.companyId,
        provider: companyProviderCredentials.provider,
        envKey: companyProviderCredentials.envKey,
        label: companyProviderCredentials.label,
        secretId: companyProviderCredentials.secretId,
        isDefault: companyProviderCredentials.isDefault,
        createdAt: companyProviderCredentials.createdAt,
        updatedAt: companyProviderCredentials.updatedAt,
        secretName: companySecrets.name,
        secretLatestVersion: companySecrets.latestVersion,
        secretUpdatedAt: companySecrets.updatedAt,
      })
      .from(companyProviderCredentials)
      .innerJoin(companySecrets, eq(companySecrets.id, companyProviderCredentials.secretId))
      .where(eq(companyProviderCredentials.id, id));

    const row = rows[0];
    return row ? mapJoinedCredentialRow(row) : null;
  }

  async function getByProviderLabel(
    companyId: string,
    provider: string,
    label: string,
  ): Promise<ProviderCredentialSummary | null> {
    const normalizedProvider = normalizeProviderId(provider);
    const normalizedLabel = normalizeLabel(label);

    const rows = await db
      .select({
        id: companyProviderCredentials.id,
        companyId: companyProviderCredentials.companyId,
        provider: companyProviderCredentials.provider,
        envKey: companyProviderCredentials.envKey,
        label: companyProviderCredentials.label,
        secretId: companyProviderCredentials.secretId,
        isDefault: companyProviderCredentials.isDefault,
        createdAt: companyProviderCredentials.createdAt,
        updatedAt: companyProviderCredentials.updatedAt,
        secretName: companySecrets.name,
        secretLatestVersion: companySecrets.latestVersion,
        secretUpdatedAt: companySecrets.updatedAt,
      })
      .from(companyProviderCredentials)
      .innerJoin(companySecrets, eq(companySecrets.id, companyProviderCredentials.secretId))
      .where(
        and(
          eq(companyProviderCredentials.companyId, companyId),
          eq(companyProviderCredentials.provider, normalizedProvider),
          eq(companyProviderCredentials.label, normalizedLabel),
        ),
      )
      .orderBy(desc(companyProviderCredentials.updatedAt));

    const row = rows[0];
    return row ? mapJoinedCredentialRow(row) : null;
  }

  async function ensureCredentialInCompany(companyId: string, id: string) {
    const credential = await getById(id);
    if (!credential) throw notFound("Provider credential not found");
    if (credential.companyId !== companyId) {
      throw unprocessable("Provider credential must belong to same company");
    }
    return credential;
  }

  async function setDefault(companyId: string, credentialId: string): Promise<ProviderCredentialSummary> {
    const existing = await ensureCredentialInCompany(companyId, credentialId);
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(companyProviderCredentials)
        .set({ isDefault: false, updatedAt: now })
        .where(
          and(
            eq(companyProviderCredentials.companyId, companyId),
            eq(companyProviderCredentials.provider, existing.provider),
            eq(companyProviderCredentials.isDefault, true),
          ),
        );

      await tx
        .update(companyProviderCredentials)
        .set({ isDefault: true, updatedAt: now })
        .where(eq(companyProviderCredentials.id, existing.id));
    });

    return (await getById(existing.id)) as ProviderCredentialSummary;
  }

  async function create(
    companyId: string,
    input: {
      provider: string;
      envKey: string;
      label: string;
      apiKey: string;
      isDefault?: boolean;
      preferredSecretName?: string | null;
      description?: string | null;
    },
    actor?: { userId?: string | null; agentId?: string | null },
  ): Promise<ProviderCredentialSummary> {
    const provider = normalizeProviderId(input.provider);
    const envKey = normalizeEnvKey(input.envKey);
    const label = normalizeLabel(input.label);
    if (!provider) throw unprocessable("provider is required");
    if (!envKey) throw unprocessable("envKey is required");
    if (!label) throw unprocessable("label is required");
    const existingLabel = await getByProviderLabel(companyId, provider, label);
    if (existingLabel) {
      throw conflict(
        `Provider credential already exists for provider '${provider}' and label '${label}'`,
      );
    }

    const preferred = input.preferredSecretName?.trim() ?? "";
    const secretName = preferred.length > 0
      ? preferred
      : await generateSecretName(companyId, envKey, provider, label);

    const createdSecret = await secrets.create(
      companyId,
      {
        name: secretName,
        provider: "local_encrypted",
        value: input.apiKey,
        description: input.description ?? `${provider} credential (${label})`,
      },
      actor,
    );

    let createdId: string;
    try {
      const row = await db
        .insert(companyProviderCredentials)
        .values({
          companyId,
          provider,
          envKey,
          label,
          secretId: createdSecret.id,
          isDefault: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]);

      createdId = row.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          summarizeConstraint(error) ??
            `Provider credential already exists for provider '${provider}' and label '${label}'`,
        );
      }
      throw error;
    }

    const shouldSetDefault = input.isDefault === true;
    if (shouldSetDefault) {
      return setDefault(companyId, createdId);
    }

    return (await getById(createdId)) as ProviderCredentialSummary;
  }

  async function ensureForSecret(
    companyId: string,
    input: {
      provider: string;
      envKey: string;
      label: string;
      secretId: string;
      isDefault?: boolean;
    },
  ): Promise<ProviderCredentialSummary> {
    const provider = normalizeProviderId(input.provider);
    const envKey = normalizeEnvKey(input.envKey);
    const label = normalizeLabel(input.label);
    const secret = await secrets.getById(input.secretId);
    if (!secret || secret.companyId !== companyId) {
      throw unprocessable("Secret must belong to same company");
    }

    const existing = await db
      .select({ id: companyProviderCredentials.id })
      .from(companyProviderCredentials)
      .where(
        and(
          eq(companyProviderCredentials.companyId, companyId),
          eq(companyProviderCredentials.provider, provider),
          eq(companyProviderCredentials.secretId, input.secretId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    const now = new Date();
    const credentialId = existing
      ? await db
          .update(companyProviderCredentials)
          .set({ envKey, label, updatedAt: now })
          .where(eq(companyProviderCredentials.id, existing.id))
          .returning({ id: companyProviderCredentials.id })
          .then((rows) => rows[0]?.id ?? existing.id)
      : await db
          .insert(companyProviderCredentials)
          .values({
            companyId,
            provider,
            envKey,
            label,
            secretId: input.secretId,
            isDefault: false,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: companyProviderCredentials.id })
          .then((rows) => rows[0]!.id);

    if (input.isDefault === true) {
      return setDefault(companyId, credentialId);
    }

    return (await getById(credentialId)) as ProviderCredentialSummary;
  }

  async function rotate(
    companyId: string,
    credentialId: string,
    apiKey: string,
    actor?: { userId?: string | null; agentId?: string | null },
  ): Promise<ProviderCredentialSummary> {
    const credential = await ensureCredentialInCompany(companyId, credentialId);
    await secrets.rotate(credential.secretId, { value: apiKey }, actor);
    await db
      .update(companyProviderCredentials)
      .set({ updatedAt: new Date() })
      .where(eq(companyProviderCredentials.id, credential.id));
    return (await getById(credential.id)) as ProviderCredentialSummary;
  }

  async function update(
    companyId: string,
    credentialId: string,
    patch: { label?: string; isDefault?: boolean },
  ): Promise<ProviderCredentialSummary> {
    const credential = await ensureCredentialInCompany(companyId, credentialId);
    const label = patch.label !== undefined ? normalizeLabel(patch.label) : credential.label;

    try {
      await db
        .update(companyProviderCredentials)
        .set({
          label,
          updatedAt: new Date(),
          ...(patch.isDefault === false ? { isDefault: false } : {}),
        })
        .where(eq(companyProviderCredentials.id, credential.id));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          summarizeConstraint(error) ??
            `Provider credential label already exists for provider '${credential.provider}'`,
        );
      }
      throw error;
    }

    if (patch.isDefault === true) {
      return setDefault(companyId, credential.id);
    }

    return (await getById(credential.id)) as ProviderCredentialSummary;
  }

  async function remove(companyId: string, credentialId: string): Promise<ProviderCredentialSummary> {
    const credential = await ensureCredentialInCompany(companyId, credentialId);
    await db.delete(companyProviderCredentials).where(eq(companyProviderCredentials.id, credential.id));
    return credential;
  }

  return {
    normalizeProviderId,
    normalizeEnvKey,
    list,
    listByProvider,
    getById,
    getByProviderLabel,
    ensureForSecret,
    create,
    rotate,
    update,
    setDefault,
    remove,
  };
}
