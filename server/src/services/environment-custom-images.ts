import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  environmentCustomImageSetupSessions,
  environmentCustomImageTemplates,
} from "@paperclipai/db";
import {
  ENVIRONMENT_CUSTOM_IMAGE_SETUP_CONNECTION_TYPES,
  ENVIRONMENT_CUSTOM_IMAGE_SETUP_SESSION_STATUSES,
  type Environment,
  type EnvironmentCustomImageSetupConnectionSummary,
  type EnvironmentCustomImageSetupSession,
  type EnvironmentCustomImageSetupSessionStatus,
  type EnvironmentCustomImageTemplate,
  type EnvironmentCustomImageTemplateKind,
  type SandboxEnvironmentConfig,
  redactEnvironmentCustomImageValue,
} from "@paperclipai/shared";
import type {
  PluginEnvironmentCancelInteractiveSetupResult,
  PluginEnvironmentCaptureTemplateResult,
  PluginEnvironmentInteractiveSetupConnectionPayload,
  PluginEnvironmentInteractiveSetupSession,
  PluginEnvironmentTemplateRefKind,
} from "@paperclipai/plugin-sdk";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  parseEnvironmentDriverConfig,
  resolveEnvironmentDriverConfigForRuntime,
  resolveSandboxProviderSecretRefPaths,
  stripSandboxProviderEnvelope,
} from "./environment-config.js";
import { secretService } from "./secrets.js";
import {
  resolvePluginExecuteRpcTimeoutMs,
  resolvePluginSandboxProviderDriverByKey,
} from "./plugin-environment-driver.js";
import { environmentService } from "./environments.js";
import {
  ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS,
  classifyEnvironmentCustomImageConfigChange,
  fingerprintEnvironmentSandboxProviderConfig,
  ENVIRONMENT_CUSTOM_IMAGE_RUNTIME_CONFIG_BINDING_METADATA_KEY,
  defaultEnvironmentCustomImageRuntimeConfigBinding,
  environmentCustomImageTemplateMatchesBaseConfig,
  normalizeEnvironmentCustomImageRuntimeConfigBinding,
  environmentCustomImageTemplateFromRow,
  readEnvironmentCustomImageTemplateKind as readTemplateKind,
} from "./environment-custom-image-runtime.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

const ACTIVE_SETUP_STATUSES = ["starting", "waiting_for_user", "capturing"] as const;
const DEFAULT_SETUP_TTL_SECONDS = 60 * 60;
const DEFAULT_CONNECTION_EXPIRES_IN_MINUTES = 15;
const SETUP_RPC_COMPANY_ID_METADATA_KEY = "setupRpcCompanyId";
const SOURCE_ENVIRONMENT_CONFIG_FINGERPRINT_METADATA_KEY = "sourceEnvironmentConfigFingerprint";

type SetupSessionRow = typeof environmentCustomImageSetupSessions.$inferSelect;

export interface EnvironmentCustomImageOverview {
  activeTemplate: EnvironmentCustomImageTemplate | null;
  /**
   * Whether the active template's captured fingerprint still matches the
   * environment's saved config. `false` means runs silently fall back to the
   * base image until the template is re-captured. `null` when unknown (no
   * active template, or the config could not be evaluated).
   */
  activeTemplateMatchesConfig: boolean | null;
  activeSession: EnvironmentCustomImageSetupSession | null;
  latestSession: EnvironmentCustomImageSetupSession | null;
}

export type EnvironmentCustomImageReconciliation =
  | { action: "none" }
  | { action: "relinked"; template: EnvironmentCustomImageTemplate }
  | { action: "detached"; template: EnvironmentCustomImageTemplate };

export interface EnvironmentCustomImageSetupSessionResult {
  session: EnvironmentCustomImageSetupSession;
  connectionPayload: PluginEnvironmentInteractiveSetupConnectionPayload | null;
}

export interface EnvironmentCustomImageSetupCleanupResult {
  scanned: number;
  timedOut: number;
  failed: number;
}

