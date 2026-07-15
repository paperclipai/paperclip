import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  toolConnections,
} from "@paperclipai/db";
import type { McpConnectionCredentialRef, SecretProvider, ToolCredentialSecretRef } from "@paperclipai/shared";
import { getSecretProvider } from "../secrets/provider-registry.js";
import type { SecretProviderVaultRuntimeConfig } from "../secrets/types.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

type OAuthTokenKind = "access_token" | "refresh_token";

type LegacyOAuthToken = {
  kind: OAuthTokenKind;
  value: string;
};

export type ToolOAuthLegacyBackfillResult = {
  scannedConnections: number;
  migratedConnections: number;
  sanitizedConnections: number;
  createdSecrets: number;
  rotatedSecrets: number;
  accessTokensBackfilled: number;
  refreshTokensBackfilled: number;
};

const RAW_OAUTH_TOKEN_KEYS = ["access_token", "refresh_token", "accessToken", "refreshToken"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function tokenValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function rawOauthObject(config: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(config)?.oauth);
}

function rawTokens(config: unknown): LegacyOAuthToken[] {
  const oauth = rawOauthObject(config);
  if (!oauth) return [];
  const accessToken = tokenValue(oauth.access_token) ?? tokenValue(oauth.accessToken);
  const refreshToken = tokenValue(oauth.refresh_token) ?? tokenValue(oauth.refreshToken);
  return [
    accessToken ? { kind: "access_token" as const, value: accessToken } : null,
    refreshToken ? { kind: "refresh_token" as const, value: refreshToken } : null,
  ].filter((token): token is LegacyOAuthToken => token !== null);
}

function hasRawOauthTokenKeys(config: unknown): boolean {
  const oauth = rawOauthObject(config);
  if (!oauth) return false;
  return RAW_OAUTH_TOKEN_KEYS.some((key) => Object.prototype.hasOwnProperty.call(oauth, key));
}

function stripRawOauthTokenKeys(config: unknown): Record<string, unknown> {
  const record = asRecord(config);
  if (!record) return {};
  const oauth = asRecord(record.oauth);
  if (!oauth) return { ...record };
  const nextOauth = { ...oauth };
  for (const key of RAW_OAUTH_TOKEN_KEYS) delete nextOauth[key];
  return {
    ...record,
    oauth: nextOauth,
  };
}

function uniqueLegacyTokens(connection: typeof toolConnections.$inferSelect): LegacyOAuthToken[] {
  const tokens = new Map<OAuthTokenKind, LegacyOAuthToken>();
  for (const token of [...rawTokens(connection.config), ...rawTokens(connection.transportConfig)]) {
    if (!tokens.has(token.kind)) tokens.set(token.kind, token);
  }
  return [...tokens.values()];
}

function secretNamespace(connectionId: string) {
  return `tool-connection/${connectionId}/oauth`;
}

function secretKey(connectionId: string, kind: OAuthTokenKind) {
  return `${secretNamespace(connectionId)}/${kind === "access_token" ? "access-token" : "refresh-token"}`;
}

function secretLabel(kind: OAuthTokenKind) {
  return kind === "access_token" ? "OAuth access token" : "OAuth refresh token";
}

function configPath(kind: OAuthTokenKind): "oauth.access_token" | "oauth.refresh_token" {
  return kind === "access_token" ? "oauth.access_token" : "oauth.refresh_token";
}

async function runtimeProviderConfigForExistingSecret(
  tx: DbTransaction,
  secret: typeof companySecrets.$inferSelect,
): Promise<SecretProviderVaultRuntimeConfig | null> {
  if (!secret.providerConfigId) return null;
  const providerConfig = await tx
    .select()
    .from(companySecretProviderConfigs)
    .where(eq(companySecretProviderConfigs.id, secret.providerConfigId))
    .then((rows) => rows[0] ?? null);
  if (!providerConfig) {
    throw new Error("Provider vault not found for existing OAuth token secret " + secret.id);
  }
  if (providerConfig.companyId !== secret.companyId || providerConfig.provider !== secret.provider) {
    throw new Error("Provider vault does not match existing OAuth token secret " + secret.id);
  }
  if (providerConfig.status === "disabled" || providerConfig.status === "coming_soon") {
    throw new Error("Provider vault is not selectable for existing OAuth token secret " + secret.id);
  }
  return {
    id: providerConfig.id,
    provider: providerConfig.provider as SecretProvider,
    status: providerConfig.status,
    config: providerConfig.config ?? {},
  };
}

