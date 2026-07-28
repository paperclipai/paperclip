import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  AGENT_ADAPTER_TYPES,
  cancelEnvironmentCustomImageSetupSessionSchema,
  createEnvironmentCustomImageTerminalSessionTokenSchema,
  createEnvironmentSchema,
  finishEnvironmentCustomImageSetupSessionSchema,
  getEnvironmentCapabilities,
  probeEnvironmentConfigSchema,
  redactEnvironmentCustomImageSetupSession,
  redactEnvironmentCustomImageTemplate,
  startEnvironmentCustomImageSetupSessionSchema,
  type EnvironmentDeleteBlastRadius,
  updateEnvironmentSchema,
} from "@paperclipai/shared";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { isCloudManagedInstance } from "../middleware/auth.js";
import { getManagedInstanceConfig, SECRET_LIKE_CONFIG_KEY_PATTERN } from "../services/managed-config.js";
import { parseExecutionPolicyBootstrapEnv } from "../services/execution-policy-bootstrap.js";
import { isExecutionForcedToKubernetes } from "../services/execution-allowlist.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  environmentCustomImageService,
  issueService,
  instanceSettingsService,
  logActivity,
  projectService,
} from "../services/index.js";
import {
  environmentCustomImageTerminalConnectionRegistry,
  environmentCustomImageTerminalSessionStore,
  validateCustomImageSetupSshPayload,
  type EnvironmentCustomImageTerminalPayloadValidationResult,
} from "../services/environment-custom-image-terminal-sessions.js";
import {
  readCustomImageSetupSessionCompanyId,
  requireFutureCustomImageSetupExpiry,
} from "../services/environment-custom-image-setup-session-utils.js";
import {
  collectEnvironmentSecretRefs,
  normalizeEnvironmentConfigForPersistence,
  normalizeEnvironmentConfigForProbe,
  readSshEnvironmentPrivateKeySecretId,
  type ParsedEnvironmentConfig,
} from "../services/environment-config.js";
import { probeEnvironment } from "../services/environment-probe.js";
import { secretService } from "../services/secrets.js";
import { listReadyPluginEnvironmentDrivers } from "../services/plugin-environment-driver.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { assertBoardOrgAccess, getActorInfo } from "./authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { environmentService } from "../services/environments.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether this environment row was provisioned by the platform: the
 * managed-config environment provisioner marker, or the legacy managed
 * Kubernetes wrapper marker (rows created by builds that predate the
 * generalized provisioner and have not been adopted yet).
 */
export function isPlatformProvisionedEnvironment(environment: {
  metadata: Record<string, unknown> | null;
}): boolean {
  return (
    environment.metadata?.managedByPaperclip === true ||
    environment.metadata?.managedKubernetesSandbox === true
  );
}

function redactSecretLikeConfigKeys(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_LIKE_CONFIG_KEY_PATTERN.test(key)) continue;
    if (isPlainRecord(child)) {
      result[key] = redactSecretLikeConfigKeys(child);
    } else if (Array.isArray(child)) {
      result[key] = child.map((element) =>
        isPlainRecord(element) ? redactSecretLikeConfigKeys(element) : element,
      );
    } else {
      result[key] = child;
    }
  }
  return result;
}

/**
 * Floor view of a platform-provisioned environment on a cloud-managed
 * instance: env vars and credential-shaped config keys are never echoed — to
 * ANY actor, including instance admins — while structural config (provider,
 * image, template, region, ...) and the managed markers in `metadata` stay
 * visible so admin surfaces can render the environment and show its
 * platform-managed state.
 */
export function applyPlatformProvisionedEnvironmentFloor<T extends {
  config: Record<string, unknown> | null;
  envVars?: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}>(environment: T): T {
  return {
    ...environment,
    config: redactSecretLikeConfigKeys(isPlainRecord(environment.config) ? environment.config : {}),
    ...(Object.prototype.hasOwnProperty.call(environment, "envVars") ? { envVars: {} } : {}),
  };
}

const PLATFORM_PROVISIONED_MARKER_KEYS = [
  "managedByPaperclip",
  "managedKubernetesSandbox",
] as const;

/**
 * Whether some bootstrap path on this instance currently owns the managed
 * sandbox slot: the managed-config `environments` section
 * (`applyManagedEnvironments`) or the forced execution-mode bootstrap
 * (`PAPERCLIP_EXECUTION_MODE=kubernetes`). Both adopt and refresh the
 * marked sandbox row on every boot. Fails closed: an unparseable document
 * or env value counts as configured, keeping the slot protected (a
 * malformed value refuses startup anyway, so a running server never hits
 * the catch).
 */
function isManagedSandboxProvisioningConfigured(): boolean {
  try {
    if ((getManagedInstanceConfig()?.environments.length ?? 0) > 0) return true;
  } catch {
    return true;
  }
  try {
    return parseExecutionPolicyBootstrapEnv(process.env) !== null;
  } catch {
    return true;
  }
}