function toSession(row: SetupSessionRow): EnvironmentCustomImageSetupSession {
  return {
    id: row.id,
    environmentId: row.environmentId,
    templateId: row.templateId ?? null,
    promotedTemplateId: row.promotedTemplateId ?? null,
    provider: row.provider,
    providerLeaseId: row.providerLeaseId ?? null,
    environmentLeaseId: row.environmentLeaseId ?? null,
    status: row.status,
    startedByUserId: row.startedByUserId ?? null,
    startedByAgentId: row.startedByAgentId ?? null,
    baseTemplateRef: row.baseTemplateRef ?? null,
    expiresAt: row.expiresAt ?? null,
    finishedAt: row.finishedAt ?? null,
    failureReason: row.failureReason ?? null,
    connectionSummary: row.connectionSummary ?? null,
    connectionSecretRef: row.connectionSecretRef ?? null,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function readConnectionType(value: string | null | undefined): EnvironmentCustomImageSetupConnectionSummary["type"] {
  if ((ENVIRONMENT_CUSTOM_IMAGE_SETUP_CONNECTION_TYPES as readonly string[]).includes(value ?? "")) {
    return value as EnvironmentCustomImageSetupConnectionSummary["type"];
  }
  return "unknown";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeConnectionSummary(
  summary: PluginEnvironmentInteractiveSetupSession["connectionSummary"],
): EnvironmentCustomImageSetupConnectionSummary | null {
  if (!summary) return null;
  const label = readString((summary as unknown as Record<string, unknown>).label);
  return {
    type: readConnectionType(summary.type),
    username: null,
    hostRedacted: true,
    portRedacted: true,
    ...(label ? { label } : {}),
  };
}

function normalizeProviderMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  return redactEnvironmentCustomImageValue(metadata);
}

function metadataRecord(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
}

function normalizeSetupRpcCompanyId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSetupRpcCompanyId(metadata: Record<string, unknown> | null | undefined): string | null {
  return normalizeSetupRpcCompanyId(metadataRecord(metadata)[SETUP_RPC_COMPANY_ID_METADATA_KEY]);
}

function persistedSetupMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const record = metadataRecord(metadata);
  const result: Record<string, unknown> = {};
  const setupRpcCompanyId = normalizeSetupRpcCompanyId(record[SETUP_RPC_COMPANY_ID_METADATA_KEY]);
  if (setupRpcCompanyId) {
    result[SETUP_RPC_COMPANY_ID_METADATA_KEY] = setupRpcCompanyId;
  }
  const fingerprint = readString(record[SOURCE_ENVIRONMENT_CONFIG_FINGERPRINT_METADATA_KEY]);
  if (fingerprint) {
    result[SOURCE_ENVIRONMENT_CONFIG_FINGERPRINT_METADATA_KEY] = fingerprint;
  }
  return result;
}

function mergeSetupSessionMetadata(
  existing: Record<string, unknown> | null | undefined,
  providerMetadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const provider = normalizeProviderMetadata(providerMetadata) ?? {};
  const persisted = persistedSetupMetadata(existing);
  const merged = { ...provider, ...persisted };
  return Object.keys(merged).length > 0 ? merged : null;
}

function normalizePersistedStatus(
  status: string,
  fallback: EnvironmentCustomImageSetupSessionStatus = "failed",
): EnvironmentCustomImageSetupSessionStatus {
  return (ENVIRONMENT_CUSTOM_IMAGE_SETUP_SESSION_STATUSES as readonly string[]).includes(status)
    ? status as EnvironmentCustomImageSetupSessionStatus
    : fallback;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function isActiveSetupStatus(status: EnvironmentCustomImageSetupSessionStatus): boolean {
  return (ACTIVE_SETUP_STATUSES as readonly string[]).includes(status);
}

function templateConfigBindingFromDriver(input: {
  templateRefKind?: string | null | undefined;
  templateConfigBinding?: unknown;
}) {
  return normalizeEnvironmentCustomImageRuntimeConfigBinding(input.templateConfigBinding)
    ?? defaultEnvironmentCustomImageRuntimeConfigBinding(input.templateRefKind);
}

function sourceTemplateFromConfig(
  config: SandboxEnvironmentConfig,
  binding: ReturnType<typeof templateConfigBindingFromDriver>,
  templateKind: EnvironmentCustomImageTemplateKind,
): {
  sourceTemplateRef: string | null;
  sourceTemplateKind: EnvironmentCustomImageTemplateKind | null;
} {
  const record = config as Record<string, unknown>;
  const configuredTemplate = readString(record[binding.field]);
  if (configuredTemplate) {
    return { sourceTemplateRef: configuredTemplate, sourceTemplateKind: templateKind };
  }
  const snapshot = readString(record.snapshot);
  if (snapshot) return { sourceTemplateRef: snapshot, sourceTemplateKind: "snapshot" };
  const image = readString(record.image);
  if (image) return { sourceTemplateRef: image, sourceTemplateKind: "image" };
  const providerTemplate = readString(record.template);
  if (providerTemplate) return { sourceTemplateRef: providerTemplate, sourceTemplateKind: "provider_template" };
  return { sourceTemplateRef: null, sourceTemplateKind: null };
}

async function resolveActiveTemplate(
  db: Db,
  input: { environmentId: string; provider?: string | null },
): Promise<EnvironmentCustomImageTemplate | null> {
  const conditions = [
    eq(environmentCustomImageTemplates.environmentId, input.environmentId),
    eq(environmentCustomImageTemplates.status, "active"),
  ];
  if (input.provider) {
    conditions.push(eq(environmentCustomImageTemplates.provider, input.provider));
  }
  const row = await db
    .select()
    .from(environmentCustomImageTemplates)
    .where(and(...conditions))
    .orderBy(desc(environmentCustomImageTemplates.capturedAt), desc(environmentCustomImageTemplates.createdAt))
    .then((rows) => rows[0] ?? null);
  return row ? environmentCustomImageTemplateFromRow(row) : null;
}

export function environmentCustomImageService(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const environments = environmentService(db);
  const secrets = secretService(db);

  async function getTemplateById(id: string): Promise<EnvironmentCustomImageTemplate | null> {
    const row = await db
      .select()
      .from(environmentCustomImageTemplates)
      .where(eq(environmentCustomImageTemplates.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? environmentCustomImageTemplateFromRow(row) : null;
  }

  async function getSessionById(id: string): Promise<EnvironmentCustomImageSetupSession | null> {
    const row = await db
      .select()
      .from(environmentCustomImageSetupSessions)
      .where(eq(environmentCustomImageSetupSessions.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? toSession(row) : null;
  }

  async function getActiveSetupSession(input: {
    environmentId: string;
  }): Promise<EnvironmentCustomImageSetupSession | null> {
    const row = await db
      .select()
      .from(environmentCustomImageSetupSessions)
      .where(and(
        eq(environmentCustomImageSetupSessions.environmentId, input.environmentId),
        inArray(environmentCustomImageSetupSessions.status, [...ACTIVE_SETUP_STATUSES]),
      ))
      .orderBy(desc(environmentCustomImageSetupSessions.createdAt))
      .then((rows) => rows[0] ?? null);
    return row ? toSession(row) : null;
  }

  async function getLatestSetupSession(input: {
    environmentId: string;
  }): Promise<EnvironmentCustomImageSetupSession | null> {
    const row = await db
      .select()
      .from(environmentCustomImageSetupSessions)
      .where(and(
        eq(environmentCustomImageSetupSessions.environmentId, input.environmentId),
      ))
      .orderBy(desc(environmentCustomImageSetupSessions.createdAt))
      .then((rows) => rows[0] ?? null);
    return row ? toSession(row) : null;
  }

  async function requireEnvironment(environmentId: string): Promise<Environment> {
    const environment = await environments.getById(environmentId);
    if (!environment) throw notFound("Environment not found");
    return environment;
  }

  async function resolveSecretContextCompanyId(
    environmentId: string,
    explicitCompanyId?: string | null,
  ): Promise<string | null> {
    if (explicitCompanyId) return explicitCompanyId;
    const bindingCompanyIds = await secrets.listBindingCompanyIdsForTarget({
      targetType: "environment",
      targetId: environmentId,
    });
    if (bindingCompanyIds.length > 1) {
      throw conflict("Environment secret bindings span multiple companies and require explicit companyId context.");
    }
    return bindingCompanyIds[0] ?? null;
  }

  async function resolveSetupProvider(input: {
    secretContextCompanyId?: string | null;
    storedRpcCompanyId?: string | null;
    storedProvider?: string | null;
    environment: Environment;
    requireCapture?: boolean;
    requireDelete?: boolean;
  }) {
    if (!options.pluginWorkerManager) {
      throw unprocessable("Environment customImage setup requires a running plugin worker manager.");
    }
    const storedRpcCompanyId = normalizeSetupRpcCompanyId(input.storedRpcCompanyId);
    const secretContextCompanyId = storedRpcCompanyId
      ? (storedRpcCompanyId === "instance" ? null : storedRpcCompanyId)
      : await resolveSecretContextCompanyId(
          input.environment.id,
          input.secretContextCompanyId,
        );
    const parsed = await resolveEnvironmentDriverConfigForRuntime(
      db,
      secretContextCompanyId,
      input.environment,
      { issueId: null, heartbeatRunId: null },
    );
    if (parsed.driver !== "sandbox") {
      throw unprocessable("Environment customImage setup is only supported for sandbox environments.");
    }
    const provider = parsed.config.provider;
    const storedProvider = readString(input.storedProvider);
    if (storedProvider && provider !== storedProvider) {
      throw conflict(
        `Environment customImage provider changed from "${storedProvider}" to "${provider}". Switch the environment back before continuing this customImage lifecycle operation.`,
      );
    }
    const resolved = await resolvePluginSandboxProviderDriverByKey({
      db,
      driverKey: provider,
      workerManager: options.pluginWorkerManager,
      requireRunning: true,
    });
    if (!resolved) {
      throw unprocessable(`Sandbox provider "${provider}" is not ready for customImage setup.`);
    }
    if (!resolved.driver.supportsInteractiveSetup) {
      throw unprocessable(`Sandbox provider "${provider}" does not support interactive setup.`);
    }
    if (input.requireCapture && !resolved.driver.supportsTemplateCapture) {
      throw unprocessable(`Sandbox provider "${provider}" does not support template capture.`);
    }
    if (input.requireDelete && !resolved.driver.supportsTemplateDelete) {
      throw unprocessable(`Sandbox provider "${provider}" does not support template deletion.`);
    }
    return {
      provider,
      rpcCompanyId: storedRpcCompanyId ?? secretContextCompanyId ?? "instance",
      pluginId: resolved.plugin.id,
      driver: resolved.driver,
      runtimeConfig: parsed.config,
      driverConfig: stripSandboxProviderEnvelope(parsed.config),
    };
  }

  async function callProviderStart(input: {
    environment: Environment;
    sessionId: string;
    expiresAt: Date;
    sourceTemplateRef: string | null;
    sourceTemplateKind: EnvironmentCustomImageTemplateKind | null;
    secretContextCompanyId?: string | null;
  }): Promise<PluginEnvironmentInteractiveSetupSession> {
    const provider = await resolveSetupProvider({
      secretContextCompanyId: input.secretContextCompanyId,
      environment: input.environment,
    });
    return await options.pluginWorkerManager!.call(provider.pluginId, "environmentStartInteractiveSetup", {
      driverKey: provider.provider,
      companyId: provider.rpcCompanyId,
      environmentId: input.environment.id,
      issueId: null,
      config: provider.driverConfig,
      sessionId: input.sessionId,
      sourceTemplateRef: input.sourceTemplateRef,
      sourceTemplateKind: input.sourceTemplateKind as PluginEnvironmentTemplateRefKind | null,
      connectionExpiresInMinutes: DEFAULT_CONNECTION_EXPIRES_IN_MINUTES,
      expiresAt: input.expiresAt.toISOString(),
    }, resolvePluginExecuteRpcTimeoutMs({
      requestedTimeoutMs: undefined,
      config: provider.driverConfig,
    }));
  }

  async function callProviderGet(input: {
    session: EnvironmentCustomImageSetupSession;
    includeConnectionPayload: boolean;
  }): Promise<PluginEnvironmentInteractiveSetupSession> {
    const environment = await requireEnvironment(input.session.environmentId);
    const provider = await resolveSetupProvider({
      environment,
      storedProvider: input.session.provider,
      storedRpcCompanyId: readSetupRpcCompanyId(input.session.metadata),
    });
    return await options.pluginWorkerManager!.call(provider.pluginId, "environmentGetInteractiveSetup", {
      driverKey: provider.provider,
      companyId: provider.rpcCompanyId,
      environmentId: environment.id,
      issueId: null,
      config: provider.driverConfig,
      providerLeaseId: input.session.providerLeaseId,
      setupMetadata: input.session.metadata ?? undefined,
      includeConnectionPayload: input.includeConnectionPayload,
      connectionExpiresInMinutes: DEFAULT_CONNECTION_EXPIRES_IN_MINUTES,
    }, resolvePluginExecuteRpcTimeoutMs({
      requestedTimeoutMs: undefined,
      config: provider.driverConfig,
    }));
  }

  async function callProviderCapture(input: {
    session: EnvironmentCustomImageSetupSession;
    previousTemplate: EnvironmentCustomImageTemplate | null;
  }): Promise<PluginEnvironmentCaptureTemplateResult> {
    const environment = await requireEnvironment(input.session.environmentId);
    const provider = await resolveSetupProvider({
      environment,
      storedProvider: input.session.provider,
      storedRpcCompanyId: readSetupRpcCompanyId(input.session.metadata),
      requireCapture: true,
    });
    return await options.pluginWorkerManager!.call(provider.pluginId, "environmentCaptureTemplate", {
      driverKey: provider.provider,
      companyId: provider.rpcCompanyId,
      environmentId: environment.id,
      issueId: null,
      config: provider.driverConfig,
      providerLeaseId: input.session.providerLeaseId,
      setupMetadata: input.session.metadata ?? undefined,
      sourceTemplateRef: input.session.baseTemplateRef,
      previousTemplateRef: input.previousTemplate?.templateRef ?? null,
      templateLabel: `paperclip-${environment.id}-${input.session.id.slice(0, 8)}`,
      timeoutMs: typeof provider.driverConfig.timeoutMs === "number" ? provider.driverConfig.timeoutMs : null,
    }, resolvePluginExecuteRpcTimeoutMs({
      requestedTimeoutMs: typeof provider.driverConfig.timeoutMs === "number" ? provider.driverConfig.timeoutMs : undefined,
      config: provider.driverConfig,
    }));
  }

  async function callProviderCancel(input: {
    session: EnvironmentCustomImageSetupSession;
    reason: string | null;
  }): Promise<PluginEnvironmentCancelInteractiveSetupResult> {
    const environment = await requireEnvironment(input.session.environmentId);
    const provider = await resolveSetupProvider({
      environment,
      storedProvider: input.session.provider,
      storedRpcCompanyId: readSetupRpcCompanyId(input.session.metadata),
    });
    return await options.pluginWorkerManager!.call(provider.pluginId, "environmentCancelInteractiveSetup", {
      driverKey: provider.provider,
      companyId: provider.rpcCompanyId,
      environmentId: environment.id,
      issueId: null,
      config: provider.driverConfig,
      providerLeaseId: input.session.providerLeaseId,
      setupMetadata: input.session.metadata ?? undefined,
      reason: input.reason,
    }, resolvePluginExecuteRpcTimeoutMs({
      requestedTimeoutMs: undefined,
      config: provider.driverConfig,
    }));
  }

  async function resolveTemplateDeleteProvider(template: EnvironmentCustomImageTemplate) {
    if (!template.templateRef) {
      throw unprocessable("Cannot delete an environment customImage template without a provider template ref.");
    }
    const environment = await requireEnvironment(template.environmentId);
    return await resolveSetupProvider({
      environment,
      storedProvider: template.provider,
      storedRpcCompanyId: readSetupRpcCompanyId(template.metadata),
      requireDelete: true,
    });
  }

  async function callProviderDeleteTemplate(input: {
    template: EnvironmentCustomImageTemplate;
    provider: Awaited<ReturnType<typeof resolveTemplateDeleteProvider>>;
    reason: string | null;
  }) {
    const templateRef = input.template.templateRef;
    if (!templateRef) {
      throw unprocessable("Cannot delete an environment customImage template without a provider template ref.");
    }
    const environment = await requireEnvironment(input.template.environmentId);
    const provider = input.provider;
    return await options.pluginWorkerManager!.call(provider.pluginId, "environmentDeleteTemplate", {
      driverKey: provider.provider,
      companyId: provider.rpcCompanyId,
      environmentId: environment.id,
      issueId: null,
      config: provider.driverConfig,
      templateRef,
      templateKind: input.template.templateKind as PluginEnvironmentTemplateRefKind,
      metadata: input.template.metadata ?? undefined,
      reason: input.reason,
    }, resolvePluginExecuteRpcTimeoutMs({
      requestedTimeoutMs: undefined,
      config: provider.driverConfig,
    }));
  }

  async function updateSessionFromProvider(
    session: Pick<EnvironmentCustomImageSetupSession, "id" | "metadata">,
    providerSession: PluginEnvironmentInteractiveSetupSession,
    fallbackStatus: EnvironmentCustomImageSetupSessionStatus = "failed",
  ): Promise<EnvironmentCustomImageSetupSession> {
    const status = normalizePersistedStatus(providerSession.status, fallbackStatus);
    const now = new Date();
    const row = await db
      .update(environmentCustomImageSetupSessions)
      .set({
        providerLeaseId: providerSession.providerLeaseId ?? null,
        status,
        connectionSummary: normalizeConnectionSummary(providerSession.connectionSummary),
        expiresAt: providerSession.expiresAt ? new Date(providerSession.expiresAt) : undefined,
        metadata: mergeSetupSessionMetadata(session.metadata, providerSession.metadata),
        failureReason: status === "failed" ? "Provider setup session failed or is missing." : null,
        updatedAt: now,
      })
      .where(eq(environmentCustomImageSetupSessions.id, session.id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Environment customImage setup session not found");
    return toSession(row);
  }

  async function markSessionStatus(input: {
    sessionId: string;
    status: EnvironmentCustomImageSetupSessionStatus;
    failureReason?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<EnvironmentCustomImageSetupSession> {
    const now = new Date();
    const row = await db
      .update(environmentCustomImageSetupSessions)
      .set({
        status: input.status,
        failureReason: input.failureReason ?? null,
        metadata: input.metadata === undefined ? undefined : normalizeProviderMetadata(input.metadata),
        finishedAt: ["promoted", "cancelled", "timed_out", "failed"].includes(input.status) ? now : undefined,
        updatedAt: now,
      })
      .where(eq(environmentCustomImageSetupSessions.id, input.sessionId))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Environment customImage setup session not found");
    return toSession(row);
  }

  async function cancelSession(
    session: EnvironmentCustomImageSetupSession,
    reason: string | null,
    fallbackStatus: EnvironmentCustomImageSetupSessionStatus,
  ): Promise<EnvironmentCustomImageSetupSession> {
    if (!isActiveSetupStatus(session.status)) return session;
    try {
      const cancelled = await callProviderCancel({ session, reason });
      const status = cancelled.status === "missing"
        ? fallbackStatus
        : normalizePersistedStatus(cancelled.status, fallbackStatus);
      return await markSessionStatus({
        sessionId: session.id,
        status,
        metadata: cancelled.metadata,
        failureReason: status === "failed" ? "Provider failed to cancel setup session." : null,
      });
    } catch (error) {
      return await markSessionStatus({
        sessionId: session.id,
        status: "failed",
        failureReason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function templateMatchesEnvironmentConfig(
    environment: Environment,
    template: EnvironmentCustomImageTemplate,
  ): Promise<boolean | null> {
    try {
      const parsed = parseEnvironmentDriverConfig(environment);
      if (parsed.driver !== "sandbox") return false;
      if (parsed.config.provider !== template.provider) return false;
      return environmentCustomImageTemplateMatchesBaseConfig({
        template,
        baseConfig: parsed.config,
        secretRefExcludePaths: parsed.config.provider === "fake"
          ? []
          : await resolveSandboxProviderSecretRefPaths(db, parsed.config.provider),
      });
    } catch {
      return null;
    }
  }

  return {
    getOverview: async (input: {
      environmentId: string;
    }): Promise<EnvironmentCustomImageOverview> => {
      const environment = await requireEnvironment(input.environmentId);
      const [activeTemplate, activeSession, latestSession] = await Promise.all([
        resolveActiveTemplate(db, input),
        getActiveSetupSession(input),
        getLatestSetupSession(input),
      ]);
      return {
        activeTemplate,
        activeTemplateMatchesConfig: activeTemplate
          ? await templateMatchesEnvironmentConfig(environment, activeTemplate)
          : null,
        activeSession,
        latestSession,
      };
    },

    getActiveTemplate: async (input: {
      environmentId: string;
      provider?: string | null;
    }): Promise<EnvironmentCustomImageTemplate | null> => resolveActiveTemplate(db, input),

    getSessionById,

    startSetupSession: async (input: {
      environmentId: string;
      templateId?: string | null;
      ttlSeconds?: number | null;
      actor: { userId?: string | null; agentId?: string | null };
      secretContextCompanyId?: string | null;
      now?: Date;
    }): Promise<EnvironmentCustomImageSetupSessionResult> => {
      const environment = await requireEnvironment(input.environmentId);
      const provider = await resolveSetupProvider({
        secretContextCompanyId: input.secretContextCompanyId,
        environment,
      });
      const activeSession = await getActiveSetupSession(input);
      if (activeSession) {
        throw conflict("An environment customImage setup session is already active for this environment.");
      }
      const selectedTemplate = input.templateId
        ? await getTemplateById(input.templateId)
        : await resolveActiveTemplate(db, {
            environmentId: input.environmentId,
            provider: provider.provider,
          });
      if (input.templateId && !selectedTemplate) {
        throw notFound("Environment customImage template not found");
      }
      if (
        selectedTemplate &&
        (
          selectedTemplate.environmentId !== input.environmentId ||
          selectedTemplate.provider !== provider.provider ||
          selectedTemplate.status !== "active"
        )
      ) {
        throw unprocessable("Setup template must be the active template for this environment.");
      }
      const source = selectedTemplate
        ? {
            sourceTemplateRef: selectedTemplate.templateRef,
            sourceTemplateKind: selectedTemplate.templateKind,
          }
        : sourceTemplateFromConfig(
            provider.runtimeConfig,
            templateConfigBindingFromDriver(provider.driver),
            readTemplateKind(provider.driver.templateRefKind ?? null),
          );
      const now = input.now ?? new Date();
      const ttlSeconds = input.ttlSeconds ?? DEFAULT_SETUP_TTL_SECONDS;
      const expiresAt = addSeconds(now, ttlSeconds);
      const sessionId = randomUUID();
      const fingerprint = fingerprintEnvironmentSandboxProviderConfig(provider.runtimeConfig);
      const setupMetadata = {
        [SOURCE_ENVIRONMENT_CONFIG_FINGERPRINT_METADATA_KEY]: fingerprint,
        [SETUP_RPC_COMPANY_ID_METADATA_KEY]: provider.rpcCompanyId,
      };
      await db.insert(environmentCustomImageSetupSessions).values({
        id: sessionId,
        environmentId: input.environmentId,
        templateId: selectedTemplate?.id ?? null,
        provider: provider.provider,
        status: "starting",
        startedByUserId: input.actor.userId ?? null,
        startedByAgentId: input.actor.agentId ?? null,
        baseTemplateRef: source.sourceTemplateRef,
        expiresAt,
        metadata: setupMetadata,
        createdAt: now,
        updatedAt: now,
      });

      try {
        const providerSession = await callProviderStart({
          environment,
          sessionId,
          expiresAt,
          sourceTemplateRef: source.sourceTemplateRef,
          sourceTemplateKind: source.sourceTemplateKind,
          secretContextCompanyId: input.secretContextCompanyId,
        });
        const session = await updateSessionFromProvider({ id: sessionId, metadata: setupMetadata }, providerSession);
        return {
          session,
          connectionPayload: providerSession.connectionPayload ?? null,
        };
      } catch (error) {
        await markSessionStatus({
          sessionId,
          status: "failed",
          failureReason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    refreshSetupSession: async (input: {
      sessionId: string;
      includeConnectionPayload?: boolean;
      now?: Date;
    }): Promise<EnvironmentCustomImageSetupSessionResult> => {
      const session = await getSessionById(input.sessionId);
      if (!session) throw notFound("Environment customImage setup session not found");
      const now = input.now ?? new Date();
      const expiresAt = toDate(session.expiresAt);
      if (expiresAt && expiresAt.getTime() <= now.getTime() && isActiveSetupStatus(session.status)) {
        return {
          session: await cancelSession(session, "timed_out", "timed_out"),
          connectionPayload: null,
        };
      }
      if (!isActiveSetupStatus(session.status)) {
        return { session, connectionPayload: null };
      }
      const providerSession = await callProviderGet({
        session,
        includeConnectionPayload: input.includeConnectionPayload ?? false,
      });
      return {
        session: await updateSessionFromProvider(session, providerSession),
        connectionPayload: providerSession.connectionPayload ?? null,
      };
    },

    finishSetupSession: async (input: {
      sessionId: string;
      metadata?: Record<string, unknown>;
      now?: Date;
    }): Promise<EnvironmentCustomImageSetupSessionResult & { template: EnvironmentCustomImageTemplate }> => {
      const session = await getSessionById(input.sessionId);
      if (!session) throw notFound("Environment customImage setup session not found");
      const expiresAt = toDate(session.expiresAt);
      if (expiresAt && expiresAt.getTime() <= (input.now ?? new Date()).getTime()) {
        const timedOut = await cancelSession(session, "timed_out", "timed_out");
        throw conflict("Environment customImage setup session has expired.", { session: timedOut });
      }
      if (session.status !== "waiting_for_user" && session.status !== "starting") {
        throw conflict(`Cannot finish setup session from status "${session.status}".`);
      }
      await markSessionStatus({ sessionId: session.id, status: "capturing" });
      const currentActive = await resolveActiveTemplate(db, {
        environmentId: session.environmentId,
        provider: session.provider,
      });
      try {
        const captured = await callProviderCapture({ session, previousTemplate: currentActive });
        const environment = await requireEnvironment(session.environmentId);
        const parsed = parseEnvironmentDriverConfig(environment);
        const baseFingerprint = parsed.driver === "sandbox"
          ? fingerprintEnvironmentSandboxProviderConfig(parsed.config, {
              excludePaths: [
                ...ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS,
                ...await resolveSandboxProviderSecretRefPaths(db, parsed.config.provider),
              ],
            })
          : null;
        const provider = await resolveSetupProvider({
          environment,
          storedProvider: session.provider,
          storedRpcCompanyId: readSetupRpcCompanyId(session.metadata),
          requireCapture: true,
        });
        const runtimeConfigBinding = templateConfigBindingFromDriver({
          templateRefKind: captured.templateKind,
          templateConfigBinding: provider.driver.templateConfigBinding,
        });
        const now = input.now ?? new Date();
        const templateRow = await db.transaction(async (tx) => {
          const templateId = randomUUID();
          const supersededRows = await tx
            .update(environmentCustomImageTemplates)
            .set({
              status: "superseded",
              supersededByTemplateId: null,
              updatedAt: now,
            })
            .where(and(
              eq(environmentCustomImageTemplates.environmentId, session.environmentId),
              eq(environmentCustomImageTemplates.provider, session.provider),
              eq(environmentCustomImageTemplates.status, "active"),
            ))
            .returning({ id: environmentCustomImageTemplates.id });
          const [created] = await tx
            .insert(environmentCustomImageTemplates)
            .values({
              id: templateId,
              environmentId: session.environmentId,
              provider: session.provider,
              templateKind: readTemplateKind(captured.templateKind),
              templateRef: captured.templateRef,
              sourceTemplateRef: session.baseTemplateRef,
              sourceEnvironmentConfigFingerprint: baseFingerprint,
              status: "active",
              createdByUserId: session.startedByUserId,
              createdByAgentId: session.startedByAgentId,
              capturedAt: now,
              metadata: normalizeProviderMetadata({
                ...(captured.metadata ?? {}),
                ...(input.metadata ? { userMetadata: input.metadata } : {}),
                ...persistedSetupMetadata(session.metadata),
                [ENVIRONMENT_CUSTOM_IMAGE_RUNTIME_CONFIG_BINDING_METADATA_KEY]: runtimeConfigBinding,
              }),
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          if (supersededRows.length > 0) {
            await tx
              .update(environmentCustomImageTemplates)
              .set({
                supersededByTemplateId: templateId,
                updatedAt: now,
              })
              .where(inArray(
                environmentCustomImageTemplates.id,
                supersededRows.map((row) => row.id),
              ));
          }
          await tx
            .update(environmentCustomImageSetupSessions)
            .set({
              status: "promoted",
              promotedTemplateId: templateId,
              finishedAt: now,
              metadata: normalizeProviderMetadata({
                ...(session.metadata ?? {}),
                capture: captured.metadata ?? {},
              }),
              updatedAt: now,
            })
            .where(eq(environmentCustomImageSetupSessions.id, session.id));
          return created;
        });
        if (!templateRow) throw new Error("Failed to create environment customImage template");

        const promotedSession = await getSessionById(session.id);
        if (!promotedSession) throw notFound("Environment customImage setup session not found");
        try {
          await callProviderCancel({ session: promotedSession, reason: "promoted" });
        } catch {
          // Promotion succeeded; a later explicit cancel/cleanup can retry provider teardown.
        }
        return {
          session: promotedSession,
          template: environmentCustomImageTemplateFromRow(templateRow),
          connectionPayload: null,
        };
      } catch (error) {
        await markSessionStatus({
          sessionId: session.id,
          status: "failed",
          failureReason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    cancelSetupSession: async (input: {
      sessionId: string;
      reason?: string | null;
    }): Promise<EnvironmentCustomImageSetupSession> => {
      const session = await getSessionById(input.sessionId);
      if (!session) throw notFound("Environment customImage setup session not found");
      return await cancelSession(session, input.reason ?? "cancelled", "cancelled");
    },

    /**
     * Keeps the active captured template consistent with a just-saved config
     * change. Changes that cannot affect the captured contents (for example a
     * region hint) re-stamp the template's source fingerprint so it keeps
     * applying; boot-source or provider-identity changes report `detached` so
     * callers can tell the user a fresh capture is required. Never throws for
     * unparseable configs; the save itself must not fail on reconciliation.
     */
    reconcileActiveTemplateForConfigChange: async (input: {
      environmentId: string;
      previous: Pick<Environment, "driver" | "config">;
      next: Pick<Environment, "driver" | "config">;
      now?: Date;
    }): Promise<EnvironmentCustomImageReconciliation> => {
      let previousParsed;
      let nextParsed;
      try {
        previousParsed = parseEnvironmentDriverConfig(input.previous);
        nextParsed = parseEnvironmentDriverConfig(input.next);
      } catch {
        return { action: "none" };
      }
      if (previousParsed.driver !== "sandbox") return { action: "none" };
      const template = await resolveActiveTemplate(db, {
        environmentId: input.environmentId,
        provider: previousParsed.config.provider,
      });
      if (!template?.templateRef) return { action: "none" };
      const secretRefExcludePaths = previousParsed.config.provider === "fake"
        ? []
        : [...await resolveSandboxProviderSecretRefPaths(db, previousParsed.config.provider)];
      if (!environmentCustomImageTemplateMatchesBaseConfig({
        template,
        baseConfig: previousParsed.config,
        secretRefExcludePaths,
      })) {
        // Already detached before this save; leave it alone.
        return { action: "none" };
      }
      if (nextParsed.driver !== "sandbox" || nextParsed.config.provider !== template.provider) {
        return { action: "detached", template };
      }
      const resolvedDriver = await resolvePluginSandboxProviderDriverByKey({
        db,
        driverKey: template.provider,
      });
      if (!resolvedDriver) {
        // Without driver metadata the change cannot be classified safely.
        return { action: "detached", template };
      }
      const changeKind = classifyEnvironmentCustomImageConfigChange({
        template,
        previousConfig: previousParsed.config,
        nextConfig: nextParsed.config,
        secretRefExcludePaths,
        templateIdentityPaths: resolvedDriver.driver.templateIdentityPaths ?? [],
      });
      if (changeKind === "none") return { action: "none" };
      if (changeKind === "breaking") return { action: "detached", template };
      const now = input.now ?? new Date();
      const nextFingerprint = fingerprintEnvironmentSandboxProviderConfig(nextParsed.config, {
        excludePaths: [
          ...ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS,
          ...secretRefExcludePaths,
        ],
      });
      const row = await db
        .update(environmentCustomImageTemplates)
        .set({ sourceEnvironmentConfigFingerprint: nextFingerprint, updatedAt: now })
        .where(eq(environmentCustomImageTemplates.id, template.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return {
        action: "relinked",
        template: row ? environmentCustomImageTemplateFromRow(row) : template,
      };
    },

    rollbackTemplate: async (input: {
      environmentId: string;
      now?: Date;
    }): Promise<{
      activeTemplate: EnvironmentCustomImageTemplate;
      supersededTemplate: EnvironmentCustomImageTemplate;
    }> => {
      await requireEnvironment(input.environmentId);
      const active = await resolveActiveTemplate(db, input);
      if (!active) throw notFound("Active environment customImage template not found");
      const previousRow = await db
        .select()
        .from(environmentCustomImageTemplates)
        .where(and(
          eq(environmentCustomImageTemplates.environmentId, input.environmentId),
          eq(environmentCustomImageTemplates.provider, active.provider),
          eq(environmentCustomImageTemplates.status, "superseded"),
          eq(environmentCustomImageTemplates.supersededByTemplateId, active.id),
        ))
        .orderBy(desc(environmentCustomImageTemplates.capturedAt), desc(environmentCustomImageTemplates.createdAt))
        .then((rows) => rows[0] ?? null);
      if (!previousRow) throw notFound("Previous environment customImage template not found");
      const now = input.now ?? new Date();
      const [supersededRow, activeRow] = await db.transaction(async (tx) => {
        const [nextSuperseded] = await tx
          .update(environmentCustomImageTemplates)
          .set({
            status: "superseded",
            supersededByTemplateId: previousRow.id,
            updatedAt: now,
          })
          .where(eq(environmentCustomImageTemplates.id, active.id))
          .returning();
        const [nextActive] = await tx
          .update(environmentCustomImageTemplates)
          .set({
            status: "active",
            supersededByTemplateId: null,
            updatedAt: now,
          })
          .where(eq(environmentCustomImageTemplates.id, previousRow.id))
          .returning();
        return [nextSuperseded, nextActive] as const;
      });
      if (!supersededRow || !activeRow) throw new Error("Failed to roll back environment customImage template");
      return {
        activeTemplate: environmentCustomImageTemplateFromRow(activeRow),
        supersededTemplate: environmentCustomImageTemplateFromRow(supersededRow),
      };
    },

    disableTemplate: async (input: {
      environmentId: string;
      deleteProviderTemplate?: boolean;
      now?: Date;
    }): Promise<EnvironmentCustomImageTemplate> => {
      await requireEnvironment(input.environmentId);
      const active = await resolveActiveTemplate(db, input);
      if (!active) throw notFound("Active environment customImage template not found");
      const deleteProvider = input.deleteProviderTemplate
        ? await resolveTemplateDeleteProvider(active)
        : null;
      const now = input.now ?? new Date();
      const row = await db
        .update(environmentCustomImageTemplates)
        .set({ status: "revoked", updatedAt: now })
        .where(eq(environmentCustomImageTemplates.id, active.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Active environment customImage template not found");
      const template = environmentCustomImageTemplateFromRow(row);
      if (deleteProvider) {
        await callProviderDeleteTemplate({ template, provider: deleteProvider, reason: "disabled" });
      }
      return template;
    },

    cleanupExpiredSetupSessions: async (input: {
      now?: Date;
      limit?: number;
    } = {}): Promise<EnvironmentCustomImageSetupCleanupResult> => {
      const now = input.now ?? new Date();
      const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
      const rows = await db
        .select()
        .from(environmentCustomImageSetupSessions)
        .where(and(
          inArray(environmentCustomImageSetupSessions.status, [...ACTIVE_SETUP_STATUSES]),
          lte(environmentCustomImageSetupSessions.expiresAt, now),
        ))
        .limit(limit);
      let timedOut = 0;
      let failed = 0;
      for (const row of rows) {
        const session = toSession(row);
        const updated = await cancelSession(session, "timed_out", "timed_out");
        if (updated.status === "timed_out") timedOut += 1;
        if (updated.status === "failed") failed += 1;
      }
      return { scanned: rows.length, timedOut, failed };
    },
  };
}
