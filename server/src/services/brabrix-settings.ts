import type { Db } from "@paperclipai/db";
import type { BrabrixAgentSyncSettings, BrabrixAgentSyncSettingsUpdateRequest } from "@paperclipai/shared";
import { getBrabrixConfig, resolveBrabrixConfig, type BrabrixConfig } from "../integrations/brabrix/brabrix-config.js";
import { secretService } from "./secrets.js";

const BRABRIX_SYNC_SETTINGS_TARGET_ID = "brabrix-agent-sync";
const BRABRIX_SYNC_AGENT_TOKEN_CONFIG_PATH = "brabrix.agentToken";
const BRABRIX_SYNC_PROJECT_ID_CONFIG_PATH = "brabrix.projectId";
const BRABRIX_SYNC_TENANT_ID_CONFIG_PATH = "brabrix.tenantId";

type BrabrixSyncSecretIds = {
  agentTokenSecretId: string | null;
  projectIdSecretId: string | null;
  tenantIdSecretId: string | null;
};

function asNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function brabrixSettingsService(db: Db) {
  const secrets = secretService(db);

  async function readSecretIds(companyId: string): Promise<BrabrixSyncSecretIds> {
    const bindings = await secrets.listBindings(companyId);
    const agentTokenBinding = bindings.find((entry) =>
      entry.targetType === "system"
      && entry.targetId === BRABRIX_SYNC_SETTINGS_TARGET_ID
      && entry.configPath === BRABRIX_SYNC_AGENT_TOKEN_CONFIG_PATH);
    const projectIdBinding = bindings.find((entry) =>
      entry.targetType === "system"
      && entry.targetId === BRABRIX_SYNC_SETTINGS_TARGET_ID
      && entry.configPath === BRABRIX_SYNC_PROJECT_ID_CONFIG_PATH);
    const tenantIdBinding = bindings.find((entry) =>
      entry.targetType === "system"
      && entry.targetId === BRABRIX_SYNC_SETTINGS_TARGET_ID
      && entry.configPath === BRABRIX_SYNC_TENANT_ID_CONFIG_PATH);

    return {
      agentTokenSecretId: agentTokenBinding?.secretId ?? null,
      projectIdSecretId: projectIdBinding?.secretId ?? null,
      tenantIdSecretId: tenantIdBinding?.secretId ?? null,
    };
  }

  async function resolveSecretValue(
    companyId: string,
    secretId: string | null,
    configPath: string,
  ): Promise<string | null> {
    if (!secretId) return null;
    const value = await secrets.resolveSecretValue(
      companyId,
      secretId,
      "latest",
      {
        consumerType: "system",
        consumerId: BRABRIX_SYNC_SETTINGS_TARGET_ID,
        actorType: "system",
        actorId: null,
        configPath,
      },
    );
    return asNonEmptyString(value);
  }

  async function resolveConfig(companyId: string): Promise<BrabrixConfig> {
    const baseConfig = getBrabrixConfig();
    const secretIds = await readSecretIds(companyId);
    const [agentTokenFromSecret, projectIdFromSecret, tenantIdFromSecret] = await Promise.all([
      resolveSecretValue(companyId, secretIds.agentTokenSecretId, BRABRIX_SYNC_AGENT_TOKEN_CONFIG_PATH),
      resolveSecretValue(companyId, secretIds.projectIdSecretId, BRABRIX_SYNC_PROJECT_ID_CONFIG_PATH),
      resolveSecretValue(companyId, secretIds.tenantIdSecretId, BRABRIX_SYNC_TENANT_ID_CONFIG_PATH),
    ]);

    return {
      ...baseConfig,
      agentToken: agentTokenFromSecret ?? baseConfig.agentToken,
      projectId: projectIdFromSecret ?? baseConfig.projectId,
      tenantId: tenantIdFromSecret ?? baseConfig.tenantId,
    };
  }

  async function getSettings(companyId: string): Promise<BrabrixAgentSyncSettings> {
    const baseConfig = getBrabrixConfig();
    const secretIds = await readSecretIds(companyId);
    const resolvedConfig = await resolveConfig(companyId);

    return {
      provider: "brabrix_agent_sync",
      agentTokenSecretId: secretIds.agentTokenSecretId,
      projectIdSecretId: secretIds.projectIdSecretId,
      tenantIdSecretId: secretIds.tenantIdSecretId,
      credentialSource: {
        agentToken: secretIds.agentTokenSecretId ? "settings" : baseConfig.agentToken ? "env" : "none",
        projectId: secretIds.projectIdSecretId ? "settings" : baseConfig.projectId ? "env" : "none",
        tenantId: secretIds.tenantIdSecretId ? "settings" : baseConfig.tenantId ? "env" : "none",
      },
      enabled: resolveBrabrixConfig(resolvedConfig) !== null,
    };
  }

  async function updateSettings(
    companyId: string,
    patch: BrabrixAgentSyncSettingsUpdateRequest,
  ): Promise<BrabrixAgentSyncSettings> {
    const current = await readSecretIds(companyId);
    const nextAgentTokenSecretId = patch.agentTokenSecretId !== undefined
      ? patch.agentTokenSecretId
      : current.agentTokenSecretId;
    const nextProjectIdSecretId = patch.projectIdSecretId !== undefined
      ? patch.projectIdSecretId
      : current.projectIdSecretId;
    const nextTenantIdSecretId = patch.tenantIdSecretId !== undefined
      ? patch.tenantIdSecretId
      : current.tenantIdSecretId;

    const refs: Array<{
      secretId: string;
      configPath: string;
      versionSelector: "latest";
      required: true;
      label: string;
    }> = [];

    if (nextAgentTokenSecretId) {
      refs.push({
        secretId: nextAgentTokenSecretId,
        configPath: BRABRIX_SYNC_AGENT_TOKEN_CONFIG_PATH,
        versionSelector: "latest",
        required: true,
        label: "Brabrix agent token",
      });
    }
    if (nextProjectIdSecretId) {
      refs.push({
        secretId: nextProjectIdSecretId,
        configPath: BRABRIX_SYNC_PROJECT_ID_CONFIG_PATH,
        versionSelector: "latest",
        required: true,
        label: "Brabrix project id",
      });
    }
    if (nextTenantIdSecretId) {
      refs.push({
        secretId: nextTenantIdSecretId,
        configPath: BRABRIX_SYNC_TENANT_ID_CONFIG_PATH,
        versionSelector: "latest",
        required: true,
        label: "Brabrix tenant id",
      });
    }

    await secrets.syncSecretRefsForTarget(
      companyId,
      {
        targetType: "system",
        targetId: BRABRIX_SYNC_SETTINGS_TARGET_ID,
      },
      refs,
    );

    return getSettings(companyId);
  }

  return {
    getSettings,
    updateSettings,
    resolveConfig,
  };
}