/**
 * Whether this row occupies a provisioner-owned environment slot whose
 * platform markers are LIVE state — i.e. some platform code path converges
 * the markers on this exact row, so a marker here is never a stale
 * leftover:
 *
 * - The single local row (`environments_local_driver_idx`): on a
 *   cloud-managed instance `ensureLocalEnvironment` adopts and stamps it
 *   from every caller (company creation, the heartbeat, run
 *   orchestration), so the local slot is platform-owned unconditionally.
 * - The single marked sandbox row (`environments_managed_sandbox_idx`):
 *   owned only while a managed-sandbox bootstrap path is configured —
 *   `ensureManagedSandboxEnvironment` then adopts and refreshes whichever
 *   row holds the slot on every boot.
 * - Any sandbox row bearing the legacy kubernetes marker while the
 *   persisted instance execution policy forces kubernetes:
 *   `findKubernetesEnvironment` selects marked rows (newest first) for
 *   every forced run, so under that policy each marked row is — or on the
 *   newest row's removal becomes — the live runtime row. This holds even
 *   with no bootstrap path configured: the per-run guard reads the
 *   persisted `executionMode`, which can outlive the env that seeded it.
 *
 * With no provisioning path configured and no forced-kubernetes policy the
 * platform holds no claim on any sandbox row, so a platform marker there
 * is stale by definition and stays recoverable via the marker-clear
 * escape hatch below.
 */
async function isPlatformSlotEnvironment(
  environment: { driver: string; metadata: Record<string, unknown> | null },
  options: { isForcedKubernetesExecution: () => Promise<boolean> },
): Promise<boolean> {
  if (environment.driver === "local") return true;
  if (environment.driver !== "sandbox") return false;
  if (
    environment.metadata?.managedByPaperclip === true &&
    isManagedSandboxProvisioningConfigured()
  ) {
    return true;
  }
  return (
    environment.metadata?.managedKubernetesSandbox === true &&
    (await options.isForcedKubernetesExecution())
  );
}

/**
 * Returns true when the PATCH body is a metadata-only write whose only
 * purpose is to clear platform markers (setting them to null/false). This is
 * the escape hatch for rows that had these markers stamped through the old
 * unrestricted API before the floor was introduced. It never applies to a
 * row whose slot markers are live (see `isPlatformSlotEnvironment`) —
 * clearing a live slot row's markers would reclassify it as
 * tenant-managed and lift the write floor in two steps.
 */
function isPlatformMarkerClearOnlyPatch(body: unknown): boolean {
  if (!isPlainRecord(body)) return false;
  const bodyKeys = Object.keys(body);
  if (bodyKeys.length !== 1 || bodyKeys[0] !== "metadata") return false;
  const metadata = body.metadata;
  if (!isPlainRecord(metadata)) return false;
  const metaKeys = Object.keys(metadata);
  if (metaKeys.length === 0) return false;
  return metaKeys.every(
    (key) =>
      (PLATFORM_PROVISIONED_MARKER_KEYS as readonly string[]).includes(key) &&
      (metadata[key] === null || metadata[key] === false),
  );
}

/**
 * Floor: on cloud-managed instances, platform-provisioned rows are
 * platform-owned runtime state — no actor, including instance admins, may
 * update or delete them. Binds to the persisted row's markers, so a patch
 * cannot strip the marker to lift the floor.
 *
 * Exception: a metadata-only patch that only clears the marker keys is
 * allowed so tenants can recover rows stamped with stale markers by the old
 * unrestricted API — for every row except those whose markers are live
 * platform state (see `isPlatformSlotEnvironment`): there, clearing the
 * markers would let the very next write reclassify the row as
 * tenant-managed and bypass this floor. Every marker outside a live slot
 * is stale by construction, so no row is ever locked unrecoverably.
 */
async function assertPlatformProvisionedEnvironmentWritable(
  environment: { driver: string; metadata: Record<string, unknown> | null },
  options?: {
    patchBody: unknown;
    isForcedKubernetesExecution: () => Promise<boolean>;
  },
): Promise<void> {
  if (!isCloudManagedInstance() || !isPlatformProvisionedEnvironment(environment)) return;
  if (
    options !== undefined &&
    isPlatformMarkerClearOnlyPatch(options.patchBody) &&
    !(await isPlatformSlotEnvironment(environment, options))
  ) return;
  throw forbidden("Platform-provisioned environments are platform-managed on cloud-managed instances", {
    code: "environment_platform_managed",
  });
}

/**
 * Floor: on cloud-managed instances the platform markers in `metadata` are
 * reserved to the platform provisioner (which writes them at the service
 * layer, not through these routes). A client payload that sets them to a
 * truthy value is rejected — otherwise a tenant could stamp its own row as
 * platform-provisioned and permanently lock it behind the write floor above.
 * Clearing (null/false) is allowed so stale markers can be removed.
 */
function assertNoClientPlatformProvisionedMarkers(metadata: unknown): void {
  if (!isCloudManagedInstance() || !isPlainRecord(metadata)) return;
  for (const key of PLATFORM_PROVISIONED_MARKER_KEYS) {
    if (metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== false) {
      throw unprocessable(
        `metadata.${key} is reserved to the platform on cloud-managed instances`,
        { code: "environment_platform_marker_reserved" },
      );
    }
  }
}