function replaceCredentialSecretRefs(
  current: ToolCredentialSecretRef[],
  replacements: ToolCredentialSecretRef[],
) {
  const replacementPaths = new Set(replacements.map((ref) => ref.configPath));
  return [
    ...current.filter((ref) => !replacementPaths.has(ref.configPath)),
    ...replacements,
  ];
}

function replaceOAuthAccessCredentialRef(
  current: McpConnectionCredentialRef[],
  accessRef: ToolCredentialSecretRef | null,
) {
  if (!accessRef) return current;
  return [
    ...current.filter((ref) => ref.name !== "oauth.access_token"),
    {
      name: "oauth.access_token",
      secretId: accessRef.secretId,
      version: "latest" as const,
      placement: "header" as const,
      key: "Authorization",
      prefix: "Bearer ",
    },
  ];
}

async function upsertTokenSecret(
  tx: DbTransaction,
  connection: typeof toolConnections.$inferSelect,
  token: LegacyOAuthToken,
): Promise<{ ref: ToolCredentialSecretRef; created: boolean }> {
  const key = secretKey(connection.id, token.kind);
  const name = key;
  const existing = await tx
    .select()
    .from(companySecrets)
    .where(and(
      eq(companySecrets.companyId, connection.companyId),
      eq(companySecrets.key, key),
    ))
    .then((rows) => rows[0] ?? null);
  const nextVersion = existing ? existing.latestVersion + 1 : 1;
  const providerId = (existing?.provider ?? "local_encrypted") as SecretProvider;
  const provider = getSecretProvider(providerId);
  const providerConfig = existing ? await runtimeProviderConfigForExistingSecret(tx, existing) : null;
  const providerWriteContext = {
    companyId: connection.companyId,
    secretKey: key,
    secretName: existing?.name ?? name,
    version: nextVersion,
  };
  const prepared = existing ? await provider.createVersion({
    value: token.value,
    externalRef: existing.externalRef ?? null,
    providerConfig,
    context: providerWriteContext,
  }) : await provider.createSecret({
    value: token.value,
    externalRef: null,
    providerConfig: null,
    context: providerWriteContext,
  });

  const now = new Date();
  const secret = existing ?? await tx
    .insert(companySecrets)
    .values({
      companyId: connection.companyId,
      key,
      name,
      provider: "local_encrypted",
      providerConfigId: null,
      status: "active",
      managedMode: "paperclip_managed",
      externalRef: null,
      providerMetadata: { source: "tool_oauth_legacy_backfill", namespace: secretNamespace(connection.id) },
      latestVersion: 1,
      description: `Migrated ${secretLabel(token.kind).toLowerCase()} for tool connection ${connection.id}.`,
      createdByUserId: "migration",
      lastRotatedAt: now,
      updatedAt: now,
    })
    .returning()
    .then((rows) => rows[0]!);

  await tx.insert(companySecretVersions).values({
    secretId: secret.id,
    version: nextVersion,
    material: prepared.material,
    valueSha256: prepared.valueSha256,
    fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
    providerVersionRef: prepared.providerVersionRef ?? null,
    status: existing ? "disabled" : "current",
    createdByUserId: "migration",
  });

  if (existing) {
    await tx
      .update(companySecretVersions)
      .set({ status: "previous" })
      .where(and(
        eq(companySecretVersions.secretId, existing.id),
        ne(companySecretVersions.version, nextVersion),
      ));
    await tx
      .update(companySecretVersions)
      .set({ status: "current" })
      .where(and(
        eq(companySecretVersions.secretId, existing.id),
        eq(companySecretVersions.version, nextVersion),
      ));
    await tx
      .update(companySecrets)
      .set({
        status: "active",
        latestVersion: nextVersion,
        externalRef: prepared.externalRef ?? existing.externalRef,
        providerConfigId: existing.providerConfigId,
        lastRotatedAt: now,
        updatedAt: now,
      })
      .where(eq(companySecrets.id, existing.id));
  }

  const ref: ToolCredentialSecretRef = {
    secretId: secret.id,
    versionSelector: "latest",
    configPath: configPath(token.kind),
    required: token.kind === "access_token",
    label: secretLabel(token.kind),
  };
  await tx
    .insert(companySecretBindings)
    .values({
      companyId: connection.companyId,
      secretId: secret.id,
      targetType: "tool_connection",
      targetId: connection.id,
      configPath: ref.configPath,
      versionSelector: "latest",
      required: ref.required ?? true,
      label: ref.label ?? null,
    })
    .onConflictDoUpdate({
      target: [
        companySecretBindings.companyId,
        companySecretBindings.targetType,
        companySecretBindings.targetId,
        companySecretBindings.configPath,
      ],
      set: {
        secretId: secret.id,
        versionSelector: "latest",
        required: ref.required ?? true,
        label: ref.label ?? null,
        updatedAt: now,
      },
    });
  return { ref, created: !existing };
}

