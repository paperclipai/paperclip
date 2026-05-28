import { randomUUID } from "node:crypto";
import { companies, companyAwaitingHumanSettings, type Db } from "@paperclipai/db";
import type {
  AwaitingHumanProvider,
  CompanyAwaitingHumanSettings,
  UpdateCompanyAwaitingHumanSettingsRequest,
} from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";
import {
  normalizeClickUpAwaitingHumanProviderConfig,
  validateClickUpAwaitingHumanProviderConfig,
} from "./clickup-awaiting-human-settings-adapter.js";

interface StoredClickUpProviderConfig {
  authTokenRef: { type: "secret_ref"; secretId: string; version?: number | "latest" } | null;
  workspaceId: string | null;
  channelId: string | null;
}

type StoredAwaitingHumanSettingsRow = {
  companyId: string;
  enabled: boolean;
  provider: AwaitingHumanProvider | null;
  providerConfigJson: StoredClickUpProviderConfig | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

function defaultStoredSettings(companyId: string) {
  return {
    companyId,
    enabled: false,
    provider: null,
    providerConfigJson: null,
    createdAt: null,
    updatedAt: null,
  };
}

function toPublicSettings(row: StoredAwaitingHumanSettingsRow): CompanyAwaitingHumanSettings {
  return {
    companyId: row.companyId,
    enabled: row.enabled,
    provider: row.provider,
    providerConfig: row.provider === "clickup"
      ? {
        workspaceId: row.providerConfigJson?.workspaceId ?? null,
        channelId: row.providerConfigJson?.channelId ?? null,
      }
      : null,
    hasStoredAuthToken: row.provider === "clickup" && !!row.providerConfigJson?.authTokenRef?.secretId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function trimToken(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function awaitingHumanSettingsService(db: Db) {
  const secrets = secretService(db);

  async function getStored(companyId: string) {
    const [row] = await db
      .select()
      .from(companyAwaitingHumanSettings)
      .where(eq(companyAwaitingHumanSettings.companyId, companyId))
      .limit(1);
    return row ?? null;
  }

  async function get(companyId: string): Promise<CompanyAwaitingHumanSettings> {
    const row = await getStored(companyId);
    return toPublicSettings(row ?? defaultStoredSettings(companyId));
  }

  async function resolveClickUpRuntimeConfig(companyId: string) {
    const row = await getStored(companyId);
    const effective = row ?? defaultStoredSettings(companyId);
    if (!effective.enabled || effective.provider !== "clickup") {
      throw new Error("awaiting-human-bridge-disabled");
    }
    const config = normalizeClickUpAwaitingHumanProviderConfig(effective.providerConfigJson ?? null);
    const personalToken = effective.providerConfigJson?.authTokenRef
      ? await secrets.resolveSecretValue(
        companyId,
        effective.providerConfigJson.authTokenRef.secretId,
        effective.providerConfigJson.authTokenRef.version ?? "latest",
      )
      : null;
    return {
      enabled: effective.enabled,
      provider: effective.provider,
      personalToken,
      workspaceId: config?.workspaceId ?? null,
      channelId: config?.channelId ?? null,
    };
  }

  async function resolveProvider(companyId: string): Promise<AwaitingHumanProvider> {
    const row = await getStored(companyId);
    const effective = row ?? defaultStoredSettings(companyId);
    if (!effective.enabled || !effective.provider) {
      throw new Error("awaiting-human-bridge-disabled");
    }
    return effective.provider;
  }

  async function update(
    companyId: string,
    patch: UpdateCompanyAwaitingHumanSettingsRequest,
    actor?: { userId?: string | null; agentId?: string | null },
  ): Promise<CompanyAwaitingHumanSettings> {
    await db.transaction(async (tx) => {
      const txSecrets = secretService(tx);
      await tx.execute(sql`
        SELECT ${companies.id}
        FROM ${companies}
        WHERE ${eq(companies.id, companyId)}
        FOR UPDATE
      `);

      const [existing] = await tx
        .select()
        .from(companyAwaitingHumanSettings)
        .where(eq(companyAwaitingHumanSettings.companyId, companyId))
        .limit(1);
      const baseline = existing ?? defaultStoredSettings(companyId);
      const previousClickUpSecretId = baseline.provider === "clickup"
        ? baseline.providerConfigJson?.authTokenRef?.secretId ?? null
        : null;

      const nextProvider = patch.provider !== undefined ? patch.provider : baseline.provider;
      const nextEnabled = patch.enabled !== undefined ? patch.enabled : baseline.enabled;

      let nextProviderConfig: StoredClickUpProviderConfig | null =
        baseline.provider === "clickup" ? (baseline.providerConfigJson ?? defaultStoredSettings(companyId).providerConfigJson) : null;

      if (patch.provider !== undefined && patch.provider !== baseline.provider && patch.providerConfig === undefined) {
        nextProviderConfig = null;
      }

      if (patch.providerConfig !== undefined) {
        if (nextProvider !== "clickup" && patch.providerConfig !== null) {
          throw unprocessable("Provider config can only be set when ClickUp is selected");
        }
        const normalizedConfig = normalizeClickUpAwaitingHumanProviderConfig(patch.providerConfig);
        nextProviderConfig = nextProvider === "clickup"
          ? {
            authTokenRef: nextProviderConfig?.authTokenRef ?? null,
            workspaceId: normalizedConfig?.workspaceId ?? null,
            channelId: normalizedConfig?.channelId ?? null,
          }
          : null;
      }

      if (nextEnabled && !nextProvider) {
        throw unprocessable("Cannot enable the awaiting-human bridge without selecting a provider");
      }

      if (nextProvider === "clickup") {
        validateClickUpAwaitingHumanProviderConfig({
          enabled: nextEnabled,
          providerConfig: nextProviderConfig
            ? { workspaceId: nextProviderConfig.workspaceId, channelId: nextProviderConfig.channelId }
            : null,
        });
      }

      const nextToken = trimToken(patch.clickupPersonalToken);
      if (nextProvider === "clickup" && nextToken) {
        if (nextProviderConfig?.authTokenRef?.secretId) {
          await txSecrets.rotate(nextProviderConfig.authTokenRef.secretId, { value: nextToken }, actor);
        } else {
          const created = await txSecrets.create(
            companyId,
            {
              name: `awaiting-human-clickup-token-${randomUUID().slice(0, 8)}`,
              provider: "local_encrypted",
              value: nextToken,
              description: "ClickUp personal token for Awaiting Human bridge",
            },
            actor,
          );
          nextProviderConfig = {
            authTokenRef: { type: "secret_ref", secretId: created.id, version: "latest" },
            workspaceId: nextProviderConfig?.workspaceId ?? null,
            channelId: nextProviderConfig?.channelId ?? null,
          };
        }
      }

      if (nextProvider === "clickup" && nextEnabled && !nextProviderConfig?.authTokenRef?.secretId) {
        throw unprocessable("A ClickUp personal token is required when enabling the ClickUp bridge");
      }

      const values = {
        enabled: nextEnabled,
        provider: nextProvider,
        providerConfigJson: nextProvider === "clickup" ? nextProviderConfig : null,
        updatedAt: new Date(),
      };

      if (existing) {
        await tx
          .update(companyAwaitingHumanSettings)
          .set(values)
          .where(and(
            eq(companyAwaitingHumanSettings.id, existing.id),
            eq(companyAwaitingHumanSettings.companyId, companyId),
          ));
      } else {
        await tx.insert(companyAwaitingHumanSettings).values({
          companyId,
          ...values,
        }).onConflictDoUpdate({
          target: companyAwaitingHumanSettings.companyId,
          set: values,
        });
      }

      if (previousClickUpSecretId && nextProvider !== "clickup") {
        await txSecrets.remove(previousClickUpSecretId);
      }
    });

    return get(companyId);
  }
  return {
    get,
    update,
    resolveProvider,
    resolveClickUpRuntimeConfig,
    getStored,
  };
}
