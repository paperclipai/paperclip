import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, like, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  companyMemberships,
  environments,
  heartbeatRuns,
  issues,
  projects,
  routines,
  secretAccessEvents,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import type {
  AgentEnvConfig,
  CompanySecretBindingTarget,
  EnvBinding,
  RemoteSecretImportCandidate,
  RemoteSecretImportConflict,
  RemoteSecretImportRowResult,
  SecretProviderConfigDiscoveryPreviewResult,
  SecretBindingTargetType,
  SecretProvider,
  SecretProviderConfigHealthResponse,
  SecretProviderConfigHealthStatus,
  SecretProviderConfigStatus,
  SecretVersionSelector,
} from "@paperclipai/shared";
import {
  createSecretProviderConfigSchema,
  deriveProjectUrlKey,
  envBindingSchema,
  isUuidLike,
  normalizeAgentUrlKey,
  secretProviderConfigPayloadSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  updateSecretProviderConfigSchema,
} from "@paperclipai/shared";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  checkSecretProviders,
  getSecretProvider,
  listSecretProviders,
} from "../secrets/provider-registry.js";
import type {
  PreparedSecretVersion,
  RemoteSecretListResult,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderVaultRuntimeConfig,
  SecretProviderWriteContext,
} from "../secrets/types.js";
import { isSecretProviderClientError } from "../secrets/types.js";
import { authorizationService } from "./authorization.js";
import { findActiveServerAdapter } from "../adapters/index.js";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const REDACTED_SENTINEL = "***REDACTED***";
const COMING_SOON_SECRET_PROVIDERS: ReadonlySet<SecretProvider> = new Set([
  "gcp_secret_manager",
  "vault",
]);
const FALLBACK_ADAPTER_SCHEMA_SECRET_FIELDS: Readonly<Record<string, readonly string[]>> = {
  hermes_gateway: ["apiKey"],
};
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SecretBindingDb = Pick<Db | DbTransaction, "select" | "delete" | "insert">;

function remoteProviderHttpError(error: unknown, context: {
  companyId: string;
  provider: SecretProvider;
  providerConfigId: string;
  operation: string;
  providerConfig?: Record<string, unknown> | null;
}): HttpError {
  if (isSecretProviderClientError(error)) {
    logger.warn(
      {
        err: error,
        companyId: context.companyId,
        provider: context.provider,
        providerConfigId: context.providerConfigId,
        operation: context.operation,
        providerErrorCode: error.code,
      },
      "remote secret provider request failed",
    );
    return new HttpError(error.status, error.message, safeRemoteProviderErrorDetails(error, context));
  }
  if (error instanceof HttpError) return error;
  logger.warn(
    {
      err: error,
      companyId: context.companyId,
      provider: context.provider,
      providerConfigId: context.providerConfigId,
      operation: context.operation,
      providerErrorCode: "provider_error",
    },
    "remote secret provider request failed",
  );
  return new HttpError(502, "Remote secret provider request failed.", safeRemoteProviderErrorDetails(null, context));
}