export function environmentRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = environmentService(db);
  const customImages = environmentCustomImageService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const executionWorkspaces = executionWorkspaceService(db);
  const issues = issueService(db);
  const instanceSettings = instanceSettingsService(db);
  const projects = projectService(db);
  const secrets = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  function parseObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  function assertCanAccessInstanceEnvironments(req: Request) {
    if (req.actor.type !== "board") {
      throw forbidden("Instance environment management is restricted to board operators");
    }
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    throw forbidden("Instance admin access required");
  }

  function assertCanReadInstanceEnvironments(req: Request) {
    assertBoardOrgAccess(req);
  }

  function assertCustomImageCompanyAccess(req: Request, companyId: string) {
    if (req.actor.type !== "board") {
      throw forbidden("Board access required");
    }
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
  }

  function canReadFullInstanceEnvironment(req: Request) {
    return req.actor.type === "board"
      && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin);
  }

  function redactEnvironmentForRestrictedView<T extends {
    config: Record<string, unknown> | null;
    envVars?: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
  }>(environment: T): T {
    return {
      ...environment,
      config: {},
      ...(Object.prototype.hasOwnProperty.call(environment, "envVars") ? { envVars: {} } : {}),
      metadata: null,
    };
  }

  function presentEnvironmentForRead<T extends {
    config: Record<string, unknown> | null;
    envVars?: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
  }>(req: Request, environment: T): T {
    // Floor: on cloud-managed instances, platform-provisioned rows use one
    // view for every reader — instance admins (including computed
    // owner-admins) never see env vars or credential-shaped config keys, and
    // restricted readers gain the structural fields the redacted view used to
    // blank (the platform config carries no secrets by the managed-config
    // contract).
    if (isCloudManagedInstance() && isPlatformProvisionedEnvironment(environment)) {
      return applyPlatformProvisionedEnvironmentFloor(environment);
    }
    return canReadFullInstanceEnvironment(req)
      ? environment
      : redactEnvironmentForRestrictedView(environment);
  }

  async function assertCanReadSecretsForDraftProbe(req: Request, companyId: string) {
    assertCanAccessInstanceEnvironments(req);
    return companyId;
  }

  async function logInstanceEnvironmentActivity(input: {
    actor: ReturnType<typeof getActorInfo>;
    action: string;
    entityId: string;
    details: Record<string, unknown>;
  }) {
    const companyIds = await instanceSettings.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          agentId: input.actor.agentId,
          runId: input.actor.runId,
          action: input.action,
          entityType: "environment",
          entityId: input.entityId,
          details: input.details,
        })
      ),
    );
  }

  async function logEnvironmentCustomImageActivity(input: {
    actor: ReturnType<typeof getActorInfo>;
    companyId: string;
    action: string;
    entityId: string;
    details: Record<string, unknown>;
  }) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      action: input.action,
      entityType: "environment",
      entityId: input.entityId,
      details: input.details,
    });
  }

  async function resolveCustomImageCompanyId(req: Request): Promise<string> {
    const queryCompanyId =
      typeof req.query.companyId === "string" && req.query.companyId.trim().length > 0
        ? req.query.companyId.trim()
        : null;
    if (queryCompanyId) {
      assertCustomImageCompanyAccess(req, queryCompanyId);
      return queryCompanyId;
    }
    if (req.actor.type === "board" && req.actor.companyIds?.length === 1) {
      return req.actor.companyIds[0]!;
    }
    const companyIds = await instanceSettings.listCompanyIds();
    if (companyIds.length === 1 && companyIds[0]) {
      const companyId = companyIds[0];
      assertCustomImageCompanyAccess(req, companyId);
      return companyId;
    }
    throw unprocessable("companyId query parameter is required for environment customImage setup.");
  }

  async function resolveCustomImageSessionCompanyId(
    req: Request,
    session: { metadata?: Record<string, unknown> | null },
  ): Promise<string> {
    const metadataCompanyId = readCustomImageSetupSessionCompanyId(session);
    if (metadataCompanyId) {
      assertCustomImageCompanyAccess(req, metadataCompanyId);
      return metadataCompanyId;
    }
    return await resolveCustomImageCompanyId(req);
  }

  async function resolveEnvironmentSecretContextCompanyId(
    req: Request,
    environmentId: string,
    options: { required: boolean },
  ): Promise<string | null> {
    const routeCompanyId =
      typeof req.params.companyId === "string" && req.params.companyId.trim().length > 0
        ? req.params.companyId.trim()
        : typeof req.query.companyId === "string" && req.query.companyId.trim().length > 0
          ? req.query.companyId.trim()
          : null;
    const bindingCompanyIds = await secrets.listBindingCompanyIdsForTarget({
      targetType: "environment",
      targetId: environmentId,
    });
    if (routeCompanyId && bindingCompanyIds.length > 0 && !bindingCompanyIds.includes(routeCompanyId)) {
      throw conflict("Environment secret bindings already use a different company context.");
    }
    if (routeCompanyId) return routeCompanyId;
    if (bindingCompanyIds.length === 1) return bindingCompanyIds[0] ?? null;
    if (bindingCompanyIds.length > 1) {
      throw conflict("Environment secret bindings span multiple companies and require explicit companyId context.");
    }
    if (req.actor.type === "agent" && req.actor.companyId) return req.actor.companyId;
    if (req.actor.type === "board" && Array.isArray(req.actor.companyIds) && req.actor.companyIds.length === 1) {
      return req.actor.companyIds[0] ?? null;
    }
    if (!options.required) return null;
    throw unprocessable(
      "Environment secret management requires a companyId context during the instance-scoped transition.",
    );
  }

  function summarizeEnvironmentUpdate(
    patch: Record<string, unknown>,
    environment: {
      name: string;
      driver: string;
      status: string;
    },
  ): Record<string, unknown> {
    const details: Record<string, unknown> = {
      changedFields: Object.keys(patch).sort(),
    };

    if (patch.name !== undefined) details.name = environment.name;
    if (patch.driver !== undefined) details.driver = environment.driver;
    if (patch.status !== undefined) details.status = environment.status;
    if (patch.description !== undefined) details.descriptionChanged = true;
    if (patch.config !== undefined) {
      details.configChanged = true;
      details.configTopLevelKeyCount =
        patch.config && typeof patch.config === "object" && !Array.isArray(patch.config)
          ? Object.keys(patch.config as Record<string, unknown>).length
          : 0;
    }
    if (patch.metadata !== undefined) {
      details.metadataChanged = true;
      details.metadataTopLevelKeyCount =
        patch.metadata && typeof patch.metadata === "object" && !Array.isArray(patch.metadata)
          ? Object.keys(patch.metadata as Record<string, unknown>).length
          : 0;
    }

    return details;
  }

  function environmentDeleteBlockMessage(impact: EnvironmentDeleteBlastRadius): string | null {
    if (impact.staticReferences.isManagedLocal) {
      return "Cannot delete the managed local environment.";
    }
    if (impact.staticReferences.isInstanceDefault) {
      return "Cannot delete the current instance default environment. Set a new default environment before deleting this one.";
    }
    return null;
  }

  function rejectEnvironmentDelete(input: {
    actor: ReturnType<typeof getActorInfo>;
    environment: { id: string; driver: string };
    impact: EnvironmentDeleteBlastRadius;
  }): never {
    const message =
      environmentDeleteBlockMessage(input.impact)
      ?? "Environment delete is currently blocked. Refresh the environment and retry.";
    logger.warn(
      {
        environmentId: input.environment.id,
        environmentDriver: input.environment.driver,
        deleteBlockedReasons: input.impact.deleteBlockedReasons,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
      },
      "environment delete rejected by guard",
    );
    throw conflict(message, { deleteBlockedReasons: input.impact.deleteBlockedReasons });
  }

  function setupSessionActivityDetails(session: {
    id: string;
    environmentId: string;
    provider: string;
    status: string;
    providerLeaseId: string | null;
    baseTemplateRef: string | null;
    connectionSummary?: Record<string, unknown> | null;
    connectionSecretRef: string | null;
    metadata?: Record<string, unknown> | null;
  }) {
    return redactEnvironmentCustomImageSetupSession({
      sessionId: session.id,
      environmentId: session.environmentId,
      provider: session.provider,
      status: session.status,
      providerLeaseId: session.providerLeaseId,
      baseTemplateRef: session.baseTemplateRef,
      connectionSummary: session.connectionSummary,
      connectionSecretRef: session.connectionSecretRef,
      metadata: session.metadata,
    });
  }

  function templateActivityDetails(template: {
    id: string;
    environmentId: string;
    provider: string;
    status: string;
    templateKind: string;
    templateRef: string | null;
    sourceTemplateRef: string | null;
    metadata?: Record<string, unknown> | null;
  }) {
    return redactEnvironmentCustomImageTemplate({
      templateId: template.id,
      environmentId: template.environmentId,
      provider: template.provider,
      status: template.status,
      templateKind: template.templateKind,
      templateRef: template.templateRef,
      sourceTemplateRef: template.sourceTemplateRef,
      metadata: template.metadata,
    });
  }

  function throwTerminalPayloadValidationFailure(
    failure: Extract<EnvironmentCustomImageTerminalPayloadValidationResult, { ok: false }>,
  ): never {
    if (failure.status === 409) {
      throw conflict(failure.message);
    }
    throw unprocessable(failure.message);
  }

  router.get("/companies/:companyId/environments", async (req, res) => {
    assertCanReadInstanceEnvironments(req);
    const rows = await svc.list({
      status: req.query.status as string | undefined,
      driver: req.query.driver as string | undefined,
    });
    res.json(rows.map((row) => presentEnvironmentForRead(req, row)));
  });

  router.get("/environments/:id/delete-blast-radius", async (req, res) => {
    assertCanAccessInstanceEnvironments(req);
    const impact = await svc.getDeleteBlastRadius(req.params.id as string);
    if (!impact) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    res.json(impact);
  });

  router.get("/companies/:companyId/environments/capabilities", async (req, res) => {
    assertCanReadInstanceEnvironments(req);
    const pluginDrivers = await listReadyPluginEnvironmentDrivers({
      db,
      workerManager: options.pluginWorkerManager,
    });
    res.json(getEnvironmentCapabilities(
      AGENT_ADAPTER_TYPES,
      {
        sandboxProviders: Object.fromEntries(pluginDrivers.map((driver) => [
          driver.driverKey,
          {
            status: "supported" as const,
            supportsSavedProbe: true,
            supportsUnsavedProbe: true,
            supportsRunExecution: true,
            supportsReusableLeases: driver.supportsReusableLeases ?? true,
            supportsInteractiveSetup: driver.supportsInteractiveSetup,
            interactiveSetupConnectionTypes: driver.interactiveSetupConnectionTypes,
            supportsTemplateCapture: driver.supportsTemplateCapture,
            templateRefKind: driver.templateRefKind,
            templateConfigBinding: driver.templateConfigBinding,
            supportsTemplateDelete: driver.supportsTemplateDelete,
            displayName: driver.displayName,
            description: driver.description,
            source: "plugin" as const,
            pluginKey: driver.pluginKey,
            pluginId: driver.pluginId,
            configSchema: driver.configSchema,
          },
        ])),
      },
    ));
  });

  router.get("/environments/:environmentId/custom-image-template", async (req, res) => {
    assertCanAccessInstanceEnvironments(req);
    await resolveCustomImageCompanyId(req);
    const overview = await customImages.getOverview({
      environmentId: req.params.environmentId as string,
    });
    res.json(overview);
  });

  router.post(
    "/environments/:environmentId/custom-image-setup-sessions",
    validate(startEnvironmentCustomImageSetupSessionSchema),
    async (req, res) => {
      assertCanAccessInstanceEnvironments(req);
      const companyId = await resolveCustomImageCompanyId(req);
      const actor = getActorInfo(req);
      const result = await customImages.startSetupSession({
        environmentId: req.params.environmentId as string,
        templateId: req.body.templateId ?? null,
        ttlSeconds: req.body.ttlSeconds ?? null,
        actor: {
          userId: actor.actorType === "user" ? actor.actorId : null,
          agentId: actor.agentId,
        },
        secretContextCompanyId: companyId,
      });
      await logEnvironmentCustomImageActivity({
        actor,
        companyId,
        action: "environment.custom_image_setup.started",
        entityId: result.session.environmentId,
        details: setupSessionActivityDetails(result.session),
      });
      res.status(201).json(result);
    },
  );

  router.get("/environment-custom-image-setup-sessions/:sessionId", async (req, res) => {
    assertCanAccessInstanceEnvironments(req);
    const session = await customImages.getSessionById(req.params.sessionId as string);
    if (!session) {
      res.status(404).json({ error: "Environment customImage setup session not found" });
      return;
    }
    await resolveCustomImageSessionCompanyId(req, session);
    const result = await customImages.refreshSetupSession({
      sessionId: session.id,
      includeConnectionPayload: true,
    });
    res.json(result);
  });

  router.post(
    "/environment-custom-image-setup-sessions/:sessionId/terminal-session-token",
    validate(createEnvironmentCustomImageTerminalSessionTokenSchema),
    async (req, res) => {
      assertCanAccessInstanceEnvironments(req);
      const session = await customImages.getSessionById(req.params.sessionId as string);
      if (!session) {
        res.status(404).json({ error: "Environment customImage setup session not found" });
        return;
      }
      const companyId = await resolveCustomImageSessionCompanyId(req, session);

      const refreshed = await customImages.refreshSetupSession({
        sessionId: session.id,
        includeConnectionPayload: true,
      });
      const now = new Date();
      if (refreshed.session.status !== "waiting_for_user") {
        throw conflict(`Cannot create terminal session token from setup status "${refreshed.session.status}".`);
      }
      const setupExpiresAt = requireFutureCustomImageSetupExpiry(refreshed.session, now);
      const payloadValidation = validateCustomImageSetupSshPayload(refreshed.connectionPayload, now);
      if (!payloadValidation.ok) {
        throwTerminalPayloadValidationFailure(payloadValidation);
      }

      const minted = environmentCustomImageTerminalSessionStore.create({
        setupSessionId: refreshed.session.id,
        companyId,
        environmentId: refreshed.session.environmentId,
        provider: refreshed.session.provider,
        ssh: payloadValidation.ssh,
        setupExpiresAt,
        connectionExpiresAt: payloadValidation.connectionExpiresAt,
        now,
      });
      const actor = getActorInfo(req);
      await logEnvironmentCustomImageActivity({
        actor,
        companyId,
        action: "environment.custom_image_terminal_session_token.created",
        entityId: refreshed.session.environmentId,
        details: {
          session: setupSessionActivityDetails(refreshed.session),
          terminalSession: {
            connectionType: "ssh",
            connectExpiresAt: minted.session.connectExpiresAt.toISOString(),
            sessionExpiresAt: minted.session.sessionExpiresAt.toISOString(),
          },
        },
      });
      res.status(201).json({
        id: minted.session.id,
        token: minted.token,
        expiresAt: minted.session.connectExpiresAt.toISOString(),
        setupSessionId: minted.session.setupSessionId,
        environmentId: minted.session.environmentId,
        connectionType: "ssh",
        websocketPath:
          `/api/environment-custom-image-setup-sessions/${encodeURIComponent(minted.session.setupSessionId)}/terminal/ws`
          + `?terminalSessionId=${encodeURIComponent(minted.session.id)}`,
      });
    },
  );

  router.post(
    "/environment-custom-image-setup-sessions/:sessionId/finish",
    validate(finishEnvironmentCustomImageSetupSessionSchema),
    async (req, res) => {
      assertCanAccessInstanceEnvironments(req);
      const session = await customImages.getSessionById(req.params.sessionId as string);
      if (!session) {
        res.status(404).json({ error: "Environment customImage setup session not found" });
        return;
      }
      const companyId = await resolveCustomImageSessionCompanyId(req, session);
      const actor = getActorInfo(req);
      const result = await customImages.finishSetupSession({
        sessionId: session.id,
        metadata: req.body.metadata,
      });
      environmentCustomImageTerminalSessionStore.deleteBySetupSessionId(session.id);
      environmentCustomImageTerminalConnectionRegistry.closeBySetupSessionId(session.id, "setup_finished");
      await logEnvironmentCustomImageActivity({
        actor,
        companyId,
        action: "environment.custom_image_setup.finished",
        entityId: result.session.environmentId,
        details: {
          session: setupSessionActivityDetails(result.session),
          template: templateActivityDetails(result.template),
        },
      });
      res.json(result);
    },
  );

  router.post(
    "/environment-custom-image-setup-sessions/:sessionId/cancel",
    validate(cancelEnvironmentCustomImageSetupSessionSchema),
    async (req, res) => {
      assertCanAccessInstanceEnvironments(req);
      const session = await customImages.getSessionById(req.params.sessionId as string);
      if (!session) {
        res.status(404).json({ error: "Environment customImage setup session not found" });
        return;
      }
      const companyId = await resolveCustomImageSessionCompanyId(req, session);
      const actor = getActorInfo(req);
      const cancelled = await customImages.cancelSetupSession({
        sessionId: session.id,
        reason: req.body.reason ?? null,
      });
      environmentCustomImageTerminalSessionStore.deleteBySetupSessionId(session.id);
      environmentCustomImageTerminalConnectionRegistry.closeBySetupSessionId(session.id, "setup_cancelled");
      await logEnvironmentCustomImageActivity({
        actor,
        companyId,
        action: "environment.custom_image_setup.cancelled",
        entityId: cancelled.environmentId,
        details: setupSessionActivityDetails(cancelled),
      });
      res.json(cancelled);
    },
  );

  router.post("/environments/:environmentId/custom-image-template/rollback", async (req, res) => {
    assertCanAccessInstanceEnvironments(req);
    const companyId = await resolveCustomImageCompanyId(req);
    const actor = getActorInfo(req);
    const result = await customImages.rollbackTemplate({
      environmentId: req.params.environmentId as string,
    });
    await logEnvironmentCustomImageActivity({
      actor,
      companyId,
      action: "environment.custom_image_template.rolled_back",
      entityId: req.params.environmentId as string,
      details: {
        activeTemplate: templateActivityDetails(result.activeTemplate),
        supersededTemplate: templateActivityDetails(result.supersededTemplate),
      },
    });
    res.json(result);
  });

  router.delete("/environments/:environmentId/custom-image-template", async (req, res) => {
    assertCanAccessInstanceEnvironments(req);
    const companyId = await resolveCustomImageCompanyId(req);
    const actor = getActorInfo(req);
    const template = await customImages.disableTemplate({
      environmentId: req.params.environmentId as string,
      deleteProviderTemplate: req.query.deleteProviderTemplate === "true",
    });
    await logEnvironmentCustomImageActivity({
      actor,
      companyId,
      action: "environment.custom_image_template.disabled",
      entityId: req.params.environmentId as string,
      details: templateActivityDetails(template),
    });
    res.json(template);
  });

  router.post("/companies/:companyId/environments", validate(createEnvironmentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCanAccessInstanceEnvironments(req);
    assertNoClientPlatformProvisionedMarkers(req.body.metadata);
    if (req.body.driver === "local") {
      const existingLocal = await svc.list({ driver: "local" });
      if (existingLocal.length > 0) {
        throw conflict("A local environment already exists for this instance.");
      }
    }
    const actor = getActorInfo(req);
    const input = {
      ...req.body,
      envVars: await secrets.normalizeEnvBindingsForPersistence(
        companyId,
        req.body.envVars,
        { strictMode: strictSecretsMode, fieldPath: "envVars" },
      ),
      config: await normalizeEnvironmentConfigForPersistence({
        db,
        companyId,
        environmentName: req.body.name,
        driver: req.body.driver,
        secretProvider: getConfiguredSecretProvider(),
        config: req.body.config,
        actor: {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
        pluginWorkerManager: options.pluginWorkerManager,
      }),
    };
    const environment = await svc.create(input);
    await secrets.syncSecretRefsForTarget(
      companyId,
      { targetType: "environment", targetId: environment.id },
      await collectEnvironmentSecretRefs({ db, environment }),
    );
    await secrets.syncEnvBindingsForTarget(
      companyId,
      { targetType: "environment", targetId: environment.id },
      environment.envVars,
    );
    await logInstanceEnvironmentActivity({
      actor,
      action: "environment.created",
      entityId: environment.id,
      details: {
        name: environment.name,
        driver: environment.driver,
        status: environment.status,
      },
    });
    res.status(201).json(presentEnvironmentForRead(req, environment));
  });

  router.get("/environments/:id", async (req, res) => {
    assertCanReadInstanceEnvironments(req);
    const environment = await svc.getById(req.params.id as string);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    res.json(presentEnvironmentForRead(req, environment));
  });

  router.get("/environments/:id/leases", async (req, res) => {
    assertCanReadInstanceEnvironments(req);
    const environment = await svc.getById(req.params.id as string);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    const leases = await svc.listLeases(environment.id, {
      status: req.query.status as string | undefined,
    });
    res.json(leases);
  });

  router.get("/environment-leases/:leaseId", async (req, res) => {
    assertCanReadInstanceEnvironments(req);
    const lease = await svc.getLeaseById(req.params.leaseId as string);
    if (!lease) {
      res.status(404).json({ error: "Environment lease not found" });
      return;
    }
    res.json(lease);
  });

  router.patch("/environments/:id", validate(updateEnvironmentSchema), async (req, res) => {
    assertCanAccessInstanceEnvironments(req);
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    await assertPlatformProvisionedEnvironmentWritable(existing, {
      patchBody: req.body,
      isForcedKubernetesExecution: async () =>
        isExecutionForcedToKubernetes({
          executionMode: (await instanceSettings.getGeneral()).executionMode,
        }),
    });
    assertNoClientPlatformProvisionedMarkers(req.body.metadata);
    const actor = getActorInfo(req);
    const nextDriver = req.body.driver ?? existing.driver;
    const nextName = req.body.name ?? existing.name;
    const companyIdForSecrets =
      req.body.config !== undefined || req.body.driver !== undefined || req.body.envVars !== undefined
        ? await resolveEnvironmentSecretContextCompanyId(req, existing.id, { required: true })
        : null;
    const configSource =
      req.body.config !== undefined
        ? req.body.driver !== undefined && req.body.driver !== existing.driver
          ? req.body.config
          : {
              ...parseObject(existing.config),
              ...parseObject(req.body.config),
            }
        : req.body.driver !== undefined && req.body.driver !== existing.driver
          ? {}
          : existing.config;
    const patch = {
      ...req.body,
      ...(req.body.envVars !== undefined
        ? {
            envVars: await secrets.normalizeEnvBindingsForPersistence(
              companyIdForSecrets!,
              req.body.envVars,
              { strictMode: strictSecretsMode, fieldPath: "envVars" },
            ),
          }
        : {}),
      ...(req.body.config !== undefined || req.body.driver !== undefined
        ? {
            config: await normalizeEnvironmentConfigForPersistence({
              db,
              companyId: companyIdForSecrets!,
              environmentName: nextName,
              driver: nextDriver,
              secretProvider: getConfiguredSecretProvider(),
              config: configSource,
              actor: {
                agentId: actor.agentId,
                userId: actor.actorType === "user" ? actor.actorId : null,
              },
              pluginWorkerManager: options.pluginWorkerManager,
            }),
          }
        : {}),
    };
    const environment = await svc.update(existing.id, patch);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    let customImageReconciliation: Awaited<
      ReturnType<typeof customImages.reconcileActiveTemplateForConfigChange>
    > = { action: "none" };
    if (patch.config !== undefined || patch.driver !== undefined) {
      await secrets.syncSecretRefsForTarget(
        companyIdForSecrets!,
        { targetType: "environment", targetId: environment.id },
        await collectEnvironmentSecretRefs({ db, environment }),
      );
      try {
        customImageReconciliation = await customImages.reconcileActiveTemplateForConfigChange({
          environmentId: environment.id,
          previous: existing,
          next: environment,
        });
      } catch {
        // Reconciliation is best-effort; a failure must not fail the save.
      }
    }
    if (patch.envVars !== undefined) {
      await secrets.syncEnvBindingsForTarget(
        companyIdForSecrets!,
        { targetType: "environment", targetId: environment.id },
        environment.envVars,
      );
    }
    await logInstanceEnvironmentActivity({
      actor,
      action: "environment.updated",
      entityId: environment.id,
      details: summarizeEnvironmentUpdate(patch as Record<string, unknown>, environment),
    });
    const presented = presentEnvironmentForRead(req, environment);
    res.json(customImageReconciliation.action === "none"
      ? presented
      : { ...presented, customImageReconciliation });
  });

  router.delete("/environments/:id", async (req, res) => {
    assertCanAccessInstanceEnvironments(req);
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    await assertPlatformProvisionedEnvironmentWritable(existing);
    const actor = getActorInfo(req);
    const impact = await svc.getDeleteBlastRadius(existing.id);
    if (!impact) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    if (!impact.canDelete) {
      rejectEnvironmentDelete({ actor, environment: existing, impact });
    }

    const removed = await svc.removeIfDeletable(existing.id);
    if (!removed) {
      const latestImpact = await svc.getDeleteBlastRadius(existing.id);
      if (!latestImpact) {
        res.status(404).json({ error: "Environment not found" });
        return;
      }
      rejectEnvironmentDelete({ actor, environment: existing, impact: latestImpact });
    }
    const companyIds = await instanceSettings.listCompanyIds();
    await Promise.all(
      companyIds.flatMap((companyId) => [
        executionWorkspaces.clearEnvironmentSelection(companyId, existing.id),
        issues.clearExecutionWorkspaceEnvironmentSelection(companyId, existing.id),
        projects.clearExecutionWorkspaceEnvironmentSelection(companyId, existing.id),
        secrets.syncEnvBindingsForTarget(
          companyId,
          { targetType: "environment", targetId: existing.id },
          {},
        ),
        secrets.syncSecretRefsForTarget(
          companyId,
          { targetType: "environment", targetId: existing.id },
          [],
          { replaceAll: true },
        ),
      ]),
    );
    const secretId = readSshEnvironmentPrivateKeySecretId(existing);
    if (secretId) {
      await secrets.remove(secretId);
    }
    await logInstanceEnvironmentActivity({
      actor,
      action: "environment.deleted",
      entityId: removed.id,
      details: {
        name: removed.name,
        driver: removed.driver,
        status: removed.status,
      },
    });
    res.json(presentEnvironmentForRead(req, removed));
  });

  router.post("/environments/:id/probe", async (req, res) => {
    assertCanAccessInstanceEnvironments(req);
    const environment = await svc.getById(req.params.id as string);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    const actor = getActorInfo(req);
    const companyIdForSecrets = await resolveEnvironmentSecretContextCompanyId(req, environment.id, { required: false });
    const companyIdForProbe = companyIdForSecrets
      ?? (environment.driver === "sandbox" ? await resolveCustomImageCompanyId(req) : null);
    if (!companyIdForSecrets) {
      const secretRefs = await collectEnvironmentSecretRefs({ db, environment });
      if (secretRefs.length > 0) {
        throw unprocessable(
          "Environment probe requires an explicit companyId to resolve secret-backed config for this environment.",
        );
      }
    }
    const probe = await probeEnvironment(db, environment, {
      companyId: companyIdForProbe,
      pluginWorkerManager: options.pluginWorkerManager,
      applyCustomImageTemplate: environment.driver === "sandbox",
      acquireSandboxRuntimeLease: environment.driver === "sandbox",
    });
    await logInstanceEnvironmentActivity({
      actor,
      action: "environment.probed",
      entityId: environment.id,
      details: {
        driver: environment.driver,
        ok: probe.ok,
        summary: probe.summary,
      },
    });
    res.json(probe);
  });

  router.post(
    "/companies/:companyId/environments/probe-config",
    validate(probeEnvironmentConfigSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCanAccessInstanceEnvironments(req);
      if (req.body.driver === "sandbox") {
        await assertCanReadSecretsForDraftProbe(req, companyId);
      }
      const actor = getActorInfo(req);
      const normalizedConfig = await normalizeEnvironmentConfigForProbe({
        db,
        companyId,
        driver: req.body.driver,
        config: req.body.config,
        accessContext: {
          actorType: actor.actorType,
          actorId: actor.actorId,
          actorSource: actor.actorSource,
          heartbeatRunId: actor.runId,
        },
        pluginWorkerManager: options.pluginWorkerManager,
      });
      const environment = {
        id: "unsaved",
        companyId,
        name: req.body.name?.trim() || "Unsaved environment",
        description: req.body.description ?? null,
        driver: req.body.driver,
        status: "active" as const,
        config: normalizedConfig,
        envVars: {},
        metadata: req.body.metadata ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const probe = await probeEnvironment(db, environment, {
        companyId,
        pluginWorkerManager: options.pluginWorkerManager,
        resolvedConfig: {
          driver: req.body.driver,
          config: normalizedConfig,
        } as ParsedEnvironmentConfig,
      });
      await logInstanceEnvironmentActivity({
        actor,
        action: "environment.probed_unsaved",
        entityId: "unsaved",
        details: {
          driver: environment.driver,
          ok: probe.ok,
          summary: probe.summary,
          configTopLevelKeyCount: Object.keys(environment.config).length,
        },
      });
      res.json(probe);
    },
  );

  return router;
}