export async function backfillLegacyToolOAuthTokens(db: Db): Promise<ToolOAuthLegacyBackfillResult> {
  const result: ToolOAuthLegacyBackfillResult = {
    scannedConnections: 0,
    migratedConnections: 0,
    sanitizedConnections: 0,
    createdSecrets: 0,
    rotatedSecrets: 0,
    accessTokensBackfilled: 0,
    refreshTokensBackfilled: 0,
  };
  const rows = await db
    .select()
    .from(toolConnections)
    .where(sql`
      (
        jsonb_typeof(${toolConnections.config} -> 'oauth') = 'object'
        AND (
          (${toolConnections.config} -> 'oauth') ? 'access_token'
          OR (${toolConnections.config} -> 'oauth') ? 'refresh_token'
          OR (${toolConnections.config} -> 'oauth') ? 'accessToken'
          OR (${toolConnections.config} -> 'oauth') ? 'refreshToken'
        )
      )
      OR (
        jsonb_typeof(${toolConnections.transportConfig} -> 'oauth') = 'object'
        AND (
          (${toolConnections.transportConfig} -> 'oauth') ? 'access_token'
          OR (${toolConnections.transportConfig} -> 'oauth') ? 'refresh_token'
          OR (${toolConnections.transportConfig} -> 'oauth') ? 'accessToken'
          OR (${toolConnections.transportConfig} -> 'oauth') ? 'refreshToken'
        )
      )
    `);
  result.scannedConnections = rows.length;

  for (const connection of rows) {
    const tokens = uniqueLegacyTokens(connection);
    const shouldSanitize = hasRawOauthTokenKeys(connection.config) || hasRawOauthTokenKeys(connection.transportConfig);
    if (!shouldSanitize) continue;
    await db.transaction(async (tx) => {
      const refs: ToolCredentialSecretRef[] = [];
      let accessRef: ToolCredentialSecretRef | null = null;
      for (const token of tokens) {
        const persisted = await upsertTokenSecret(tx, connection, token);
        refs.push(persisted.ref);
        if (persisted.created) result.createdSecrets += 1;
        else result.rotatedSecrets += 1;
        if (token.kind === "access_token") {
          accessRef = persisted.ref;
          result.accessTokensBackfilled += 1;
        } else {
          result.refreshTokensBackfilled += 1;
        }
      }
      await tx
        .update(toolConnections)
        .set({
          config: stripRawOauthTokenKeys(connection.config),
          transportConfig: stripRawOauthTokenKeys(connection.transportConfig),
          credentialSecretRefs: replaceCredentialSecretRefs(connection.credentialSecretRefs, refs),
          credentialRefs: replaceOAuthAccessCredentialRef(connection.credentialRefs, accessRef),
          updatedAt: new Date(),
        })
        .where(eq(toolConnections.id, connection.id));
    });
    result.sanitizedConnections += 1;
    if (tokens.length > 0) result.migratedConnections += 1;
  }

  return result;
}