function safeRemoteProviderErrorDetails(
  error: { code: string } | null,
  context: {
    provider: SecretProvider;
    providerConfigId: string;
    operation: string;
    providerConfig?: Record<string, unknown> | null;
  },
): Record<string, unknown> {
  if (
    context.provider !== "aws_secrets_manager" ||
    context.operation !== "secret_provider_config.discovery.preview"
  ) {
    return { code: error?.code ?? "provider_error" };
  }
  const details: Record<string, unknown> = {
    code: error?.code ?? "provider_error",
    provider: context.provider,
    operation: context.operation,
    providerConfigId: context.providerConfigId,
  };
  const region = safeString(context.providerConfig?.region);
  if (region) details.region = region;
  details.providerVaultContext = context.providerConfigId === "discovery-preview" ? "draft_config" : "provider_config";
  details.credentialPath = "Paperclip server runtime/provider credential path";
  if (error?.code === "access_denied") {
    details.requiredCapability = "secretsmanager:ListSecrets";
    details.actionableMessage =
      "AWS discovery preview needs secretsmanager:ListSecrets in the selected region for the Paperclip server runtime/provider credential path.";
    details.safeAlternative =
      "If the operator already knows the exact AWS Secrets Manager ARN, paste/link that ARN instead of using discovery. Exact-resource DescribeSecret and runtime read permissions are still required.";
  }
  return details;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function remoteImportRowFailureReason(error: unknown, fallback: string, context: {
  companyId: string;
  provider: SecretProvider;
  providerConfigId: string;
  operation: string;
}): string {
  if (isSecretProviderClientError(error)) {
    logger.warn(
      {
        err: error,
        companyId: context.companyId,
        provider: context.provider,
        providerConfigId: context.providerConfigId,
        operation: context.operation,
        providerErrorCode: error.code,
      },
      "remote secret import row provider failure",
    );
    return error.message;
  }
  if (error instanceof HttpError && error.status < 500) return error.message;
  logger.warn(
    {
      err: error,
      companyId: context.companyId,
      provider: context.provider,
      providerConfigId: context.providerConfigId,
      operation: context.operation,
      providerErrorCode: "provider_error",
    },
    "remote secret import row failed",
  );
  return fallback;
}

async function cleanupPreparedProviderWrite(input: {
  provider: SecretProviderModule;
  prepared: PreparedSecretVersion;
  providerConfig: SecretProviderVaultRuntimeConfig | null;
  context: SecretProviderWriteContext;
  mode: "archive" | "delete";
  operation: string;
}): Promise<boolean> {
  try {
    await input.provider.deleteOrArchive({
      material: input.prepared.material,
      externalRef: input.prepared.externalRef,
      providerConfig: input.providerConfig,
      context: input.context,
      mode: input.mode,
    });
    return true;
  } catch (cleanupError) {
    logger.warn(
      {
        err: cleanupError,
        companyId: input.context.companyId,
        provider: input.provider.id,
        providerConfigId: input.providerConfig?.id ?? null,
        operation: input.operation,
      },
      "remote secret provider cleanup failed after db write failure",
    );
    return false;
  }
}

type CanonicalEnvBinding =
  | { type: "plain"; value: string }
  | { type: "secret_ref"; secretId: string; version: number | "latest" }
  | {
      type: "user_secret_ref";
      key: string;
      version: number | "latest";
      required: boolean;
      allowMissingOverride: boolean;
    };

type SecretConsumerContext = {
  consumerType: SecretBindingTargetType;
  consumerId: string;
  configPath?: string | null;
  responsibleUserId?: string | null;
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string | null;
  actorSource?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant";
  issueId?: string | null;
  heartbeatRunId?: string | null;
  pluginId?: string | null;
  allowedBindingIds?: string[] | null;
};

type SecretResolutionOptions = {
  bindingContext?: SecretConsumerContext;
  accessContext?: SecretConsumerContext;
  allowUserSecretScope?: boolean;
};

export type RuntimeSecretManifestEntry = {
  configPath: string;
  envKey: string | null;
  secretId: string;
  bindingId?: string | null;
  secretKey: string;
  version: number;
  provider: SecretProvider;
  providerVersionRef?: string | null;
  outcome: "success" | "failure";
  errorCode?: string | null;
};

export type MissingRuntimeBinding = {
  consumerType: SecretBindingTargetType;
  consumerId: string;
  configPath: string;
  envKey: string;
  bindingType?: "secret_ref" | "user_secret_ref";
  secretId: string | null;
  secretName: string | null;
  userSecretDefinitionId?: string | null;
  userSecretDefinitionKey?: string | null;
  userSecretDefinitionName?: string | null;
  responsibleUserId?: string | null;
  errorCode?: SecretResolutionErrorCode;
};

type RuntimeSecretResolution = {
  value: string;
  manifestEntry: RuntimeSecretManifestEntry;
};

type SecretResolutionErrorCode =
  | "binding_missing"
  | "secret_deleted"
  | "secret_inactive"
  | "secret_scope_invalid"
  | "responsible_user_missing"
  | "user_secret_definition_missing"
  | "user_secret_missing"
  | "version_missing"
  | "version_inactive"
  | "provider_error";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isSensitiveEnvKey(key: string) {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

function normalizeSecretKey(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function deriveSecretNameFromExternalRef(externalRef: string) {
  const trimmed = externalRef.trim();
  const arnMatch = /^arn:[^:]+:secretsmanager:[^:]*:[^:]*:secret:(.+)$/i.exec(trimmed);
  const name = arnMatch?.[1] ?? trimmed;
  return name.split("/").filter(Boolean).at(-1) ?? name;
}

function canonicalizeBinding(binding: EnvBinding): CanonicalEnvBinding {
  if (typeof binding === "string") {
    return { type: "plain", value: binding };
  }
  if (binding.type === "plain") {
    return { type: "plain", value: String(binding.value) };
  }
  if (binding.type === "user_secret_ref") {
    return {
      type: "user_secret_ref",
      key: binding.key,
      version: binding.version ?? "latest",
      required: binding.required ?? true,
      allowMissingOverride: binding.allowMissingOverride ?? false,
    };
  }
  return {
    type: "secret_ref",
    secretId: binding.secretId,
    version: binding.version ?? "latest",
  };
}

function defaultProviderConfigStatus(provider: SecretProvider): SecretProviderConfigStatus {
  return COMING_SOON_SECRET_PROVIDERS.has(provider) ? "coming_soon" : "ready";
}

function secretResolutionErrorCode(error: unknown): SecretResolutionErrorCode {
  if (isSecretProviderClientError(error)) return "provider_error";
  if (error instanceof HttpError) {
    const details = asRecord(error.details);
    switch (details?.code) {
      case "binding_missing":
      case "secret_deleted":
      case "secret_inactive":
      case "version_missing":
      case "version_inactive":
      case "provider_error":
        return details.code;
    }
    if (error.message === "Secret is not active") return "secret_inactive";
    if (error.message === "User secret value is not configured") return "user_secret_missing";
    if (error.message === "Responsible user is required for user secret resolution") {
      return "responsible_user_missing";
    }
    if (error.message === "User secret definition not found") return "user_secret_definition_missing";
    if (error.message === "User-scoped secrets must be resolved through user secret declarations") {
      return "secret_scope_invalid";
    }
    if (error.message === "Secret version not found") return "version_missing";
    if (error.message === "Secret version is not active") return "version_inactive";
    if (
      error.message === "Secret resolution requires a binding config path" ||
      error.message.startsWith("Secret is not bound to ")
    ) {
      return "binding_missing";
    }
    if (error.status >= 500) return "provider_error";
  }
  return "provider_error";
}

function assertSelectableProviderConfig(config: {
  provider: string;
  status: string;
  companyId: string;
}, companyId: string, provider: SecretProvider) {
  if (config.companyId !== companyId) throw unprocessable("Provider vault must belong to same company");
  if (config.provider !== provider) throw unprocessable("Provider vault must match the secret provider");
  if (config.status === "coming_soon") {
    throw unprocessable("Provider vault is locked while coming soon");
  }
  if (config.status === "disabled") {
    throw unprocessable("Provider vault is disabled");
  }
}

export function secretService(db: Db) {
  const authorization = authorizationService(db);

  type NormalizeEnvOptions = {
    strictMode?: boolean;
    fieldPath?: string;
  };
  type NormalizeAdapterConfigOptions = {
    strictMode?: boolean;
    adapterType?: string | null;
    actor?: { userId?: string | null; agentId?: string | null };
  };

  async function getById(id: string, source: Pick<Db | DbTransaction, "select"> = db) {
    return source
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getByName(companyId: string, name: string) {
    return db
      .select()
      .from(companySecrets)
      .where(and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.scope, "company"),
        eq(companySecrets.name, name),
        ne(companySecrets.status, "deleted"),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function getUserSecretDefinitionById(
    companyId: string,
    definitionId: string,
    source: Pick<Db | DbTransaction, "select"> = db,
  ) {
    return source
      .select()
      .from(userSecretDefinitions)
      .where(and(
        eq(userSecretDefinitions.companyId, companyId),
        eq(userSecretDefinitions.id, definitionId),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function getUserSecretDefinitionByKey(
    companyId: string,
    key: string,
    source: Pick<Db | DbTransaction, "select"> = db,
  ) {
    return source
      .select()
      .from(userSecretDefinitions)
      .where(and(
        eq(userSecretDefinitions.companyId, companyId),
        eq(userSecretDefinitions.key, key),
        ne(userSecretDefinitions.status, "deleted"),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function resolveUserSecretDefinition(
    companyId: string,
    input: { definitionId?: string | null; definitionKey?: string | null },
    source: Pick<Db | DbTransaction, "select"> = db,
  ) {
    const definition = input.definitionId
      ? await getUserSecretDefinitionById(companyId, input.definitionId, source)
      : input.definitionKey
        ? await getUserSecretDefinitionByKey(companyId, input.definitionKey, source)
        : null;
    if (!definition || definition.deletedAt || definition.status === "deleted") {
      throw notFound("User secret definition not found");
    }
    if (definition.companyId !== companyId) {
      throw unprocessable("User secret definition must belong to same company");
    }
    return definition;
  }

  async function getUserSecretValue(input: {
    companyId: string;
    ownerUserId: string;
    definitionId: string;
  }) {
    return db
      .select()
      .from(companySecrets)
      .where(and(
        eq(companySecrets.companyId, input.companyId),
        eq(companySecrets.scope, "user"),
        eq(companySecrets.ownerUserId, input.ownerUserId),
        eq(companySecrets.userSecretDefinitionId, input.definitionId),
        ne(companySecrets.status, "deleted"),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function getUserSecretValueById(companyId: string, ownerUserId: string, secretId: string) {
    const secret = await getById(secretId);
    if (!secret || secret.status === "deleted" || secret.scope !== "user") {
      throw notFound("User secret value not found");
    }
    if (secret.companyId !== companyId || secret.ownerUserId !== ownerUserId) {
      throw notFound("User secret value not found");
    }
    return secret;
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

  async function getBinding(input: {
    companyId: string;
    secretId: string;
    consumerType: SecretBindingTargetType;
    consumerId: string;
    configPath: string;
  }) {
    return db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, input.companyId),
          eq(companySecretBindings.secretId, input.secretId),
          eq(companySecretBindings.targetType, input.consumerType),
          eq(companySecretBindings.targetId, input.consumerId),
          eq(companySecretBindings.configPath, input.configPath),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function assertBindingContext(
    companyId: string,
    secretId: string,
    context: SecretConsumerContext | undefined,
  ) {
    if (!context) return null;
    if (!context.configPath) {
      throw unprocessable("Secret resolution requires a binding config path", { code: "binding_missing" });
    }
    const binding = await getBinding({
      companyId,
      secretId,
      consumerType: context.consumerType,
      consumerId: context.consumerId,
      configPath: context.configPath,
    });
    if (!binding) {
      throw unprocessable(
        `Secret is not bound to ${context.consumerType}:${context.consumerId} at ${context.configPath}`,
        { code: "binding_missing" },
      );
    }
    if (
      Array.isArray(context.allowedBindingIds) &&
      !context.allowedBindingIds.includes(binding.id)
    ) {
      throw unprocessable(
        "Secret binding is outside the active low-trust boundary",
        { code: "binding_not_allowed" },
      );
    }
    return binding;
  }

  async function recordAccessEvent(input: {
    companyId: string;
    secretId: string;
    userSecretDefinitionId?: string | null;
    secretScope?: string | null;
    version: number | null;
    provider: SecretProvider;
    context: SecretConsumerContext | undefined;
    credentialOwnerUserId?: string | null;
    credentialSubjectType?: string | null;
    credentialSubjectId?: string | null;
    outcome: "success" | "failure";
    errorCode?: string | null;
  }) {
    if (!input.context) return;
    await db.insert(secretAccessEvents).values({
      companyId: input.companyId,
      secretId: input.secretId,
      userSecretDefinitionId: input.userSecretDefinitionId ?? null,
      secretScope: input.secretScope ?? "company",
      version: input.version,
      provider: input.provider,
      responsibleUserId: input.context.responsibleUserId ?? null,
      credentialOwnerUserId: input.credentialOwnerUserId ?? null,
      credentialSubjectType: input.credentialSubjectType ?? null,
      credentialSubjectId: input.credentialSubjectId ?? null,
      actorType: input.context.actorType ?? "system",
      actorId: input.context.actorId ?? null,
      consumerType: input.context.consumerType,
      consumerId: input.context.consumerId,
      configPath: input.context.configPath ?? null,
      issueId: input.context.issueId ?? null,
      heartbeatRunId: input.context.heartbeatRunId ?? null,
      pluginId: input.context.pluginId ?? null,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
    });
  }

  async function assertSecretInCompany(
    companyId: string,
    secretId: string,
    source: Pick<Db | DbTransaction, "select"> = db,
  ) {
    const secret = await getById(secretId, source);
    if (!secret) throw notFound("Secret not found");
    if (secret.status === "deleted") throw notFound("Secret not found");
    if (secret.companyId !== companyId) throw unprocessable("Secret must belong to same company");
    if (secret.scope !== "company") throw unprocessable("Secret references require company-scoped secrets");
    return secret;
  }

  async function getProviderConfigById(id: string) {
    return db
      .select()
      .from(companySecretProviderConfigs)
      .where(eq(companySecretProviderConfigs.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function assertProviderConfigForSecret(
    companyId: string,
    provider: SecretProvider,
    providerConfigId: string | null | undefined,
  ) {
    if (!providerConfigId) return null;
    const providerConfig = await getProviderConfigById(providerConfigId);
    if (!providerConfig) throw notFound("Provider vault not found");
    assertSelectableProviderConfig(providerConfig, companyId, provider);
    return providerConfig;
  }

  function toProviderVaultRuntimeConfig(
    providerConfig: Awaited<ReturnType<typeof getProviderConfigById>> | null,
  ): SecretProviderVaultRuntimeConfig | null {
    if (!providerConfig) return null;
    return {
      id: providerConfig.id,
      provider: providerConfig.provider as SecretProvider,
      status: providerConfig.status,
      config: providerConfig.config ?? {},
    };
  }

  async function getSelectableRuntimeProviderConfig(input: {
    companyId: string;
    provider: SecretProvider;
    providerConfigId: string | null | undefined;
  }) {
    const providerConfig = await assertProviderConfigForSecret(
      input.companyId,
      input.provider,
      input.providerConfigId,
    );
    return toProviderVaultRuntimeConfig(providerConfig);
  }

  function validateProviderConfigPayload(
    provider: SecretProvider,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    const parsed = secretProviderConfigPayloadSchema.safeParse({ provider, config });
    if (!parsed.success) {
      throw unprocessable("Invalid provider vault config", parsed.error.flatten());
    }
    return parsed.data.config;
  }

  function toDraftProviderVaultRuntimeConfig(input: {
    companyId: string;
    provider: SecretProvider;
    config: Record<string, unknown>;
  }): SecretProviderVaultRuntimeConfig {
    return {
      id: `discovery-preview-${input.companyId}`,
      provider: input.provider,
      status: "ready",
      config: validateProviderConfigPayload(input.provider, input.config),
    };
  }

  function providerConfigHealth(input: {
    id: string;
    provider: SecretProvider;
    status: SecretProviderConfigStatus;
    config: Record<string, unknown>;
  }): Omit<SecretProviderConfigHealthResponse, "checkedAt"> | null {
    if (input.status === "disabled") {
      return {
        configId: input.id,
        provider: input.provider,
        status: "disabled",
        message: "Provider vault is disabled.",
        details: { code: "disabled", message: "Provider vault is disabled." },
      };
    }
    if (input.status === "coming_soon" || COMING_SOON_SECRET_PROVIDERS.has(input.provider)) {
      return {
        configId: input.id,
        provider: input.provider,
        status: "coming_soon",
        message: "Provider vault runtime is locked while coming soon.",
        details: {
          code: "runtime_locked",
          message: "Provider vault runtime is locked while coming soon.",
          guidance: ["Draft metadata may be saved, but create, rotate, and resolve stay unavailable."],
        },
      };
    }
    return null;
  }

  function mapProviderModuleHealth(input: {
    configId: string;
    provider: SecretProvider;
    providerStatus: SecretProviderConfigStatus;
    health: SecretProviderHealthCheck;
  }): Omit<SecretProviderConfigHealthResponse, "checkedAt"> {
    const status: SecretProviderConfigHealthStatus =
      input.health.status === "ok"
        ? input.providerStatus === "warning" ? "warning" : "ready"
        : input.health.status === "error"
          ? "error"
          : "warning";
    const guidance = [
      ...(input.health.warnings ?? []),
      ...(input.health.backupGuidance ?? []),
    ];
    return {
      configId: input.configId,
      provider: input.provider,
      status,
      message: input.health.message,
      details: {
        code: input.health.status === "ok" ? "provider_ready" : "provider_needs_attention",
        message: input.health.message,
        guidance: guidance.length > 0 ? guidance : undefined,
      },
    };
  }

  async function resolveSecretValueInternal(
    companyId: string,
    secretId: string,
    version: number | "latest",
    options?: SecretResolutionOptions,
  ): Promise<RuntimeSecretResolution> {
    const bindingContext = options?.bindingContext;
    const accessContext = options?.accessContext ?? bindingContext;
    const secret = await getById(secretId);
    if (!secret) throw notFound("Secret not found");
    if (secret.companyId !== companyId) throw unprocessable("Secret must belong to same company");
    if (secret.scope !== "company" && !options?.allowUserSecretScope) {
      throw unprocessable("User-scoped secrets must be resolved through user secret declarations", {
        code: "secret_scope_invalid",
      });
    }
    const resolvedVersion = version === "latest" ? secret.latestVersion : version;
    const providerId = secret.provider as SecretProvider;
    const configPath = accessContext?.configPath ?? null;
    try {
      if (secret.status === "deleted") {
        throw new HttpError(404, "Secret not found", { code: "secret_deleted" });
      }
      if (secret.status !== "active") {
        throw unprocessable("Secret is not active", { code: "secret_inactive" });
      }
      const binding = await assertBindingContext(companyId, secret.id, bindingContext);
      const versionRow = await getSecretVersion(secret.id, resolvedVersion);
      if (!versionRow) throw new HttpError(404, "Secret version not found", { code: "version_missing" });
      if (versionRow.status === "disabled" || versionRow.status === "destroyed" || versionRow.revokedAt) {
        throw unprocessable("Secret version is not active", { code: "version_inactive" });
      }
      const provider = getSecretProvider(providerId);
      const providerConfig = await getSelectableRuntimeProviderConfig({
        companyId,
        provider: providerId,
        providerConfigId: secret.providerConfigId,
      });
      const value = await provider.resolveVersion({
        material: versionRow.material as Record<string, unknown>,
        externalRef: secret.externalRef,
        providerVersionRef: versionRow.providerVersionRef,
        providerConfig,
        context: {
          companyId,
          secretId: secret.id,
          secretKey: secret.key,
          version: resolvedVersion,
        },
      });
      await Promise.all([
        db
          .update(companySecrets)
          .set({ lastResolvedAt: new Date(), updatedAt: new Date() })
          .where(eq(companySecrets.id, secret.id))
          .catch(() => undefined),
        recordAccessEvent({
          companyId,
          secretId: secret.id,
          userSecretDefinitionId: secret.userSecretDefinitionId ?? null,
          secretScope: secret.scope,
          version: resolvedVersion,
          provider: providerId,
          context: accessContext,
          credentialOwnerUserId: secret.ownerUserId ?? null,
          credentialSubjectType: secret.scope === "user" ? "user" : null,
          credentialSubjectId: secret.ownerUserId ?? null,
          outcome: "success",
        }).catch(() => undefined),
      ]);
      return {
        value,
        manifestEntry: {
          configPath: configPath ?? "",
          envKey: configPath?.startsWith("env.") ? configPath.slice("env.".length) : null,
          secretId: secret.id,
          bindingId: binding?.id ?? null,
          secretKey: secret.key,
          version: resolvedVersion,
          provider: providerId,
          providerVersionRef: versionRow.providerVersionRef,
          outcome: "success",
        },
      };
    } catch (err) {
      const errorCode = secretResolutionErrorCode(err);
      await recordAccessEvent({
        companyId,
        secretId: secret.id,
        userSecretDefinitionId: secret.userSecretDefinitionId ?? null,
        secretScope: secret.scope,
        version: resolvedVersion,
        provider: providerId,
        context: accessContext,
        credentialOwnerUserId: secret.ownerUserId ?? null,
        credentialSubjectType: secret.scope === "user" ? "user" : null,
        credentialSubjectId: secret.ownerUserId ?? null,
        outcome: "failure",
        errorCode,
      }).catch(() => undefined);
      throw err;
    }
  }

  async function resolveSecretValue(
    companyId: string,
    secretId: string,
    version: number | "latest",
    context?: SecretConsumerContext,
  ): Promise<string> {
    return (await resolveSecretValueInternal(companyId, secretId, version, {
      bindingContext: context,
      accessContext: context,
    })).value;
  }

  async function resolveSecretValueForEphemeralAccess(
    companyId: string,
    secretId: string,
    version: number | "latest",
    context: SecretConsumerContext,
  ): Promise<string> {
    if (context.consumerType !== "system" || context.consumerId !== "environment-probe-config") {
      throw forbidden("Ephemeral secret resolution is limited to draft environment probes");
    }
    if (
      (context.actorType !== "agent" && context.actorType !== "user") ||
      !context.actorId?.trim()
    ) {
      throw forbidden("Ephemeral secret resolution requires an authenticated actor");
    }
    const actor =
      context.actorType === "agent"
        ? {
            type: "agent" as const,
            agentId: context.actorId,
            companyId,
            source: context.actorSource === "agent_jwt" ? "agent_jwt" as const : "agent_key" as const,
          }
        : {
            type: "board" as const,
            userId: context.actorId,
            source: context.actorSource === "local_implicit"
              ? "local_implicit" as const
              : context.actorSource === "board_key"
                ? "board_key" as const
                : context.actorSource === "cloud_tenant"
                  ? "cloud_tenant" as const
                  : "session" as const,
          };
    const decision = await authorization.decide({
      actor,
      action: "secrets:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      throw forbidden(decision.explanation);
    }
    return (await resolveSecretValueInternal(companyId, secretId, version, {
      accessContext: context,
    })).value;
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
      if (binding.type === "user_secret_ref") {
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
    opts?: NormalizeAdapterConfigOptions,
  ) {
    const normalized = { ...adapterConfig };
    if (Object.prototype.hasOwnProperty.call(adapterConfig, "env")) {
      normalized.env = await normalizeEnvConfig(companyId, adapterConfig.env, opts);
    }
    const secretFieldKeys = await listAdapterSchemaSecretFieldKeys(opts?.adapterType);
    for (const key of secretFieldKeys) {
      if (!Object.prototype.hasOwnProperty.call(adapterConfig, key)) continue;
      const value = await normalizeSchemaSecretFieldForPersistence(companyId, {
        adapterType: opts?.adapterType ?? null,
        key,
        rawValue: adapterConfig[key],
        actor: opts?.actor,
      });
      if (value === undefined) {
        delete normalized[key];
      } else {
        normalized[key] = value;
      }
    }
    return normalized;
  }

  async function listAdapterSchemaSecretFieldKeys(adapterType: string | null | undefined): Promise<string[]> {
    if (!adapterType) return [];
    const adapter = findActiveServerAdapter(adapterType);
    const fallback = [...(FALLBACK_ADAPTER_SCHEMA_SECRET_FIELDS[adapterType] ?? [])];
    if (!adapter?.getConfigSchema) return fallback;
    try {
      const schema = await adapter.getConfigSchema();
      return [...new Set([
        ...fallback,
        ...schema.fields
        .filter((field) => field.meta?.secret === true)
        .map((field) => field.key),
      ])];
    } catch (err) {
      logger.warn({ err, adapterType }, "adapter config schema unavailable while normalizing secret fields");
      return fallback;
    }
  }

  async function normalizeSchemaSecretFieldForPersistence(
    companyId: string,
    input: {
      adapterType: string | null;
      key: string;
      rawValue: unknown;
      actor?: { userId?: string | null; agentId?: string | null };
    },
  ): Promise<EnvBinding | undefined> {
    if (input.rawValue === null || input.rawValue === undefined) return undefined;
    const parsed = envBindingSchema.safeParse(input.rawValue);
    if (!parsed.success) {
      throw unprocessable(`${input.key} must be a string, plain binding, or secret reference`);
    }
    const binding = canonicalizeBinding(parsed.data as EnvBinding);
    if (binding.type === "secret_ref") {
      await assertSecretInCompany(companyId, binding.secretId);
      return {
        type: "secret_ref",
        secretId: binding.secretId,
        version: binding.version,
      };
    }
    if (binding.type === "user_secret_ref") {
      throw unprocessable(`${input.key} must be a string, plain binding, or company secret reference`);
    }
    const value = binding.value.trim();
    if (!value) return undefined;
    if (value === REDACTED_SENTINEL) {
      throw unprocessable(`Refusing to persist redacted placeholder for key: ${input.key}`);
    }
    const id = randomUUID();
    const adapterPart = normalizeSecretKey(input.adapterType ?? "adapter");
    const fieldPart = normalizeSecretKey(input.key);
    const secret = await createManagedLocalSecret(companyId, {
      name: `${adapterPart}.${fieldPart}.${id}`,
      key: `${adapterPart}.${fieldPart}.${id}`,
      value,
      description: `Adapter config secret for ${input.adapterType ?? "adapter"}.${input.key}`,
    }, input.actor);
    return {
      type: "secret_ref",
      secretId: secret.id,
      version: "latest",
    };
  }

  async function createManagedLocalSecret(
    companyId: string,
    input: {
      name: string;
      key: string;
      value: string;
      description?: string | null;
    },
    actor?: { userId?: string | null; agentId?: string | null },
  ) {
    const existing = await getByName(companyId, input.name);
    if (existing) throw conflict(`Secret already exists: ${input.name}`);
    const key = normalizeSecretKey(input.key);
    if (!key) throw unprocessable("Secret key is required");
    const duplicateKey = await db
      .select()
      .from(companySecrets)
      .where(and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.scope, "company"),
        eq(companySecrets.key, key),
        ne(companySecrets.status, "deleted"),
      ))
      .then((rows) => rows[0] ?? null);
    if (duplicateKey) throw conflict(`Secret key already exists: ${key}`);

    const provider = getSecretProvider("local_encrypted");
    const providerConfig = await getSelectableRuntimeProviderConfig({
      companyId,
      provider: "local_encrypted",
      providerConfigId: null,
    });
    const providerWriteContext = {
      companyId,
      secretKey: key,
      secretName: input.name,
      version: 1,
    };
    const reservedSecret = await db
      .insert(companySecrets)
      .values({
        companyId,
        key,
        name: input.name,
        provider: "local_encrypted",
        providerConfigId: null,
        status: "archived",
        managedMode: "paperclip_managed",
        externalRef: null,
        providerMetadata: null,
        latestVersion: 0,
        description: input.description ?? null,
        createdByAgentId: actor?.agentId ?? null,
        createdByUserId: actor?.userId ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    let prepared: PreparedSecretVersion | null = null;
    try {
      prepared = await provider.createSecret({
        value: input.value,
        externalRef: null,
        providerConfig,
        context: providerWriteContext,
      });
      const preparedSecret = prepared;
      await db.insert(companySecretVersions).values({
        secretId: reservedSecret.id,
        version: 1,
        material: preparedSecret.material,
        valueSha256: preparedSecret.valueSha256,
        fingerprintSha256: preparedSecret.fingerprintSha256 ?? preparedSecret.valueSha256,
        providerVersionRef: preparedSecret.providerVersionRef ?? null,
        status: "disabled",
        createdByAgentId: actor?.agentId ?? null,
        createdByUserId: actor?.userId ?? null,
      });
      return await db.transaction(async (tx) => {
        await tx
          .update(companySecretVersions)
          .set({ status: "current" })
          .where(and(
            eq(companySecretVersions.secretId, reservedSecret.id),
            eq(companySecretVersions.version, 1),
          ));
        const secret = await tx
          .update(companySecrets)
          .set({
            status: "active",
            externalRef: preparedSecret.externalRef,
            latestVersion: 1,
            lastRotatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(companySecrets.id, reservedSecret.id))
          .returning()
          .then((rows) => rows[0]);
        if (!secret) throw notFound("Secret not found");
        return secret;
      });
    } catch (error) {
      if (prepared) {
        await cleanupPreparedProviderWrite({
          provider,
          prepared,
          providerConfig,
          context: providerWriteContext,
          mode: "delete",
          operation: "adapter_config_secret.create_rollback",
        }).catch(() => false);
      }
      await db.delete(companySecretVersions).where(eq(companySecretVersions.secretId, reservedSecret.id)).catch(() => undefined);
      await db.delete(companySecrets).where(eq(companySecrets.id, reservedSecret.id)).catch(() => undefined);
      throw error;
    }
  }

  function collectTargetIds(
    bindings: Array<typeof companySecretBindings.$inferSelect>,
    targetType: SecretBindingTargetType,
    opts?: { uuidOnly?: boolean },
  ) {
    return [
      ...new Set(
        bindings
          .filter((binding) => binding.targetType === targetType)
          .map((binding) => binding.targetId)
          .filter((id) => !opts?.uuidOnly || isUuidLike(id)),
      ),
    ];
  }

  function fallbackBindingTarget(binding: typeof companySecretBindings.$inferSelect): CompanySecretBindingTarget {
    return {
      type: binding.targetType as SecretBindingTargetType,
      id: binding.targetId,
      label: binding.targetId,
      href: null,
      status: null,
    };
  }

  async function buildBindingTargetMap(
    companyId: string,
    bindings: Array<typeof companySecretBindings.$inferSelect>,
  ) {
    const targetMap = new Map<string, CompanySecretBindingTarget>();
    const setTarget = (target: CompanySecretBindingTarget) => {
      targetMap.set(`${target.type}:${target.id}`, target);
    };

    const agentIds = collectTargetIds(bindings, "agent", { uuidOnly: true });
    if (agentIds.length > 0) {
      const rows = await db
        .select({
          id: agents.id,
          name: agents.name,
          title: agents.title,
          status: agents.status,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
      for (const row of rows) {
        setTarget({
          type: "agent",
          id: row.id,
          label: row.title ? `${row.name} (${row.title})` : row.name,
          href: `/agents/${normalizeAgentUrlKey(row.name) ?? row.id}`,
          status: row.status,
        });
      }
    }

    const projectIds = collectTargetIds(bindings, "project", { uuidOnly: true });
    if (projectIds.length > 0) {
      const rows = await db
        .select({
          id: projects.id,
          name: projects.name,
          status: projects.status,
        })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)));
      for (const row of rows) {
        setTarget({
          type: "project",
          id: row.id,
          label: row.name,
          href: `/projects/${deriveProjectUrlKey(row.name, row.id)}`,
          status: row.status,
        });
      }
    }

    const environmentIds = collectTargetIds(bindings, "environment", { uuidOnly: true });
    if (environmentIds.length > 0) {
      const rows = await db
        .select({
          id: environments.id,
          name: environments.name,
          status: environments.status,
        })
        .from(environments)
        .where(inArray(environments.id, environmentIds));
      for (const row of rows) {
        setTarget({
          type: "environment",
          id: row.id,
          label: row.name,
          href: "/company/settings/instance/environments",
          status: row.status,
        });
      }
    }

    const routineIds = collectTargetIds(bindings, "routine", { uuidOnly: true });
    if (routineIds.length > 0) {
      const rows = await db
        .select({
          id: routines.id,
          title: routines.title,
          status: routines.status,
        })
        .from(routines)
        .where(and(eq(routines.companyId, companyId), inArray(routines.id, routineIds)));
      for (const row of rows) {
        setTarget({
          type: "routine",
          id: row.id,
          label: row.title,
          href: `/routines/${row.id}`,
          status: row.status,
        });
      }
    }

    const issueIds = collectTargetIds(bindings, "issue", { uuidOnly: true });
    if (issueIds.length > 0) {
      const rows = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
      for (const row of rows) {
        setTarget({
          type: "issue",
          id: row.id,
          label: row.identifier ? `${row.identifier} ${row.title}` : row.title,
          href: `/issues/${row.identifier ?? row.id}`,
          status: row.status,
        });
      }
    }

    const runIds = collectTargetIds(bindings, "run", { uuidOnly: true });
    if (runIds.length > 0) {
      const rows = await db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds)));
      for (const row of rows) {
        setTarget({
          type: "run",
          id: row.id,
          label: `Run ${row.id.slice(0, 8)}`,
          href: `/agents/${row.agentId}/runs/${row.id}`,
          status: row.status,
        });
      }
    }

    return targetMap;
  }

  async function buildRemoteImportConflictMaps(companyId: string, provider: SecretProvider) {
    const activeSecrets = await db
      .select({
        id: companySecrets.id,
        name: companySecrets.name,
        key: companySecrets.key,
        provider: companySecrets.provider,
        providerConfigId: companySecrets.providerConfigId,
        externalRef: companySecrets.externalRef,
        status: companySecrets.status,
      })
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), ne(companySecrets.status, "deleted")));
    return {
      byProviderConfigExternalRef: new Map(
        activeSecrets
          .filter((secret) =>
            secret.provider === provider &&
            typeof secret.externalRef === "string" &&
            secret.externalRef.trim()
          )
          .map((secret) => [
            remoteImportExternalRefKey(secret.providerConfigId, secret.externalRef!),
            secret,
          ]),
      ),
      byName: new Map(activeSecrets.map((secret) => [secret.name, secret])),
      byKey: new Map(activeSecrets.map((secret) => [secret.key, secret])),
    };
  }

  function remoteImportExternalRefKey(providerConfigId: string | null | undefined, externalRef: string) {
    return `${providerConfigId ?? "default"}\0${externalRef.trim()}`;
  }

  function sanitizeRemoteProviderMetadata(
    provider: SecretProvider,
    metadata: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (!metadata || provider !== "aws_secrets_manager") return null;
    const safe: Record<string, unknown> = {};
    for (const key of ["createdDate", "lastAccessedDate", "lastChangedDate", "deletedDate"]) {
      const value = metadata[key];
      if (typeof value === "string" || value === null) safe[key] = value;
    }
    for (const key of ["hasDescription", "hasKmsKey", "tagCount"]) {
      const value = metadata[key];
      if (typeof value === "boolean" || typeof value === "number") safe[key] = value;
    }
    return Object.keys(safe).length > 0 ? safe : null;
  }

  function remoteImportConflictsFor(input: {
    providerConfigId: string | null;
    externalRef: string;
    name: string;
    key: string;
    maps: Awaited<ReturnType<typeof buildRemoteImportConflictMaps>>;
  }): RemoteSecretImportConflict[] {
    const conflicts: RemoteSecretImportConflict[] = [];
    const duplicate = input.maps.byProviderConfigExternalRef.get(
      remoteImportExternalRefKey(input.providerConfigId, input.externalRef),
    );
    if (duplicate) {
      conflicts.push({
        type: "exact_reference",
        existingSecretId: duplicate.id,
        message: "An existing secret already links this exact provider reference.",
      });
      return conflicts;
    }
    const nameConflict = input.maps.byName.get(input.name);
    if (nameConflict) {
      conflicts.push({
        type: "name",
        existingSecretId: nameConflict.id,
        message: `Secret name already exists: ${input.name}`,
      });
    }
    const keyConflict = input.maps.byKey.get(input.key);
    if (keyConflict) {
      conflicts.push({
        type: "key",
        existingSecretId: keyConflict.id,
        message: `Secret key already exists: ${input.key}`,
      });
    }
    return conflicts;
  }

  async function getRemoteImportProviderConfig(companyId: string, providerConfigId: string) {
    const providerConfig = await getProviderConfigById(providerConfigId);
    if (!providerConfig) throw notFound("Provider vault not found");
    const provider = providerConfig.provider as SecretProvider;
    assertSelectableProviderConfig(providerConfig, companyId, provider);
    return { providerConfig, provider, runtimeConfig: toProviderVaultRuntimeConfig(providerConfig) };
  }

  async function createUserSecretValueInternal(
    companyId: string,
    ownerUserId: string,
    input: {
      definitionId?: string | null;
      definitionKey?: string | null;
      value?: string | null;
      externalRef?: string | null;
      providerVersionRef?: string | null;
      providerConfigId?: string | null;
    },
    actor?: { userId?: string | null; agentId?: string | null },
  ) {
    const definition = await resolveUserSecretDefinition(companyId, input);
    if (definition.status !== "active") {
      throw unprocessable("User secret definition is not active");
    }
    const existing = await getUserSecretValue({
      companyId,
      ownerUserId,
      definitionId: definition.id,
    });
    if (existing) throw conflict("User secret value already exists");

    const providerId = definition.provider as SecretProvider;
    const managedMode = definition.managedMode as "paperclip_managed" | "external_reference";
    if (managedMode === "external_reference" && !input.externalRef?.trim()) {
      throw unprocessable("External reference user secrets require externalRef");
    }
    if (managedMode === "paperclip_managed" && input.externalRef?.trim()) {
      throw unprocessable("Managed user secrets cannot override externalRef");
    }
    if (managedMode === "paperclip_managed" && !input.value?.trim()) {
      throw unprocessable("Managed user secrets require value");
    }

    const providerConfigId =
      input.providerConfigId === undefined ? definition.providerConfigId : input.providerConfigId;
    const provider = getSecretProvider(providerId);
    const providerConfig = await getSelectableRuntimeProviderConfig({
      companyId,
      provider: providerId,
      providerConfigId,
    });
    const idSuffix = randomUUID();
    const key = normalizeSecretKey(`user.${definition.key}.${idSuffix}`);
    const name = `${definition.name} (${ownerUserId})`;
    const providerWriteContext = {
      companyId,
      secretKey: key,
      secretName: definition.name,
      version: 1,
    };
    const reservedSecret = await db
      .insert(companySecrets)
      .values({
        companyId,
        scope: "user",
        ownerUserId,
        userSecretDefinitionId: definition.id,
        key,
        name,
        provider: providerId,
        providerConfigId: providerConfigId ?? null,
        status: "archived",
        managedMode,
        externalRef: null,
        providerMetadata: definition.providerMetadata ?? null,
        latestVersion: 0,
        description: definition.description ?? null,
        createdByAgentId: actor?.agentId ?? null,
        createdByUserId: actor?.userId ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    let prepared: PreparedSecretVersion;
    try {
      prepared =
        managedMode === "external_reference"
          ? await provider.linkExternalSecret({
              externalRef: input.externalRef ?? "",
              providerVersionRef: input.providerVersionRef ?? null,
              providerConfig,
              context: providerWriteContext,
            })
          : await provider.createSecret({
              value: input.value ?? "",
              externalRef: null,
              providerConfig,
              context: providerWriteContext,
            });
    } catch (error) {
      await db.delete(companySecrets).where(eq(companySecrets.id, reservedSecret.id)).catch(() => undefined);
      throw error;
    }

    try {
      return await db.transaction(async (tx) => {
        await tx.insert(companySecretVersions).values({
          secretId: reservedSecret.id,
          version: 1,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
          providerVersionRef: prepared.providerVersionRef ?? null,
          status: "current",
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });
        const secret = await tx
          .update(companySecrets)
          .set({
            status: "active",
            externalRef: prepared.externalRef,
            latestVersion: 1,
            lastRotatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(companySecrets.id, reservedSecret.id))
          .returning()
          .then((rows) => rows[0]);
        if (!secret) throw notFound("User secret value not found");
        return secret;
      });
    } catch (error) {
      if (managedMode === "paperclip_managed") {
        await cleanupPreparedProviderWrite({
          provider,
          prepared,
          providerConfig,
          context: providerWriteContext,
          mode: "delete",
          operation: "user_secret_value.create_rollback",
        }).catch(() => false);
      }
      await db.delete(companySecretVersions).where(eq(companySecretVersions.secretId, reservedSecret.id)).catch(() => undefined);
      await db.delete(companySecrets).where(eq(companySecrets.id, reservedSecret.id)).catch(() => undefined);
      throw error;
    }
  }

  return {
    listProviders: () => listSecretProviders(),

    checkProviders: () => checkSecretProviders(),

    previewProviderConfigDiscovery: async (
      companyId: string,
      input: {
        provider: SecretProvider;
        config?: Record<string, unknown>;
        query?: string | null;
        nextToken?: string | null;
        pageSize?: number;
      },
    ): Promise<SecretProviderConfigDiscoveryPreviewResult> => {
      const parsed = secretProviderConfigDiscoveryPreviewSchema.safeParse({
        provider: input.provider,
        config: input.config ?? {},
        query: input.query,
        nextToken: input.nextToken,
        pageSize: input.pageSize,
      });
      if (!parsed.success) {
        throw unprocessable("Invalid provider vault discovery config", parsed.error.flatten());
      }
      const providerId = parsed.data.provider as SecretProvider;
      const provider = getSecretProvider(providerId);
      if (!provider.discoverProviderConfigs) {
        throw unprocessable(`${providerId} provider does not support provider vault discovery`);
      }
      const runtimeConfig = toDraftProviderVaultRuntimeConfig({
        companyId,
        provider: providerId,
        config: parsed.data.config,
      });
      try {
        return await provider.discoverProviderConfigs({
          companyId,
          providerConfig: runtimeConfig,
          query: parsed.data.query,
          nextToken: parsed.data.nextToken,
          pageSize: parsed.data.pageSize,
        });
      } catch (error) {
        throw remoteProviderHttpError(error, {
          companyId,
          provider: providerId,
          providerConfigId: "discovery-preview",
          operation: "secret_provider_config.discovery.preview",
          providerConfig: parsed.data.config,
        });
      }
    },

    listProviderConfigs: (companyId: string) =>
      db
        .select()
        .from(companySecretProviderConfigs)
        .where(eq(companySecretProviderConfigs.companyId, companyId))
        .orderBy(desc(companySecretProviderConfigs.createdAt)),

    getProviderConfigById,

    createProviderConfig: async (
      companyId: string,
      input: {
        provider: SecretProvider;
        displayName: string;
        status?: SecretProviderConfigStatus;
        isDefault?: boolean;
        config?: Record<string, unknown>;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const parsed = createSecretProviderConfigSchema.safeParse(input);
      if (!parsed.success) throw unprocessable("Invalid provider vault config", parsed.error.flatten());
      const status = input.status ?? defaultProviderConfigStatus(input.provider);
      if ((status === "coming_soon" || status === "disabled") && input.isDefault) {
        throw unprocessable("Only ready or warning provider vaults can be default");
      }
      const normalizedConfig = validateProviderConfigPayload(input.provider, input.config ?? {});
      return db.transaction(async (tx) => {
        if (input.isDefault) {
          await tx
            .update(companySecretProviderConfigs)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(and(
              eq(companySecretProviderConfigs.companyId, companyId),
              eq(companySecretProviderConfigs.provider, input.provider),
            ));
        }
        return tx
          .insert(companySecretProviderConfigs)
          .values({
            companyId,
            provider: input.provider,
            displayName: input.displayName.trim(),
            status,
            isDefault: input.isDefault ?? false,
            config: normalizedConfig,
            disabledAt: status === "disabled" ? new Date() : null,
            createdByAgentId: actor?.agentId ?? null,
            createdByUserId: actor?.userId ?? null,
          })
          .returning()
          .then((rows) => rows[0]);
      });
    },

    updateProviderConfig: async (
      id: string,
      patch: {
        displayName?: string;
        status?: SecretProviderConfigStatus;
        isDefault?: boolean;
        config?: Record<string, unknown>;
      },
    ) => {
      const existing = await getProviderConfigById(id);
      if (!existing) return null;
      const parsed = updateSecretProviderConfigSchema.safeParse(patch);
      if (!parsed.success) throw unprocessable("Invalid provider vault config", parsed.error.flatten());
      const provider = existing.provider as SecretProvider;
      const status = patch.status ?? (existing.status as SecretProviderConfigStatus);
      if (COMING_SOON_SECRET_PROVIDERS.has(provider) && status !== "coming_soon" && status !== "disabled") {
        throw unprocessable(`${provider} provider vaults are locked while coming soon`);
      }
      if ((status === "coming_soon" || status === "disabled") && patch.isDefault) {
        throw unprocessable("Only ready or warning provider vaults can be default");
      }
      const normalizedConfig =
        patch.config === undefined
          ? existing.config
          : validateProviderConfigPayload(provider, patch.config);
      return db.transaction(async (tx) => {
        if (patch.isDefault) {
          await tx
            .update(companySecretProviderConfigs)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(and(
              eq(companySecretProviderConfigs.companyId, existing.companyId),
              eq(companySecretProviderConfigs.provider, existing.provider),
            ));
        }
        return tx
          .update(companySecretProviderConfigs)
          .set({
            displayName: patch.displayName?.trim() ?? existing.displayName,
            status,
            isDefault: status === "disabled" || status === "coming_soon" ? false : patch.isDefault ?? existing.isDefault,
            config: normalizedConfig,
            disabledAt: status === "disabled" ? existing.disabledAt ?? new Date() : null,
            updatedAt: new Date(),
          })
          .where(eq(companySecretProviderConfigs.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
    },

    disableProviderConfig: async (id: string) => {
      const existing = await getProviderConfigById(id);
      if (!existing) return null;
      return db
        .update(companySecretProviderConfigs)
        .set({
          status: "disabled",
          isDefault: false,
          disabledAt: existing.disabledAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(eq(companySecretProviderConfigs.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    removeProviderConfig: async (id: string) =>
      db
        .delete(companySecretProviderConfigs)
        .where(eq(companySecretProviderConfigs.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    setDefaultProviderConfig: async (id: string) => {
      const existing = await getProviderConfigById(id);
      if (!existing) return null;
      if (existing.status === "coming_soon" || existing.status === "disabled") {
        throw unprocessable("Only ready or warning provider vaults can be default");
      }
      return db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(companySecretProviderConfigs)
          .where(eq(companySecretProviderConfigs.id, id))
          .then((rows) => rows[0] ?? null);
        if (!current) return null;
        if (current.status === "coming_soon" || current.status === "disabled") {
          throw unprocessable("Only ready or warning provider vaults can be default");
        }
        await tx
          .update(companySecretProviderConfigs)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(and(
            eq(companySecretProviderConfigs.companyId, current.companyId),
            eq(companySecretProviderConfigs.provider, current.provider),
          ));
        const updated = await tx
          .update(companySecretProviderConfigs)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(and(
            eq(companySecretProviderConfigs.id, id),
            notInArray(companySecretProviderConfigs.status, ["coming_soon", "disabled"]),
          ))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) throw unprocessable("Only ready or warning provider vaults can be default");
        return updated;
      });
    },

    checkProviderConfigHealth: async (id: string) => {
      const existing = await getProviderConfigById(id);
      if (!existing) return null;
      const checkedAt = new Date();
      const staticHealth = providerConfigHealth({
        id: existing.id,
        provider: existing.provider as SecretProvider,
        status: existing.status as SecretProviderConfigStatus,
        config: existing.config ?? {},
      });
      const provider = getSecretProvider(existing.provider as SecretProvider);
      const health = staticHealth ?? mapProviderModuleHealth({
        configId: existing.id,
        provider: existing.provider as SecretProvider,
        providerStatus: existing.status as SecretProviderConfigStatus,
        health: await provider.healthCheck({
          providerConfig: toProviderVaultRuntimeConfig(existing),
        }),
      });
      await db
        .update(companySecretProviderConfigs)
        .set({
          healthStatus: health.status,
          healthCheckedAt: checkedAt,
          healthMessage: health.message,
          healthDetails: health.details as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(companySecretProviderConfigs.id, id));
      return { ...health, checkedAt };
    },

    list: async (companyId: string) => {
      const [secrets, referenceCounts] = await Promise.all([
        db
          .select()
          .from(companySecrets)
          .where(and(
            eq(companySecrets.companyId, companyId),
            eq(companySecrets.scope, "company"),
            ne(companySecrets.status, "deleted"),
          ))
          .orderBy(desc(companySecrets.createdAt)),
        db
          .select({
            secretId: companySecretBindings.secretId,
            count: sql<number>`count(*)::int`,
          })
          .from(companySecretBindings)
          .where(eq(companySecretBindings.companyId, companyId))
          .groupBy(companySecretBindings.secretId),
      ]);
      const countsBySecretId = new Map(referenceCounts.map((row) => [row.secretId, row.count]));
      return secrets.map((secret) => ({
        ...secret,
        referenceCount: countsBySecretId.get(secret.id) ?? 0,
      }));
    },

    listBindings: (companyId: string, secretId?: string) =>
      db
        .select()
        .from(companySecretBindings)
        .where(
          secretId
            ? and(eq(companySecretBindings.companyId, companyId), eq(companySecretBindings.secretId, secretId))
            : eq(companySecretBindings.companyId, companyId),
        )
        .orderBy(desc(companySecretBindings.createdAt)),

    listBindingReferences: async (companyId: string, secretId: string) => {
      const bindings = await db
        .select()
        .from(companySecretBindings)
        .where(and(eq(companySecretBindings.companyId, companyId), eq(companySecretBindings.secretId, secretId)))
        .orderBy(desc(companySecretBindings.createdAt));
      const targetMap = await buildBindingTargetMap(companyId, bindings);
      return bindings.map((binding) => ({
        ...binding,
        target:
          targetMap.get(`${binding.targetType}:${binding.targetId}`) ??
          fallbackBindingTarget(binding),
      }));
    },

    listAccessEvents: (companyId: string, secretId: string) =>
      db
        .select()
        .from(secretAccessEvents)
        .where(and(eq(secretAccessEvents.companyId, companyId), eq(secretAccessEvents.secretId, secretId)))
        .orderBy(desc(secretAccessEvents.createdAt)),

    listUserSecretDefinitions: (companyId: string) =>
      db
        .select()
        .from(userSecretDefinitions)
        .where(and(eq(userSecretDefinitions.companyId, companyId), ne(userSecretDefinitions.status, "deleted")))
        .orderBy(desc(userSecretDefinitions.createdAt)),

    getUserSecretDefinitionById: (companyId: string, definitionId: string) =>
      getUserSecretDefinitionById(companyId, definitionId),

    createUserSecretDefinition: async (
      companyId: string,
      input: {
        key: string;
        name: string;
        description?: string | null;
        status?: string;
        provider: SecretProvider;
        providerConfigId?: string | null;
        managedMode?: "paperclip_managed" | "external_reference";
        providerMetadata?: Record<string, unknown> | null;
        usageGuidance?: string | null;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const key = input.key.trim();
      const duplicate = await getUserSecretDefinitionByKey(companyId, key);
      if (duplicate) throw conflict(`User secret definition already exists: ${key}`);
      await assertProviderConfigForSecret(companyId, input.provider, input.providerConfigId);
      return db
        .insert(userSecretDefinitions)
        .values({
          companyId,
          key,
          name: input.name.trim(),
          description: input.description ?? null,
          status: input.status ?? "active",
          provider: input.provider,
          providerConfigId: input.providerConfigId ?? null,
          managedMode: input.managedMode ?? "paperclip_managed",
          providerMetadata: input.providerMetadata ?? null,
          usageGuidance: input.usageGuidance ?? null,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
          updatedByAgentId: actor?.agentId ?? null,
          updatedByUserId: actor?.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    updateUserSecretDefinition: async (
      companyId: string,
      definitionId: string,
      patch: {
        key?: string;
        name?: string;
        description?: string | null;
        status?: string;
        providerConfigId?: string | null;
        providerMetadata?: Record<string, unknown> | null;
        usageGuidance?: string | null;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const existing = await resolveUserSecretDefinition(companyId, { definitionId });
      const nextKey = patch.key?.trim() ?? existing.key;
      if (nextKey !== existing.key) {
        const duplicate = await getUserSecretDefinitionByKey(companyId, nextKey);
        if (duplicate && duplicate.id !== existing.id) {
          throw conflict(`User secret definition already exists: ${nextKey}`);
        }
      }
      if (patch.providerConfigId !== undefined) {
        await assertProviderConfigForSecret(
          companyId,
          existing.provider as SecretProvider,
          patch.providerConfigId,
        );
      }
      const deleting = patch.status === "deleted";
      return db
        .update(userSecretDefinitions)
        .set({
          key: deleting ? `${existing.key}__deleted__${existing.id}` : nextKey,
          name: patch.name?.trim() ?? existing.name,
          description: patch.description === undefined ? existing.description : patch.description,
          status: patch.status ?? existing.status,
          providerConfigId:
            patch.providerConfigId === undefined ? existing.providerConfigId : patch.providerConfigId,
          providerMetadata:
            patch.providerMetadata === undefined ? existing.providerMetadata : patch.providerMetadata,
          usageGuidance:
            patch.usageGuidance === undefined ? existing.usageGuidance : patch.usageGuidance,
          updatedByAgentId: actor?.agentId ?? null,
          updatedByUserId: actor?.userId ?? null,
          deletedAt: deleting ? new Date() : existing.deletedAt,
          updatedAt: new Date(),
        })
        .where(and(
          eq(userSecretDefinitions.companyId, companyId),
          eq(userSecretDefinitions.id, definitionId),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    removeUserSecretDefinition: async (
      companyId: string,
      definitionId: string,
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const existing = await resolveUserSecretDefinition(companyId, { definitionId });
      return db
        .update(userSecretDefinitions)
        .set({
          key: `${existing.key}__deleted__${existing.id}`,
          status: "deleted",
          deletedAt: existing.deletedAt ?? new Date(),
          updatedByAgentId: actor?.agentId ?? null,
          updatedByUserId: actor?.userId ?? null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(userSecretDefinitions.companyId, companyId),
          eq(userSecretDefinitions.id, definitionId),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    getUserSecretDefinitionCoverage: async (companyId: string, definitionId: string) => {
      await resolveUserSecretDefinition(companyId, { definitionId });
      const [members, values] = await Promise.all([
        db
          .select({ principalId: companyMemberships.principalId })
          .from(companyMemberships)
          .where(and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
          )),
        db
          .select({ status: companySecrets.status, ownerUserId: companySecrets.ownerUserId })
          .from(companySecrets)
          .where(and(
            eq(companySecrets.companyId, companyId),
            eq(companySecrets.scope, "user"),
            eq(companySecrets.userSecretDefinitionId, definitionId),
            ne(companySecrets.status, "deleted"),
          )),
      ]);
      const memberIds = new Set(members.map((member) => member.principalId));
      const configuredCount = values.filter((value) =>
        value.status === "active" && value.ownerUserId && memberIds.has(value.ownerUserId)
      ).length;
      const inactiveCount = values.filter((value) =>
        value.status !== "active" && value.ownerUserId && memberIds.has(value.ownerUserId)
      ).length;
      return {
        definitionId,
        configuredCount,
        inactiveCount,
        missingCount: Math.max(0, memberIds.size - configuredCount - inactiveCount),
      };
    },

    listCurrentUserSecretValues: async (companyId: string, ownerUserId: string) => {
      const definitions = await db
        .select()
        .from(userSecretDefinitions)
        .where(and(eq(userSecretDefinitions.companyId, companyId), ne(userSecretDefinitions.status, "deleted")))
        .orderBy(desc(userSecretDefinitions.createdAt));
      const values = await db
        .select()
        .from(companySecrets)
        .where(and(
          eq(companySecrets.companyId, companyId),
          eq(companySecrets.scope, "user"),
          eq(companySecrets.ownerUserId, ownerUserId),
          ne(companySecrets.status, "deleted"),
        ));
      const valuesByDefinitionId = new Map(values.map((value) => [value.userSecretDefinitionId, value]));
      return definitions.map((definition) => ({
        definition,
        secret: valuesByDefinitionId.get(definition.id) ?? null,
      }));
    },

    createCurrentUserSecretValue: createUserSecretValueInternal,

    rotateCurrentUserSecretValue: async (
      companyId: string,
      ownerUserId: string,
      secretId: string,
      input: {
        value?: string | null;
        externalRef?: string | null;
        providerVersionRef?: string | null;
        providerConfigId?: string | null;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const secret = await getUserSecretValueById(companyId, ownerUserId, secretId);
      return await (async () => {
        await resolveUserSecretDefinition(companyId, { definitionId: secret.userSecretDefinitionId });
        return (await secretService(db).rotate(secret.id, input, actor));
      })();
    },

    updateCurrentUserSecretValue: async (
      companyId: string,
      ownerUserId: string,
      secretId: string,
      patch: {
        status?: "active" | "disabled" | "archived" | "deleted";
        value?: string | null;
        externalRef?: string | null;
        providerVersionRef?: string | null;
        providerConfigId?: string | null;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const secret = await getUserSecretValueById(companyId, ownerUserId, secretId);
      if (
        patch.value !== undefined ||
        patch.externalRef !== undefined ||
        patch.providerVersionRef !== undefined ||
        patch.providerConfigId !== undefined
      ) {
        return await secretService(db).rotateCurrentUserSecretValue(
          companyId,
          ownerUserId,
          secret.id,
          patch,
          actor,
        );
      }
      if (patch.status === "deleted") {
        return await secretService(db).removeCurrentUserSecretValue(companyId, ownerUserId, secret.id);
      }
      return db
        .update(companySecrets)
        .set({
          status: patch.status ?? secret.status,
          updatedAt: new Date(),
        })
        .where(eq(companySecrets.id, secret.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    removeCurrentUserSecretValue: async (companyId: string, ownerUserId: string, secretId: string) => {
      const secret = await getUserSecretValueById(companyId, ownerUserId, secretId);
      return await secretService(db).remove(secret.id);
    },

    syncUserSecretDeclarationsForTarget: async (
      companyId: string,
      target: { targetType: SecretBindingTargetType; targetId: string; pathPrefix?: string },
      refs: Array<{
        definitionKey: string;
        configPath: string;
        envKey: string;
        versionSelector?: SecretVersionSelector;
        required?: boolean;
        allowMissingOverride?: boolean;
        label?: string | null;
      }>,
      options?: { db?: SecretBindingDb; replaceAll?: boolean },
    ) => {
      const targetDb = options?.db ?? db;
      const normalizedRefs: Array<{
        definitionId: string;
        configPath: string;
        envKey: string;
        versionSelector: SecretVersionSelector;
        required: boolean;
        allowMissingOverride: boolean;
        label: string | null;
      }> = [];
      for (const ref of refs) {
        const definition = await resolveUserSecretDefinition(
          companyId,
          { definitionKey: ref.definitionKey },
          targetDb,
        );
        normalizedRefs.push({
          definitionId: definition.id,
          configPath: ref.configPath,
          envKey: ref.envKey,
          versionSelector: ref.versionSelector ?? "latest",
          required: ref.required ?? true,
          allowMissingOverride: ref.allowMissingOverride ?? false,
          label: ref.label ?? null,
        });
      }

      const pathPrefix = target.pathPrefix ?? "env";
      const writeDeclarations = async (executor: SecretBindingDb) => {
        if (options?.replaceAll) {
          await executor
            .delete(userSecretDeclarations)
            .where(and(
              eq(userSecretDeclarations.companyId, companyId),
              eq(userSecretDeclarations.targetType, target.targetType),
              eq(userSecretDeclarations.targetId, target.targetId),
            ));
        } else {
          await executor
            .delete(userSecretDeclarations)
            .where(and(
              eq(userSecretDeclarations.companyId, companyId),
              eq(userSecretDeclarations.targetType, target.targetType),
              eq(userSecretDeclarations.targetId, target.targetId),
              like(userSecretDeclarations.configPath, `${pathPrefix}.%`),
            ));
        }
        if (normalizedRefs.length === 0) return;
        await executor.insert(userSecretDeclarations).values(
          normalizedRefs.map((ref) => ({
            companyId,
            userSecretDefinitionId: ref.definitionId,
            targetType: target.targetType,
            targetId: target.targetId,
            configPath: ref.configPath,
            envKey: ref.envKey,
            versionSelector: String(ref.versionSelector),
            required: ref.required,
            allowMissingOverride: ref.allowMissingOverride,
            label: ref.label,
          })),
        );
      };

      if (options?.db) {
        await writeDeclarations(targetDb);
      } else {
        await db.transaction(async (tx) => writeDeclarations(tx));
      }
      return normalizedRefs;
    },

    resolveUserSecretValue: async (
      companyId: string,
      input: {
        definitionKey?: string | null;
        definitionId?: string | null;
        responsibleUserId?: string | null;
        version?: SecretVersionSelector;
        required?: boolean;
        allowMissingOverride?: boolean;
      },
      context?: SecretConsumerContext,
    ): Promise<RuntimeSecretResolution | null> => {
      const responsibleUserId = input.responsibleUserId ?? context?.responsibleUserId ?? null;
      const definition = await resolveUserSecretDefinition(companyId, input);
      const optionalBinding = input.allowMissingOverride || input.required === false;
      if (definition.status !== "active") {
        if (optionalBinding) return null;
        throw unprocessable("User secret definition is not active");
      }
      if (!responsibleUserId?.trim()) {
        if (optionalBinding) return null;
        throw unprocessable("Responsible user is required for user secret resolution", {
          code: "responsible_user_missing",
        });
      }
      let declaration: typeof userSecretDeclarations.$inferSelect | null = null;
      if (context?.configPath) {
        declaration = await db
          .select()
          .from(userSecretDeclarations)
          .where(and(
            eq(userSecretDeclarations.companyId, companyId),
            eq(userSecretDeclarations.userSecretDefinitionId, definition.id),
            eq(userSecretDeclarations.targetType, context.consumerType),
            eq(userSecretDeclarations.targetId, context.consumerId),
            eq(userSecretDeclarations.configPath, context.configPath),
          ))
          .then((rows) => rows[0] ?? null);
        if (!declaration) {
          throw unprocessable(
            `User secret is not declared for ${context.consumerType}:${context.consumerId} at ${context.configPath}`,
            { code: "binding_missing" },
          );
        }
      }
      if (
        Array.isArray(context?.allowedBindingIds) &&
        (!declaration || !context.allowedBindingIds.includes(declaration.id))
      ) {
        throw unprocessable(
          "User secret declaration is outside the active low-trust boundary",
          { code: "binding_not_allowed" },
        );
      }
      const secret = await getUserSecretValue({
        companyId,
        ownerUserId: responsibleUserId,
        definitionId: definition.id,
      });
      if (!secret) {
        if (optionalBinding) return null;
        throw unprocessable("User secret value is not configured", {
          code: "user_secret_missing",
          definitionId: definition.id,
          responsibleUserId,
        });
      }
      const resolution = await resolveSecretValueInternal(
        companyId,
        secret.id,
        input.version ?? "latest",
        {
          accessContext: context ? { ...context, responsibleUserId } : undefined,
          allowUserSecretScope: true,
        },
      );
      return {
        ...resolution,
        manifestEntry: {
          ...resolution.manifestEntry,
          bindingId: declaration?.id ?? resolution.manifestEntry.bindingId ?? null,
        },
      };
    },

    previewRemoteImport: async (
      companyId: string,
      input: {
        providerConfigId: string;
        query?: string | null;
        nextToken?: string | null;
        pageSize?: number;
      },
    ) => {
      const { providerConfig, provider: providerId, runtimeConfig } = await getRemoteImportProviderConfig(
        companyId,
        input.providerConfigId,
      );
      const provider = getSecretProvider(providerId);
      if (!provider.listRemoteSecrets) {
        throw unprocessable(`${providerId} provider does not support remote import listing`);
      }
      let listed: RemoteSecretListResult;
      try {
        listed = await provider.listRemoteSecrets({
          providerConfig: runtimeConfig,
          query: input.query,
          nextToken: input.nextToken,
          pageSize: input.pageSize,
        });
      } catch (error) {
        throw remoteProviderHttpError(error, {
          companyId,
          provider: providerId,
          providerConfigId: providerConfig.id,
          operation: "remote_import.preview",
        });
      }
      const maps = await buildRemoteImportConflictMaps(companyId, providerId);
      const candidates: RemoteSecretImportCandidate[] = [];
      for (const remote of listed.secrets) {
        const externalRef = remote.externalRef.trim();
        const remoteName = remote.name.trim() || deriveSecretNameFromExternalRef(externalRef);
        const name = remoteName || deriveSecretNameFromExternalRef(externalRef);
        const key = normalizeSecretKey(name);
        let canonicalExternalRef = externalRef;
        const conflicts: RemoteSecretImportConflict[] = [];
        try {
          const prepared = await provider.linkExternalSecret({
            externalRef,
            providerVersionRef: remote.providerVersionRef ?? null,
            providerConfig: runtimeConfig,
            context: {
              companyId,
              secretKey: key || "remote-import-preview",
              secretName: name,
              version: 1,
            },
          });
          canonicalExternalRef = prepared.externalRef ?? externalRef;
        } catch (error) {
          conflicts.push({
            type: "provider_guardrail",
            message: remoteImportRowFailureReason(error, "Provider rejected this external reference", {
              companyId,
              provider: providerId,
              providerConfigId: providerConfig.id,
              operation: "remote_import.preview.link_external_reference",
            }),
          });
        }
        conflicts.push(...remoteImportConflictsFor({
          providerConfigId: providerConfig.id,
          externalRef: canonicalExternalRef,
          name,
          key,
          maps,
        }));
        const hasDuplicate = conflicts.some((conflict) => conflict.type === "exact_reference");
        const hasConflict = conflicts.length > 0;
        candidates.push({
          externalRef,
          remoteName,
          name,
          key,
          providerVersionRef: remote.providerVersionRef ?? null,
          providerMetadata: sanitizeRemoteProviderMetadata(providerId, remote.metadata),
          status: hasDuplicate ? "duplicate" : hasConflict ? "conflict" : "ready",
          importable: !hasConflict,
          conflicts,
        });
      }
      return {
        providerConfigId: providerConfig.id,
        provider: providerId,
        nextToken: listed.nextToken ?? null,
        candidates,
      };
    },

    importRemoteSecrets: async (
      companyId: string,
      input: {
        providerConfigId: string;
        secrets: Array<{
          externalRef: string;
          name?: string | null;
          key?: string | null;
          description?: string | null;
          providerVersionRef?: string | null;
          providerMetadata?: Record<string, unknown> | null;
        }>;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const { providerConfig, provider: providerId, runtimeConfig } = await getRemoteImportProviderConfig(
        companyId,
        input.providerConfigId,
      );
      const provider = getSecretProvider(providerId);
      if (provider.descriptor().supportsExternalReferences === false) {
        throw unprocessable(`${providerId} provider does not support linked external references`);
      }
      const maps = await buildRemoteImportConflictMaps(companyId, providerId);
      const results: RemoteSecretImportRowResult[] = [];

      for (const selection of input.secrets) {
        const externalRef = selection.externalRef.trim();
        const name = selection.name?.trim() || deriveSecretNameFromExternalRef(externalRef);
        const key = normalizeSecretKey(selection.key?.trim() || name);
        const description = selection.description?.trim() || null;
        let prepared: PreparedSecretVersion | undefined;
        const conflicts = remoteImportConflictsFor({
          providerConfigId: providerConfig.id,
          externalRef,
          name,
          key,
          maps,
        });
        if (!key) {
          results.push({
            externalRef,
            name,
            key,
            status: "error",
            reason: "Secret key is required",
            secretId: null,
            conflicts,
          });
          continue;
        }
        if (conflicts.length === 0) {
          try {
            prepared = await provider.linkExternalSecret({
              externalRef,
              providerVersionRef: selection.providerVersionRef ?? null,
              providerConfig: runtimeConfig,
              context: {
                companyId,
                secretKey: key,
                secretName: name,
                version: 1,
              },
            });
            const canonicalDuplicate = maps.byProviderConfigExternalRef.get(
              remoteImportExternalRefKey(providerConfig.id, prepared.externalRef ?? externalRef),
            );
            if (canonicalDuplicate) {
              conflicts.push({
                type: "exact_reference",
                existingSecretId: canonicalDuplicate.id,
                message: "An existing secret already links this exact provider reference.",
              });
            }
          } catch (error) {
            results.push({
              externalRef,
              name,
              key,
              status: "error",
              reason: remoteImportRowFailureReason(error, "Provider rejected this external reference", {
                companyId,
                provider: providerId,
                providerConfigId: providerConfig.id,
                operation: "remote_import.prepare_external_reference",
              }),
              secretId: null,
              conflicts: [],
            });
            continue;
          }
        }
        if (conflicts.length > 0) {
          results.push({
            externalRef,
            name,
            key,
            status: "skipped",
            reason: conflicts.some((conflict) => conflict.type === "exact_reference")
              ? "exact_reference_duplicate"
              : "name_or_key_conflict",
            secretId: null,
            conflicts,
          });
          continue;
        }

        try {
          if (!prepared) {
            prepared = await provider.linkExternalSecret({
              externalRef,
              providerVersionRef: selection.providerVersionRef ?? null,
              providerConfig: runtimeConfig,
              context: {
                companyId,
                secretKey: key,
                secretName: name,
                version: 1,
              },
            });
          }
          if (!prepared) {
            throw unprocessable("Provider rejected this external reference");
          }
          const preparedSecret = prepared;
          const secret = await db.transaction(async (tx) => {
            const inserted = await tx
              .insert(companySecrets)
              .values({
                companyId,
                key,
                name,
                provider: providerId,
                providerConfigId: providerConfig.id,
                status: "active",
                managedMode: "external_reference",
                externalRef: preparedSecret.externalRef,
                providerMetadata: null,
                latestVersion: 1,
                description,
                lastRotatedAt: new Date(),
                createdByAgentId: actor?.agentId ?? null,
                createdByUserId: actor?.userId ?? null,
              })
              .returning()
              .then((rows) => rows[0]);
            await tx.insert(companySecretVersions).values({
              secretId: inserted.id,
              version: 1,
              material: preparedSecret.material,
              valueSha256: preparedSecret.valueSha256,
              fingerprintSha256: preparedSecret.fingerprintSha256 ?? preparedSecret.valueSha256,
              providerVersionRef: preparedSecret.providerVersionRef ?? null,
              status: "current",
              createdByAgentId: actor?.agentId ?? null,
              createdByUserId: actor?.userId ?? null,
            });
            return inserted;
          });
          maps.byProviderConfigExternalRef.set(
            remoteImportExternalRefKey(providerConfig.id, preparedSecret.externalRef ?? externalRef),
            secret,
          );
          maps.byName.set(name, secret);
          maps.byKey.set(key, secret);
          results.push({
            externalRef,
            name,
            key,
            status: "imported",
            reason: null,
            secretId: secret.id,
            conflicts: [],
          });
        } catch (error) {
          results.push({
            externalRef,
            name,
            key,
            status: "error",
            reason: remoteImportRowFailureReason(error, "Import failed", {
              companyId,
              provider: providerId,
              providerConfigId: providerConfig.id,
              operation: "remote_import.commit",
            }),
            secretId: null,
            conflicts: [],
          });
        }
      }

      return {
        providerConfigId: providerConfig.id,
        provider: providerId,
        importedCount: results.filter((result) => result.status === "imported").length,
        skippedCount: results.filter((result) => result.status === "skipped").length,
        errorCount: results.filter((result) => result.status === "error").length,
        results,
      };
    },

    getById,
    getByName,
    resolveSecretValue,
    resolveSecretValueForEphemeralAccess,

    create: async (
      companyId: string,
      input: {
        name: string;
        provider: SecretProvider;
        providerConfigId?: string | null;
        value?: string | null;
        key?: string | null;
        managedMode?: "paperclip_managed" | "external_reference";
        description?: string | null;
        externalRef?: string | null;
        providerVersionRef?: string | null;
        providerMetadata?: Record<string, unknown> | null;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const existing = await getByName(companyId, input.name);
      if (existing) throw conflict(`Secret already exists: ${input.name}`);
      const key = normalizeSecretKey(input.key ?? input.name);
      if (!key) throw unprocessable("Secret key is required");
      const duplicateKey = await db
        .select()
        .from(companySecrets)
        .where(and(
          eq(companySecrets.companyId, companyId),
          eq(companySecrets.scope, "company"),
          eq(companySecrets.key, key),
          ne(companySecrets.status, "deleted"),
        ))
        .then((rows) => rows[0] ?? null);
      if (duplicateKey) throw conflict(`Secret key already exists: ${key}`);

      const managedMode = input.managedMode ?? "paperclip_managed";
      const provider = getSecretProvider(input.provider);
      const providerConfig = await getSelectableRuntimeProviderConfig({
        companyId,
        provider: input.provider,
        providerConfigId: input.providerConfigId,
      });
      if (managedMode === "external_reference" && !input.externalRef?.trim()) {
        throw unprocessable("External reference secrets require externalRef");
      }
      if (managedMode === "paperclip_managed" && input.externalRef?.trim()) {
        throw unprocessable("Managed secrets cannot override externalRef");
      }
      if (managedMode === "paperclip_managed" && !input.value?.trim()) {
        throw unprocessable("Managed secrets require value");
      }
      const providerWriteContext = {
        companyId,
        secretKey: key,
        secretName: input.name,
        version: 1,
      };
      const reservedSecret = await db
        .insert(companySecrets)
        .values({
          companyId,
          key,
          name: input.name,
          provider: input.provider,
          providerConfigId: input.providerConfigId ?? null,
          status: "archived",
          managedMode,
          externalRef: null,
          providerMetadata: input.providerMetadata ?? null,
          latestVersion: 0,
          description: input.description ?? null,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]);

      let prepared: PreparedSecretVersion;
      try {
        prepared =
          managedMode === "external_reference"
            ? await provider.linkExternalSecret({
                externalRef: input.externalRef ?? "",
                providerVersionRef: input.providerVersionRef ?? null,
                providerConfig,
                context: providerWriteContext,
              })
            : await provider.createSecret({
                value: input.value ?? "",
                externalRef: null,
                providerConfig,
                context: providerWriteContext,
              });
      } catch (error) {
        await db.delete(companySecrets).where(eq(companySecrets.id, reservedSecret.id)).catch(() => undefined);
        throw error;
      }

      try {
        await db
          .update(companySecrets)
          .set({
            externalRef: prepared.externalRef,
            latestVersion: 1,
            updatedAt: new Date(),
          })
          .where(eq(companySecrets.id, reservedSecret.id));
        await db.insert(companySecretVersions).values({
          secretId: reservedSecret.id,
          version: 1,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
          providerVersionRef: prepared.providerVersionRef ?? null,
          status: "disabled",
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });
      } catch (error) {
        if (managedMode === "paperclip_managed") {
          const cleaned = await cleanupPreparedProviderWrite({
            provider,
            prepared,
            providerConfig,
            context: providerWriteContext,
            mode: "delete",
            operation: "create.prepare_rollback",
          });
          if (cleaned) {
            await db.delete(companySecretVersions).where(eq(companySecretVersions.secretId, reservedSecret.id)).catch(() => undefined);
            await db.delete(companySecrets).where(eq(companySecrets.id, reservedSecret.id)).catch(() => undefined);
          }
        } else {
          await db.delete(companySecretVersions).where(eq(companySecretVersions.secretId, reservedSecret.id)).catch(() => undefined);
          await db.delete(companySecrets).where(eq(companySecrets.id, reservedSecret.id)).catch(() => undefined);
        }
        throw error;
      }

      try {
        return await db.transaction(async (tx) => {
          await tx
            .update(companySecretVersions)
            .set({ status: "current" })
            .where(and(
              eq(companySecretVersions.secretId, reservedSecret.id),
              eq(companySecretVersions.version, 1),
            ));

          const secret = await tx
            .update(companySecrets)
            .set({
              status: "active",
              externalRef: prepared.externalRef,
              latestVersion: 1,
              lastRotatedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(companySecrets.id, reservedSecret.id))
            .returning()
            .then((rows) => rows[0]);

          if (!secret) throw notFound("Secret not found");
          return secret;
        });
      } catch (error) {
        if (managedMode === "paperclip_managed") {
          const cleaned = await cleanupPreparedProviderWrite({
            provider,
            prepared,
            providerConfig,
            context: providerWriteContext,
            mode: "delete",
            operation: "create.rollback",
          });
          if (cleaned) {
            await db.delete(companySecretVersions).where(eq(companySecretVersions.secretId, reservedSecret.id)).catch(() => undefined);
            await db.delete(companySecrets).where(eq(companySecrets.id, reservedSecret.id)).catch(() => undefined);
          }
        } else {
          await db.delete(companySecretVersions).where(eq(companySecretVersions.secretId, reservedSecret.id)).catch(() => undefined);
          await db.delete(companySecrets).where(eq(companySecrets.id, reservedSecret.id)).catch(() => undefined);
        }
        throw error;
      }
    },

    rotate: async (
      secretId: string,
      input: {
        value?: string | null;
        externalRef?: string | null;
        providerVersionRef?: string | null;
        providerConfigId?: string | null;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");
      if (secret.status !== "active") throw unprocessable("Cannot rotate a non-active secret");
      const providerId = secret.provider as SecretProvider;
      const provider = getSecretProvider(providerId);
      const providerConfigId =
        input.providerConfigId === undefined ? secret.providerConfigId : input.providerConfigId;
      const providerConfig = await getSelectableRuntimeProviderConfig({
        companyId: secret.companyId,
        provider: providerId,
        providerConfigId,
      });
      const nextVersion = secret.latestVersion + 1;
      if (secret.managedMode === "external_reference" && !(input.externalRef ?? secret.externalRef)?.trim()) {
        throw unprocessable("External reference secrets require externalRef");
      }
      if (secret.managedMode !== "external_reference" && input.externalRef?.trim()) {
        throw unprocessable("Managed secrets cannot override externalRef");
      }
      if (secret.managedMode !== "external_reference" && !input.value?.trim()) {
        throw unprocessable("Managed secrets require value");
      }
      const providerWriteContext = {
        companyId: secret.companyId,
        secretKey: secret.key,
        secretName: secret.name,
        version: nextVersion,
      };
      const prepared =
        secret.managedMode === "external_reference"
          ? await provider.linkExternalSecret({
              externalRef: input.externalRef ?? secret.externalRef ?? "",
              providerVersionRef: input.providerVersionRef ?? null,
              providerConfig,
              context: providerWriteContext,
            })
          : await provider.createVersion({
              value: input.value ?? "",
              externalRef: secret.externalRef ?? null,
              providerConfig,
              context: providerWriteContext,
            });

      try {
        await db.insert(companySecretVersions).values({
          secretId: secret.id,
          version: nextVersion,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
          providerVersionRef: prepared.providerVersionRef ?? null,
          status: "disabled",
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });
      } catch (error) {
        if (secret.managedMode !== "external_reference") {
          await cleanupPreparedProviderWrite({
            provider,
            prepared,
            providerConfig,
            context: providerWriteContext,
            mode: "archive",
            operation: "rotate.prepare_rollback",
          });
        }
        throw error;
      }

      try {
        return await db.transaction(async (tx) => {
          await tx
            .update(companySecretVersions)
            .set({ status: "previous" })
            .where(and(
              eq(companySecretVersions.secretId, secret.id),
              ne(companySecretVersions.version, nextVersion),
            ));
          await tx
            .update(companySecretVersions)
            .set({ status: "current" })
            .where(and(
              eq(companySecretVersions.secretId, secret.id),
              eq(companySecretVersions.version, nextVersion),
            ));

          const updated = await tx
            .update(companySecrets)
            .set({
              latestVersion: nextVersion,
              externalRef: prepared.externalRef,
              providerConfigId,
              lastRotatedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(companySecrets.id, secret.id))
            .returning()
            .then((rows) => rows[0] ?? null);

          if (!updated) throw notFound("Secret not found");
          return updated;
        });
      } catch (error) {
        if (secret.managedMode !== "external_reference") {
          const cleaned = await cleanupPreparedProviderWrite({
            provider,
            prepared,
            providerConfig,
            context: providerWriteContext,
            mode: "archive",
            operation: "rotate.rollback",
          });
          if (cleaned) {
            await db
              .delete(companySecretVersions)
              .where(and(
                eq(companySecretVersions.secretId, secret.id),
                eq(companySecretVersions.version, nextVersion),
              ))
              .catch(() => undefined);
          }
        }
        throw error;
      }
    },

    update: async (
      secretId: string,
      patch: {
        name?: string;
        key?: string;
        status?: "active" | "disabled" | "archived" | "deleted";
        providerConfigId?: string | null;
        description?: string | null;
        externalRef?: string | null;
        providerMetadata?: Record<string, unknown> | null;
      },
    ) => {
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");
      if (secret.status === "deleted") throw notFound("Secret not found");

      if (patch.name && patch.name !== secret.name) {
        const duplicate = await getByName(secret.companyId, patch.name);
        if (duplicate && duplicate.id !== secret.id) {
          throw conflict(`Secret already exists: ${patch.name}`);
        }
      }
      const nextKey = patch.key ? normalizeSecretKey(patch.key) : secret.key;
      if (!nextKey) throw unprocessable("Secret key is required");
      if (nextKey !== secret.key) {
        const duplicateKey = await db
          .select()
          .from(companySecrets)
          .where(and(
            eq(companySecrets.companyId, secret.companyId),
            eq(companySecrets.scope, "company"),
            eq(companySecrets.key, nextKey),
            ne(companySecrets.status, "deleted"),
          ))
          .then((rows) => rows[0] ?? null);
        if (duplicateKey && duplicateKey.id !== secret.id) {
          throw conflict(`Secret key already exists: ${nextKey}`);
        }
      }
      const deleting = patch.status === "deleted";
      if (deleting && secret.managedMode === "paperclip_managed") {
        throw unprocessable("Managed secrets must be deleted through DELETE /secrets/:id");
      }
      if (secret.managedMode !== "external_reference" && patch.externalRef !== undefined) {
        throw unprocessable("Managed secrets cannot override externalRef");
      }
      if (
        secret.managedMode === "external_reference" &&
        patch.externalRef !== undefined &&
        patch.externalRef !== secret.externalRef
      ) {
        throw unprocessable(
          "External reference secrets cannot be retargeted through generic update",
        );
      }
      if (
        secret.managedMode === "external_reference" &&
        patch.providerConfigId !== undefined &&
        patch.providerConfigId !== secret.providerConfigId
      ) {
        throw unprocessable(
          "External reference secrets cannot change provider vault through generic update",
        );
      }
      if (
        secret.managedMode === "paperclip_managed" &&
        patch.providerConfigId !== undefined &&
        patch.providerConfigId !== secret.providerConfigId
      ) {
        throw unprocessable(
          "Managed secrets cannot change provider vault through PATCH; use rotate() to migrate to a new vault",
        );
      }
      if (patch.providerConfigId !== undefined) {
        await assertProviderConfigForSecret(
          secret.companyId,
          secret.provider as SecretProvider,
          patch.providerConfigId,
        );
      }

      return db
        .update(companySecrets)
        .set({
          key: deleting ? `${secret.key}__deleted__${secret.id}` : nextKey,
          name: deleting ? `${secret.name}__deleted__${secret.id}` : patch.name ?? secret.name,
          status: patch.status ?? secret.status,
          providerConfigId:
            patch.providerConfigId === undefined ? secret.providerConfigId : patch.providerConfigId,
          description:
            patch.description === undefined ? secret.description : patch.description,
          externalRef:
            patch.externalRef === undefined ? secret.externalRef : patch.externalRef,
          providerMetadata:
            patch.providerMetadata === undefined ? secret.providerMetadata : patch.providerMetadata,
          deletedAt: deleting ? new Date() : secret.deletedAt,
          updatedAt: new Date(),
        })
        .where(eq(companySecrets.id, secret.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    createBinding: async (input: {
      companyId: string;
      secretId: string;
      targetType: SecretBindingTargetType;
      targetId: string;
      configPath: string;
      versionSelector?: SecretVersionSelector;
      required?: boolean;
      label?: string | null;
    }) => {
      await assertSecretInCompany(input.companyId, input.secretId);
      const existing = await db
        .select()
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.companyId, input.companyId),
            eq(companySecretBindings.targetType, input.targetType),
            eq(companySecretBindings.targetId, input.targetId),
            eq(companySecretBindings.configPath, input.configPath),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existing) throw conflict(`Secret binding already exists at ${input.configPath}`);
      return db
        .insert(companySecretBindings)
        .values({
          companyId: input.companyId,
          secretId: input.secretId,
          targetType: input.targetType,
          targetId: input.targetId,
          configPath: input.configPath,
          versionSelector: String(input.versionSelector ?? "latest"),
          required: input.required ?? true,
          label: input.label ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    syncSecretRefsForTarget: async (
      companyId: string,
      target: { targetType: SecretBindingTargetType; targetId: string },
      refs: Array<{
        secretId: string;
        configPath: string;
        versionSelector?: SecretVersionSelector;
        required?: boolean;
        label?: string | null;
      }>,
      options?: { replaceAll?: boolean },
    ) => {
      const normalizedRefs: Array<{
        secretId: string;
        configPath: string;
        versionSelector: SecretVersionSelector;
        required: boolean;
        label: string | null;
      }> = [];
      for (const ref of refs) {
        await assertSecretInCompany(companyId, ref.secretId);
        normalizedRefs.push({
          secretId: ref.secretId,
          configPath: ref.configPath,
          versionSelector: ref.versionSelector ?? "latest",
          required: ref.required ?? true,
          label: ref.label ?? null,
        });
      }

      const pathPrefixes = [...new Set(normalizedRefs.map((ref) => ref.configPath.split(".")[0]))];

      await db.transaction(async (tx) => {
        if (options?.replaceAll) {
          await tx
            .delete(companySecretBindings)
            .where(
              and(
                eq(companySecretBindings.companyId, companyId),
                eq(companySecretBindings.targetType, target.targetType),
                eq(companySecretBindings.targetId, target.targetId),
              ),
            );
        } else if (pathPrefixes.length > 0) {
          for (const pathPrefix of pathPrefixes) {
            await tx
              .delete(companySecretBindings)
              .where(
                and(
                  eq(companySecretBindings.companyId, companyId),
                  eq(companySecretBindings.targetType, target.targetType),
                  eq(companySecretBindings.targetId, target.targetId),
                  or(
                    eq(companySecretBindings.configPath, pathPrefix),
                    like(companySecretBindings.configPath, `${pathPrefix}.%`),
                  ),
                ),
              );
          }
        } else {
          await tx
            .delete(companySecretBindings)
            .where(
              and(
                eq(companySecretBindings.companyId, companyId),
                eq(companySecretBindings.targetType, target.targetType),
                eq(companySecretBindings.targetId, target.targetId),
              ),
            );
        }
        if (normalizedRefs.length === 0) return;
        await tx.insert(companySecretBindings).values(
          normalizedRefs.map((ref) => ({
            companyId,
            secretId: ref.secretId,
            targetType: target.targetType,
            targetId: target.targetId,
            configPath: ref.configPath,
            versionSelector: String(ref.versionSelector),
            required: ref.required,
            label: ref.label,
          })),
        );
      });
      return normalizedRefs;
    },

    listBindingCompanyIdsForTarget: async (
      target: { targetType: SecretBindingTargetType; targetId: string },
    ): Promise<string[]> =>
      db
        .select({ companyId: companySecretBindings.companyId })
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.targetType, target.targetType),
            eq(companySecretBindings.targetId, target.targetId),
          ),
        )
        .then((rows) => [...new Set(rows.map((row) => row.companyId))]),

    syncEnvBindingsForTarget: async (
      companyId: string,
      target: { targetType: SecretBindingTargetType; targetId: string; pathPrefix?: string },
      envValue: unknown,
      options?: { db?: SecretBindingDb },
    ) => {
      const record = asRecord(envValue) ?? {};
      const refs: Array<{
        secretId: string;
        configPath: string;
        versionSelector: SecretVersionSelector;
      }> = [];
      const userRefs: Array<{
        definitionKey: string;
        configPath: string;
        envKey: string;
        versionSelector: SecretVersionSelector;
        required: boolean;
        allowMissingOverride: boolean;
      }> = [];
      const pathPrefix = target.pathPrefix ?? "env";
      const bindingDb = options?.db ?? db;
      for (const [key, rawBinding] of Object.entries(record)) {
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) continue;
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type === "user_secret_ref") {
          await resolveUserSecretDefinition(companyId, { definitionKey: binding.key }, bindingDb);
          userRefs.push({
            definitionKey: binding.key,
            configPath: `${pathPrefix}.${key}`,
            envKey: key,
            versionSelector: binding.version,
            required: binding.required,
            allowMissingOverride: binding.allowMissingOverride,
          });
          continue;
        }
        if (binding.type !== "secret_ref") continue;
        await assertSecretInCompany(companyId, binding.secretId, bindingDb);
        refs.push({
          secretId: binding.secretId,
          configPath: `${pathPrefix}.${key}`,
          versionSelector: binding.version,
        });
      }

      const writeBindings = async (targetDb: SecretBindingDb) => {
        await targetDb
          .delete(companySecretBindings)
          .where(
            and(
              eq(companySecretBindings.companyId, companyId),
              eq(companySecretBindings.targetType, target.targetType),
              eq(companySecretBindings.targetId, target.targetId),
              like(companySecretBindings.configPath, `${pathPrefix}.%`),
            ),
          );
        if (refs.length === 0) return;
        await targetDb.insert(companySecretBindings).values(
          refs.map((ref) => ({
            companyId,
            secretId: ref.secretId,
            targetType: target.targetType,
            targetId: target.targetId,
            configPath: ref.configPath,
            versionSelector: String(ref.versionSelector),
            required: true,
          })),
          );
      };

      const writeUserDeclarations = async (targetDb: SecretBindingDb) => {
        await targetDb
          .delete(userSecretDeclarations)
          .where(
            and(
              eq(userSecretDeclarations.companyId, companyId),
              eq(userSecretDeclarations.targetType, target.targetType),
              eq(userSecretDeclarations.targetId, target.targetId),
              like(userSecretDeclarations.configPath, `${pathPrefix}.%`),
            ),
          );
        if (userRefs.length === 0) return;
        const definitions = new Map<string, string>();
        for (const ref of userRefs) {
          const definition = await resolveUserSecretDefinition(companyId, { definitionKey: ref.definitionKey }, targetDb);
          definitions.set(ref.definitionKey, definition.id);
        }
        await targetDb.insert(userSecretDeclarations).values(
          userRefs.map((ref) => ({
            companyId,
            userSecretDefinitionId: definitions.get(ref.definitionKey)!,
            targetType: target.targetType,
            targetId: target.targetId,
            configPath: ref.configPath,
            envKey: ref.envKey,
            versionSelector: String(ref.versionSelector),
            required: ref.required,
            allowMissingOverride: ref.allowMissingOverride,
          })),
        );
      };

      if (options?.db) {
        await writeBindings(options.db);
        await writeUserDeclarations(options.db);
      } else {
        await db.transaction(async (tx) => {
          await writeBindings(tx);
          await writeUserDeclarations(tx);
        });
      }
      return refs;
    },

    remove: async (secretId: string) => {
      const secret = await getById(secretId);
      if (!secret) return null;
      const versionRow = await getSecretVersion(secret.id, secret.latestVersion);
      const providerId = secret.provider as SecretProvider;
      const provider = getSecretProvider(providerId);
      if (secret.status !== "deleted") {
        await db
          .update(companySecrets)
          .set({
            key: `${secret.key}__deleted__${secret.id}`,
            name: `${secret.name}__deleted__${secret.id}`,
            status: "deleted",
            deletedAt: secret.deletedAt ?? new Date(),
            updatedAt: new Date(),
          })
          .where(eq(companySecrets.id, secretId));
      }
      const providerConfig = secret.providerConfigId
        ? await getProviderConfigById(secret.providerConfigId)
        : null;
      const providerRuntimeConfig =
        providerConfig && providerConfig.status !== "disabled" && providerConfig.status !== "coming_soon"
          ? toProviderVaultRuntimeConfig(providerConfig)
          : null;
      if (!secret.providerConfigId || providerRuntimeConfig) {
        try {
          await provider.deleteOrArchive({
            material: versionRow?.material as Record<string, unknown> | undefined,
            externalRef: secret.externalRef,
            providerConfig: providerRuntimeConfig,
            context: {
              companyId: secret.companyId,
              secretKey: secret.key,
              secretName: secret.name,
              version: secret.latestVersion,
            },
            mode: "delete",
          });
        } catch (error) {
          if (!isSecretProviderClientError(error) || error.code !== "not_found") {
            throw error;
          }
        }
      }
      await db.delete(companySecrets).where(eq(companySecrets.id, secretId));
      return secret;
    },

    normalizeAdapterConfigForPersistence: async (
      companyId: string,
      adapterConfig: Record<string, unknown>,
      opts?: NormalizeAdapterConfigOptions,
    ) => normalizeAdapterConfigForPersistenceInternal(companyId, adapterConfig, opts),

    normalizeEnvBindingsForPersistence: async (
      companyId: string,
      envValue: unknown,
      opts?: NormalizeEnvOptions,
    ) => normalizeEnvConfig(companyId, envValue, opts),

    normalizeHireApprovalPayloadForPersistence: async (
      companyId: string,
      payload: Record<string, unknown>,
      opts?: NormalizeAdapterConfigOptions,
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

    resolveEnvBindings: async (
      companyId: string,
      envValue: unknown,
      context?: Omit<SecretConsumerContext, "configPath">,
    ): Promise<{ env: Record<string, string>; secretKeys: Set<string>; manifest: RuntimeSecretManifestEntry[] }> => {
      const record = asRecord(envValue);
      if (!record) return { env: {} as Record<string, string>, secretKeys: new Set<string>(), manifest: [] };
      const resolved: Record<string, string> = {};
      const secretKeys = new Set<string>();
      const manifest: RuntimeSecretManifestEntry[] = [];

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
        } else if (binding.type === "secret_ref") {
          const secretResolution = await resolveSecretValueInternal(
            companyId,
            binding.secretId,
            binding.version,
            context
              ? {
                  bindingContext: { ...context, configPath: `env.${key}` },
                  accessContext: { ...context, configPath: `env.${key}` },
                }
              : undefined,
          );
          resolved[key] = secretResolution.value;
          manifest.push(secretResolution.manifestEntry);
          secretKeys.add(key);
        } else {
          const secretResolution = await secretService(db).resolveUserSecretValue(
            companyId,
            {
              definitionKey: binding.key,
              version: binding.version,
              required: binding.required,
              allowMissingOverride: binding.allowMissingOverride,
            },
            context
              ? {
                  ...context,
                  configPath: `env.${key}`,
                  responsibleUserId: context.responsibleUserId ?? null,
                }
              : undefined,
          );
          if (secretResolution) {
            resolved[key] = secretResolution.value;
            manifest.push(secretResolution.manifestEntry);
            secretKeys.add(key);
          }
        }
      }
      return { env: resolved, secretKeys, manifest };
    },

    // Pre-dispatch validation: list declared secret refs in an env-like config
    // that have no binding for the given consumer, WITHOUT resolving any secret
    // values. Callers use this to surface a configuration-incomplete blocker
    // before a run is dispatched instead of letting resolution throw mid-setup.
    collectMissingRuntimeBindings: async (
      companyId: string,
      envValue: unknown,
      context: Omit<SecretConsumerContext, "configPath">,
    ): Promise<MissingRuntimeBinding[]> => {
      const record = asRecord(envValue);
      if (!record) return [];
      const secretRefs = Object.entries(record).flatMap(([key, rawBinding]) => {
        if (!ENV_KEY_RE.test(key)) return [];
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) return [];
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type !== "secret_ref") return [];
        return [{ key, configPath: `env.${key}`, secretId: binding.secretId }];
      });
      const userSecretRefs = Object.entries(record).flatMap(([key, rawBinding]) => {
        if (!ENV_KEY_RE.test(key)) return [];
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) return [];
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type !== "user_secret_ref") return [];
        if (!binding.required || binding.allowMissingOverride) return [];
        return [{ key, configPath: `env.${key}`, binding }];
      });
      if (secretRefs.length === 0 && userSecretRefs.length === 0) return [];

      const bindingChecks = await Promise.all(secretRefs.map(async (entry) => ({
        entry,
        found: await getBinding({
          companyId,
          secretId: entry.secretId,
          consumerType: context.consumerType,
          consumerId: context.consumerId,
          configPath: entry.configPath,
        }),
      })));
      const missingEntries = bindingChecks
        .filter((check) => !check.found)
        .map((check) => check.entry);

      const secretRows = await Promise.all(
        [...new Set(missingEntries.map((entry) => entry.secretId))].map(async (secretId) => [
          secretId,
          await getById(secretId).catch(() => null),
        ] as const),
      );
      const secretsById = new Map(secretRows);

      const missingSecretBindings: MissingRuntimeBinding[] = missingEntries.map((entry) => ({
          consumerType: context.consumerType,
          consumerId: context.consumerId,
          configPath: entry.configPath,
          envKey: entry.key,
          bindingType: "secret_ref",
          secretId: entry.secretId,
          secretName: secretsById.get(entry.secretId)?.name ?? null,
        }));

      const missingUserSecretBindings: MissingRuntimeBinding[] = [];
      for (const entry of userSecretRefs) {
        let definition: typeof userSecretDefinitions.$inferSelect | null = null;
        try {
          definition = await resolveUserSecretDefinition(companyId, { definitionKey: entry.binding.key });
        } catch {
          missingUserSecretBindings.push({
            consumerType: context.consumerType,
            consumerId: context.consumerId,
            configPath: entry.configPath,
            envKey: entry.key,
            bindingType: "user_secret_ref",
            secretId: null,
            secretName: null,
            userSecretDefinitionKey: entry.binding.key,
            responsibleUserId: context.responsibleUserId ?? null,
            errorCode: "user_secret_definition_missing",
          });
          continue;
        }

        const declaration = await db
          .select()
          .from(userSecretDeclarations)
          .where(and(
            eq(userSecretDeclarations.companyId, companyId),
            eq(userSecretDeclarations.userSecretDefinitionId, definition.id),
            eq(userSecretDeclarations.targetType, context.consumerType),
            eq(userSecretDeclarations.targetId, context.consumerId),
            eq(userSecretDeclarations.configPath, entry.configPath),
          ))
          .then((rows) => rows[0] ?? null);
        if (!declaration) {
          missingUserSecretBindings.push({
            consumerType: context.consumerType,
            consumerId: context.consumerId,
            configPath: entry.configPath,
            envKey: entry.key,
            bindingType: "user_secret_ref",
            secretId: null,
            secretName: null,
            userSecretDefinitionId: definition.id,
            userSecretDefinitionKey: definition.key,
            userSecretDefinitionName: definition.name,
            responsibleUserId: context.responsibleUserId ?? null,
            errorCode: "binding_missing",
          });
          continue;
        }

        if (!context.responsibleUserId?.trim()) {
          missingUserSecretBindings.push({
            consumerType: context.consumerType,
            consumerId: context.consumerId,
            configPath: entry.configPath,
            envKey: entry.key,
            bindingType: "user_secret_ref",
            secretId: null,
            secretName: null,
            userSecretDefinitionId: definition.id,
            userSecretDefinitionKey: definition.key,
            userSecretDefinitionName: definition.name,
            responsibleUserId: null,
            errorCode: "responsible_user_missing",
          });
          continue;
        }

        const secret = await getUserSecretValue({
          companyId,
          ownerUserId: context.responsibleUserId,
          definitionId: definition.id,
        });
        if (!secret || secret.status !== "active") {
          missingUserSecretBindings.push({
            consumerType: context.consumerType,
            consumerId: context.consumerId,
            configPath: entry.configPath,
            envKey: entry.key,
            bindingType: "user_secret_ref",
            secretId: secret?.id ?? null,
            secretName: null,
            userSecretDefinitionId: definition.id,
            userSecretDefinitionKey: definition.key,
            userSecretDefinitionName: definition.name,
            responsibleUserId: context.responsibleUserId,
            errorCode: secret ? "secret_inactive" : "user_secret_missing",
          });
        }
      }

      return [...missingSecretBindings, ...missingUserSecretBindings];
    },

    collectMissingAdapterConfigRuntimeBindings: async (
      companyId: string,
      adapterConfig: Record<string, unknown>,
      adapterType: string | null | undefined,
      context: Omit<SecretConsumerContext, "configPath">,
    ): Promise<MissingRuntimeBinding[]> => {
      const secretFieldKeys = await listAdapterSchemaSecretFieldKeys(adapterType);
      const secretRefs = secretFieldKeys.flatMap((key) => {
        const parsed = envBindingSchema.safeParse(adapterConfig[key]);
        if (!parsed.success) return [];
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type !== "secret_ref") return [];
        return [{ key, configPath: key, secretId: binding.secretId }];
      });
      const userSecretRefs = secretFieldKeys.flatMap((key) => {
        const parsed = envBindingSchema.safeParse(adapterConfig[key]);
        if (!parsed.success) return [];
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type !== "user_secret_ref") return [];
        if (!binding.required || binding.allowMissingOverride) return [];
        return [{ key, configPath: key, binding }];
      });
      if (secretRefs.length === 0 && userSecretRefs.length === 0) return [];

      const bindingChecks = await Promise.all(secretRefs.map(async (entry) => ({
        entry,
        found: await getBinding({
          companyId,
          secretId: entry.secretId,
          consumerType: context.consumerType,
          consumerId: context.consumerId,
          configPath: entry.configPath,
        }),
      })));
      const missingEntries = bindingChecks
        .filter((check) => !check.found)
        .map((check) => check.entry);

      const secretRows = await Promise.all(
        [...new Set(missingEntries.map((entry) => entry.secretId))].map(async (secretId) => [
          secretId,
          await getById(secretId).catch(() => null),
        ] as const),
      );
      const secretsById = new Map(secretRows);

      const missingSecretBindings: MissingRuntimeBinding[] = missingEntries.map((entry) => ({
        consumerType: context.consumerType,
        consumerId: context.consumerId,
        configPath: entry.configPath,
        envKey: entry.key,
        bindingType: "secret_ref",
        secretId: entry.secretId,
        secretName: secretsById.get(entry.secretId)?.name ?? null,
      }));

      const missingUserSecretBindings: MissingRuntimeBinding[] = [];
      for (const entry of userSecretRefs) {
        let definition: typeof userSecretDefinitions.$inferSelect | null = null;
        try {
          definition = await resolveUserSecretDefinition(companyId, { definitionKey: entry.binding.key });
        } catch {
          missingUserSecretBindings.push({
            consumerType: context.consumerType,
            consumerId: context.consumerId,
            configPath: entry.configPath,
            envKey: entry.key,
            bindingType: "user_secret_ref",
            secretId: null,
            secretName: null,
            userSecretDefinitionKey: entry.binding.key,
            responsibleUserId: context.responsibleUserId ?? null,
            errorCode: "user_secret_definition_missing",
          });
          continue;
        }

        const declaration = await db
          .select()
          .from(userSecretDeclarations)
          .where(and(
            eq(userSecretDeclarations.companyId, companyId),
            eq(userSecretDeclarations.userSecretDefinitionId, definition.id),
            eq(userSecretDeclarations.targetType, context.consumerType),
            eq(userSecretDeclarations.targetId, context.consumerId),
            eq(userSecretDeclarations.configPath, entry.configPath),
          ))
          .then((rows) => rows[0] ?? null);
        if (!declaration) {
          missingUserSecretBindings.push({
            consumerType: context.consumerType,
            consumerId: context.consumerId,
            configPath: entry.configPath,
            envKey: entry.key,
            bindingType: "user_secret_ref",
            secretId: null,
            secretName: null,
            userSecretDefinitionId: definition.id,
            userSecretDefinitionKey: definition.key,
            userSecretDefinitionName: definition.name,
            responsibleUserId: context.responsibleUserId ?? null,
            errorCode: "binding_missing",
          });
          continue;
        }

        if (!context.responsibleUserId?.trim()) {
          missingUserSecretBindings.push({
            consumerType: context.consumerType,
            consumerId: context.consumerId,
            configPath: entry.configPath,
            envKey: entry.key,
            bindingType: "user_secret_ref",
            secretId: null,
            secretName: null,
            userSecretDefinitionId: definition.id,
            userSecretDefinitionKey: definition.key,
            userSecretDefinitionName: definition.name,
            responsibleUserId: null,
            errorCode: "responsible_user_missing",
          });
          continue;
        }

        const secret = await getUserSecretValue({
          companyId,
          ownerUserId: context.responsibleUserId,
          definitionId: definition.id,
        });
        if (!secret || secret.status !== "active") {
          missingUserSecretBindings.push({
            consumerType: context.consumerType,
            consumerId: context.consumerId,
            configPath: entry.configPath,
            envKey: entry.key,
            bindingType: "user_secret_ref",
            secretId: secret?.id ?? null,
            secretName: null,
            userSecretDefinitionId: definition.id,
            userSecretDefinitionKey: definition.key,
            userSecretDefinitionName: definition.name,
            responsibleUserId: context.responsibleUserId,
            errorCode: secret ? "secret_inactive" : "user_secret_missing",
          });
        }
      }

      return [...missingSecretBindings, ...missingUserSecretBindings];
    },

    resolveAdapterConfigForRuntime: async (
      companyId: string,
      adapterConfig: Record<string, unknown>,
      context?: Omit<SecretConsumerContext, "configPath">,
      opts?: { adapterType?: string | null },
    ): Promise<{ config: Record<string, unknown>; secretKeys: Set<string>; manifest: RuntimeSecretManifestEntry[] }> => {
      const resolved = { ...adapterConfig };
      const secretKeys = new Set<string>();
      const manifest: RuntimeSecretManifestEntry[] = [];
      if (Object.prototype.hasOwnProperty.call(adapterConfig, "env")) {
        const record = asRecord(adapterConfig.env);
        if (!record) {
          resolved.env = {};
        } else {
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
            } else if (binding.type === "secret_ref") {
              const secretResolution = await resolveSecretValueInternal(
                companyId,
                binding.secretId,
                binding.version,
                context
                  ? {
                      bindingContext: { ...context, configPath: `env.${key}` },
                      accessContext: { ...context, configPath: `env.${key}` },
                    }
                  : undefined,
              );
              env[key] = secretResolution.value;
              manifest.push(secretResolution.manifestEntry);
              secretKeys.add(key);
            } else {
              const secretResolution = await secretService(db).resolveUserSecretValue(
                companyId,
                {
                  definitionKey: binding.key,
                  version: binding.version,
                  required: binding.required,
                  allowMissingOverride: binding.allowMissingOverride,
                },
                context
                  ? {
                      ...context,
                      configPath: `env.${key}`,
                      responsibleUserId: context.responsibleUserId ?? null,
                    }
                  : undefined,
              );
              if (secretResolution) {
                env[key] = secretResolution.value;
                manifest.push(secretResolution.manifestEntry);
                secretKeys.add(key);
              }
            }
          }
          resolved.env = env;
        }
      }
      const secretFieldKeys = await listAdapterSchemaSecretFieldKeys(opts?.adapterType);
      for (const key of secretFieldKeys) {
        const parsed = envBindingSchema.safeParse(adapterConfig[key]);
        if (!parsed.success) continue;
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type === "plain") continue;
        if (binding.type === "user_secret_ref") {
          const secretResolution = await secretService(db).resolveUserSecretValue(
            companyId,
            {
              definitionKey: binding.key,
              version: binding.version,
              required: binding.required,
              allowMissingOverride: binding.allowMissingOverride,
            },
            context
              ? {
                  ...context,
                  configPath: key,
                  responsibleUserId: context.responsibleUserId ?? null,
                }
              : undefined,
          );
          if (secretResolution) {
            resolved[key] = secretResolution.value;
            manifest.push(secretResolution.manifestEntry);
            secretKeys.add(key);
          }
          continue;
        }
        const secretResolution = await resolveSecretValueInternal(
          companyId,
          binding.secretId,
          binding.version,
          context
            ? {
                bindingContext: { ...context, configPath: key },
                accessContext: { ...context, configPath: key },
              }
            : undefined,
        );
        resolved[key] = secretResolution.value;
        manifest.push(secretResolution.manifestEntry);
        secretKeys.add(key);
      }
      return { config: resolved, secretKeys, manifest };
    },
  };
}
