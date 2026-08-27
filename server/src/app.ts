import express, { Router, type Request as ExpressRequest } from "express";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { derivePaperclipViteHmrPort, type DeploymentExposure, type DeploymentMode } from "@paperclipai/shared";
import type { InspectDatabaseBackupHealthOptions } from "./services/database-backup-health.js";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { applyTrustProxy, parseTrustProxyEnv } from "./middleware/trust-proxy.js";
import {
  IMPORT_TRANSFER_SPOOL_SWEEP_INTERVAL_MS,
  resolveDefaultImportTransferSpoolRoot,
  sweepAbandonedImportTransferSpools,
} from "./services/company-import-transfers.js";
import { companyTransferRunService } from "./services/company-transfer-runs.js";
import { healthRoutes } from "./routes/health.js";
import { cloudRoutes } from "./routes/cloud.js";
import { companyRoutes } from "./routes/companies.js";
import { companySkillRoutes } from "./routes/company-skills.js";
import { companySkillPolicyRoutes } from "./routes/company-skill-policy.js";
import { inboxAgentPolicyRoutes } from "./routes/inbox-agent-policy.js";
import { builtInAgentRoutes } from "./routes/built-in-agents.js";
import { folderRoutes } from "./routes/folders.js";
import { summarySlotRoutes } from "./routes/summary-slots.js";
import { statusCardRoutes } from "./routes/status-cards.js";
import { teamsCatalogRoutes } from "./routes/teams-catalog.js";
import { agentRoutes } from "./routes/agents.js";
import type { SetupTokenSessionService } from "./services/setup-token-session.js";
import {
  buildSetupTokenLoginTransport,
  createProductionSetupTokenSandboxProvider,
  createProductionSetupTokenCleanupStore,
  createSetupTokenSecretWriter,
  createWorkerBoundLoginPtyOpener,
} from "./services/setup-token-transport-binding.js";
import { environmentService } from "./services/environments.js";
import { environmentRuntimeService } from "./services/environment-runtime.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { issueTreeControlRoutes } from "./routes/issue-tree-control.js";
import { caseRoutes } from "./routes/cases.js";
import { fileResourceRoutes } from "./routes/file-resources.js";
import { routineRoutes } from "./routes/routines.js";
import { pipelineRoutes } from "./routes/pipelines.js";
import { environmentRoutes } from "./routes/environments.js";
import { executionWorkspaceRoutes } from "./routes/execution-workspaces.js";
import { goalRoutes } from "./routes/goals.js";
import { onboardingSeedRoutes } from "./routes/onboarding-seed.js";
import { boardChatRoutes } from "./routes/board-chat.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { toolAccessRoutes } from "./routes/tool-access.js";
import { smokeLabRoutes } from "./routes/smoke-lab.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { attentionRoutes } from "./routes/attention.js";
import { decisionTrainingRoutes } from "./routes/decision-training.js";
import { decisionRoutes } from "./routes/decisions.js";
import { decisionQueueRoutes } from "./routes/decision-queues.js";
import type { DecisionServiceOptions } from "./services/decisions.js";
import { userProfileRoutes } from "./routes/user-profiles.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { sidebarPreferenceRoutes } from "./routes/sidebar-preferences.js";
import { resourceMembershipRoutes } from "./routes/resource-memberships.js";
import { inboxDismissalRoutes } from "./routes/inbox-dismissals.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import { instanceSettingsService } from "./services/instance-settings.js";
import { openApiRoutes } from "./routes/openapi.js";
import {
  instanceDatabaseBackupRoutes,
  type InstanceDatabaseBackupService,
} from "./routes/instance-database-backups.js";
import { llmRoutes } from "./routes/llms.js";
import { authRoutes } from "./routes/auth.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { pluginRoutes } from "./routes/plugins.js";
import { mcpGatewayProtocolRoutes, toolGatewayRoutes } from "./routes/tool-gateway.js";
import { adapterRoutes } from "./routes/adapters.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { readBrandedStaticIndexHtml } from "./static-index-html.js";
import { staticUiCacheControl } from "./static-ui-cache.js";
import { applyUiBranding } from "./ui-branding.js";
import { logger } from "./middleware/logger.js";
import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader, type PluginLoader } from "./services/plugin-loader.js";
import {
  SELF_HOSTED_AUTO_INSTALL_KEYS,
  ensureBundledPlugins,
  resolveBundledCatalogRoot,
  resolveBundledPluginInstalls,
} from "./services/bundled-plugins.js";
import { createPluginWorkerManager, type PluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import { createPluginToolDispatcher } from "./services/plugin-tool-dispatcher.js";
import { createToolGatewayService } from "./services/tool-gateway.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import { createPluginJobCoordinator } from "./services/plugin-job-coordinator.js";
import { buildHostServices, flushPluginLogBuffer } from "./services/plugin-host-services.js";
import { createPluginEventBus } from "./services/plugin-event-bus.js";
import { setPluginEventBus } from "./services/activity-log.js";
import { createPluginDevWatcher } from "./services/plugin-dev-watcher.js";
import { createPluginHostServiceCleanup } from "./services/plugin-host-service-cleanup.js";
import { pluginRegistryService } from "./services/plugin-registry.js";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";
import { createCachedViteHtmlRenderer } from "./vite-html-renderer.js";
import { DEFAULT_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT } from "./http/body-limits.js";
import { COMPANY_IMPORT_API_PATH } from "./routes/company-import-paths.js";
import { apiCompression } from "./middleware/api-compression.js";

type UiMode = "none" | "static" | "vite-dev";
const FEEDBACK_EXPORT_FLUSH_INTERVAL_MS = 5_000;
const VITE_DEV_ASSET_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/assets/",
  "/node_modules/",
  "/src/",
];
const VITE_DEV_STATIC_PATHS = new Set([
  "/apple-touch-icon.png",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/favicon.ico",
  "/favicon.svg",
  "/site.webmanifest",
  "/sw.js",
]);

export function isDatabaseConnectionUnavailableError(err: unknown): boolean {
  const error = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (error?.code === "ECONNREFUSED") return true;
  return Boolean(error?.cause && isDatabaseConnectionUnavailableError(error.cause));
}

export function resolveViteHmrPort(serverPort: number): number {
  return derivePaperclipViteHmrPort(serverPort);
}

export function resolveViteHmrHost(bindHost: string): string | undefined {
  const normalized = bindHost.trim().toLowerCase();
  if (
    normalized === "0.0.0.0"
    || normalized === "::"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "localhost"
  ) return undefined;
  return bindHost;
}

export function resolveViteHmrProtocol(value: string | undefined): "ws" | "wss" | undefined {
  if (!value) return undefined;
  if (value === "ws" || value === "wss") return value;
  throw new Error("PAPERCLIP_VITE_HMR_PROTOCOL must be ws or wss");
}

export function listenViteHmrServer(server: HttpServer, port: number, bindHost: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bindHost);
  });
}

export function shouldServeViteDevHtml(req: ExpressRequest): boolean {
  const pathname = req.path;
  if (VITE_DEV_STATIC_PATHS.has(pathname)) return false;
  if (VITE_DEV_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  return req.accepts(["html"]) === "html";
}

export function shouldEnablePrivateHostnameGuard(opts: {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
}): boolean {
  return (
    opts.deploymentExposure === "private" &&
    (opts.deploymentMode === "local_trusted" || opts.deploymentMode === "authenticated")
  );
}

export function createManagedBundledPluginWorkerRecovery(input: {
  managedBundledPluginKeys: readonly string[];
  workerManager: Pick<PluginWorkerManager, "getWorker" | "isRunning" | "stopWorker">;
  getLoader: () => Pick<PluginLoader, "loadSingle"> | null;
}): (plugin: { id: string; pluginKey: string }) => Promise<boolean> {
  const recoverablePluginKeys = new Set(input.managedBundledPluginKeys);
  const inFlightStarts = new Map<string, Promise<boolean>>();

  // A failed attempt can leave behind the dead handle it registered (e.g. the
  // worker process died during initialize, which kills the process without
  // scheduling a restart). No pre-existing handle survives to a recovery
  // attempt — recovery only starts when getWorker() was empty — so discarding
  // the dead handle lets a later capability request retry instead of being
  // blocked by the handle-presence gate until the process restarts. Handles
  // in starting/running/backoff states belong to the worker manager's own
  // lifecycle and are left alone.
  const discardDeadRecoveryHandle = async (plugin: { id: string; pluginKey: string }) => {
    const handle = input.workerManager.getWorker(plugin.id);
    if (!handle || (handle.status !== "crashed" && handle.status !== "stopped")) return;
    try {
      await input.workerManager.stopWorker(plugin.id);
    } catch (err) {
      logger.warn(
        {
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to discard dead plugin worker handle after recovery failure",
      );
    }
  };

  return async (plugin) => {
    if (!recoverablePluginKeys.has(plugin.pluginKey)) return false;

    const inFlight = inFlightStarts.get(plugin.id);
    if (inFlight) return inFlight;

    const startPromise = (async () => {
      if (input.workerManager.getWorker(plugin.id)) {
        return input.workerManager.isRunning(plugin.id);
      }

      const loader = input.getLoader();
      if (!loader) return false;

      try {
        const result = await loader.loadSingle(plugin.id, {
          markErrorOnFailure: false,
        });
        if (result.success === true || input.workerManager.isRunning(plugin.id)) {
          return true;
        }
        await discardDeadRecoveryHandle(plugin);
        return false;
      } catch (err) {
        logger.warn(
          {
            pluginId: plugin.id,
            pluginKey: plugin.pluginKey,
            err: err instanceof Error ? err.message : String(err),
          },
          "managed bundled plugin lazy worker recovery failed",
        );
        await discardDeadRecoveryHandle(plugin);
        throw err;
      }
    })();

    inFlightStarts.set(plugin.id, startPromise);
    try {
      return await startPromise;
    } finally {
      if (inFlightStarts.get(plugin.id) === startPromise) {
        inFlightStarts.delete(plugin.id);
      }
    }
  };
}

export async function createApp(
  db: Db,
  opts: {
    uiMode: UiMode;
    serverPort: number;
    storageService: StorageService;
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    databaseBackupService?: InstanceDatabaseBackupService;
    databaseBackupHealth?: InspectDatabaseBackupHealthOptions;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    allowedHostnames: string[];
    bindHost: string;
    authPublicBaseUrl?: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    instanceId?: string;
    hostVersion?: string;
    localPluginDir?: string;
    pluginMigrationDb?: Db;
    pluginWorkerManager?: PluginWorkerManager;
    decisionServiceOptions: DecisionServiceOptions;
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
    /**
     * `plugins.autoInstall` from the managed config (PAPERCLIP_MANAGED_CONFIG).
     * `null`/absent ⇒ self-hosted: only the built-in kubernetes bundle is
     * ensured, exactly as before. A managed list is resolved against the
     * bundled catalog fail-to-start (see services/bundled-plugins.ts).
     */
    managedPluginAutoInstall?: readonly string[] | null;
    /** Test override for the bundled plugin catalog root. */
    bundledPluginCatalogRoot?: string;
  },
) {
  const app = express();
  app.locals.paperclipDb = db;
  const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  };

  // Respect the operator's `TRUST_PROXY` env var (see middleware/trust-proxy.ts).
  // Default is unset → Express trusts nothing, which is the only safe choice
  // when the server may be reachable without a known reverse proxy in front.
  applyTrustProxy(app, parseTrustProxyEnv(process.env.TRUST_PROXY));

  app.use(COMPANY_IMPORT_API_PATH, express.json({
    limit: PORTABLE_JSON_BODY_LIMIT,
    verify: captureRawBody,
  }));
  app.use(express.json({
    limit: DEFAULT_JSON_BODY_LIMIT,
    verify: captureRawBody,
  }));
  app.use("/api", apiCompression());
  app.use(httpLogger);
  const privateHostnameGateEnabled = shouldEnablePrivateHostnameGuard({
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
  });
  const privateHostnameAllowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });
  app.use(
    privateHostnameGuard({
      enabled: privateHostnameGateEnabled,
      allowedHostnames: opts.allowedHostnames,
      bindHost: opts.bindHost,
    }),
  );
  app.use(
    actorMiddleware(db, {
      deploymentMode: opts.deploymentMode,
      resolveSession: opts.resolveSession,
    }),
  );
  app.use("/api/auth", authRoutes(db));
  if (opts.betterAuthHandler) {
    app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
  }
  app.use(llmRoutes(db));

  const hostServicesDisposers = new Map<string, () => void>();
  const workerManager = opts.pluginWorkerManager ?? createPluginWorkerManager();
  const managedAutoInstallKeys = opts.managedPluginAutoInstall ?? null;
  const bundledCatalogRoot =
    opts.bundledPluginCatalogRoot ?? resolveBundledCatalogRoot(process.env);
  const bundledPluginInstalls = resolveBundledPluginInstalls(
    managedAutoInstallKeys ?? SELF_HOSTED_AUTO_INSTALL_KEYS,
    {
      catalogRoot: bundledCatalogRoot,
      env: process.env,
      enforceCatalogRoot: managedAutoInstallKeys !== null,
    },
  );
  const managedBundledPluginKeys =
    managedAutoInstallKeys !== null
      ? bundledPluginInstalls.map((install) => install.pluginKey)
      : [];
  let runtimePluginLoader: Pick<PluginLoader, "loadSingle"> | null = null;
  // A sibling process can install a managed bundled plugin while this process
  // skips the mid-install row, then finish the row after this process's
  // loadAll() pass. The capabilities route may recover only those managed
  // bundles by starting their ready-but-unstarted worker lazily.
  const recoverManagedBundledPluginWorker =
    managedAutoInstallKeys !== null
      ? createManagedBundledPluginWorkerRecovery({
          managedBundledPluginKeys,
          workerManager,
          getLoader: () => runtimePluginLoader,
        })
      : undefined;

  // Mount API routes
  const api = Router();
  api.use(boardMutationGuard());
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
      databaseBackupHealth: opts.databaseBackupHealth,
    }),
  );
  api.use(openApiRoutes());
  api.use("/cloud", cloudRoutes());
  api.use("/companies", companyRoutes(db, opts.storageService));
  api.use(llmRoutes(db));
  api.use(folderRoutes(db));
  api.use(companySkillRoutes(db));
  api.use(companySkillPolicyRoutes(db));
  api.use(inboxAgentPolicyRoutes(db));
  api.use(builtInAgentRoutes(db));
  api.use(summarySlotRoutes(db));
  api.use(statusCardRoutes(db));
  api.use(teamsCatalogRoutes(db));
  // The setup-token login session service. The router builds it and hands it
  // back through the callback below, so the shutdown hook can cancel every live
  // session (SR-4).
  let setupTokenLoginService: SetupTokenSessionService | null = null;
  // The dedicated proxy IP or CIDR allowlist for the confidential setup-token
  // login responses (SR-7). The global `TRUST_PROXY` setting does not satisfy
  // the guard; an operator sets this allowlist to the real TLS-terminating
  // proxy addresses. An empty value keeps the confidential responses on direct
  // TLS (or a `local_trusted` loopback peer) only.
  const setupTokenLoginProxyAllowlist = (process.env.CLAUDE_LOGIN_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // The explicit operator declaration that a platform edge terminates TLS for
  // every client request (SR-7). This complements the allowlist for managed
  // platforms (Railway, Render, Fly, and the like) where the app socket is
  // always plain HTTP and the edge-proxy peer addresses are not stable or
  // documented, so `CLAUDE_LOGIN_TRUSTED_PROXIES` cannot express them. It is a
  // dedicated, single-purpose setting; the guard still never reads the global
  // `TRUST_PROXY` value.
  const setupTokenLoginEdgeTlsTerminated = /^(1|true|yes|on)$/i.test(
    (process.env.CLAUDE_LOGIN_EDGE_TLS_TERMINATED ?? "").trim(),
  );
  // Bind the production setup-token login transport. It carries the live lease
  // manager, the login-process factory over the sandbox pseudo-terminal, and the
  // durable cleanup store. The factory passes only the fixed command
  // `CLAUDE_SETUP_TOKEN_COMMAND`; it never reads a command from a
  // route, a request body, or an adapter configuration. The durable store and the
  // startup reaper are live now, so a restart reaps a leftover lease.
  //
  // The live sandbox pseudo-terminal opener binds inside the sandbox provider
  // worker, so the server process does not hold the raw sandbox process. The
  // opener drives the worker through the plugin worker manager route gate.
  // The manager mints a host-owned route identifier, permits one
  // active credential pseudo-terminal per worker, binds the worker session
  // identifier one time for output only, and terminalizes the route on every open
  // failure path. With the opener supplied, the provider acquires a lease and the
  // start route drives a live login instead of the fixed 503.
  const setupTokenLoginTransport = buildSetupTokenLoginTransport({
    sandbox: createProductionSetupTokenSandboxProvider({
      environments: environmentService(db),
      environmentRuntime: environmentRuntimeService(db, { pluginWorkerManager: workerManager }),
      openLivePtySession: createWorkerBoundLoginPtyOpener({
        workerManager,
        environments: environmentService(db),
        log: (line) => logger.info(line),
      }),
      log: (line) => logger.info(line),
    }),
    store: createProductionSetupTokenCleanupStore(db),
    // Bind the atomic credential-claim writer, so a completed login transitions
    // the durable row to `stored` and stores the minted token in one control-plane
    // transaction. The writer reads the company and the owner only from the
    // immutable session scope. The confirm-replacement flow owns rotation. Without
    // this writer the router falls back to the deferred, fail-closed 503 and never
    // stores the token.
    completeCredential: createSetupTokenSecretWriter({ db }),
    // Forward the login runner diagnostic lines to the server logger. The
    // runner is the sole producer, and every line is a fixed, non-secret
    // literal. Without this sink the diagnostics fall back to a no-op in
    // production, so a failed login leaves no log trail.
    log: (line) => logger.info(line),
  });
  api.use(
    agentRoutes(db, {
      pluginWorkerManager: workerManager,
      deploymentMode: opts.deploymentMode,
      confidentialProxyAllowlist: setupTokenLoginProxyAllowlist,
      confidentialEdgeTlsTerminated: setupTokenLoginEdgeTlsTerminated,
      setupTokenLogin: setupTokenLoginTransport,
      onSetupTokenLoginService: (service) => {
        // Capture the service, so the graceful-shutdown hook cancels every live
        // session and releases each lease. The standalone scheduled reaper owns
        // the startup and interval lease cleanup now (SR-4).
        setupTokenLoginService = service;
      },
    }),
  );
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(caseRoutes(db, opts.storageService));
  api.use(issueTreeControlRoutes(db));
  api.use(fileResourceRoutes(db));
  api.use(routineRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(pipelineRoutes(db));
  api.use(environmentRoutes(db, {
    pluginWorkerManager: workerManager,
    recoverMissingPluginWorker: recoverManagedBundledPluginWorker
      ? {
        pluginKeys: managedBundledPluginKeys,
        startWorker: recoverManagedBundledPluginWorker,
      }
      : undefined,
  }));
  api.use(executionWorkspaceRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(goalRoutes(db));
  api.use(onboardingSeedRoutes(db));
  api.use(boardChatRoutes(db, { deploymentMode: opts.deploymentMode }));
  api.use(approvalRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(secretRoutes(db));
  const trustedLocalStdioRuntimeHost =
    process.env.PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST
    ?? process.env.PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST
    ?? null;
  api.use(costRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(attentionRoutes(db));
  api.use(decisionTrainingRoutes(db));
  api.use(decisionRoutes(db, opts.decisionServiceOptions));
  api.use(decisionQueueRoutes(db));
  api.use(userProfileRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(sidebarPreferenceRoutes(db));
  api.use(resourceMembershipRoutes(db));
  api.use(inboxDismissalRoutes(db));
  api.use(instanceSettingsRoutes(db));
  if (opts.databaseBackupService) {
    api.use(instanceDatabaseBackupRoutes(opts.databaseBackupService));
  }
  const pluginRegistry = pluginRegistryService(db);
  const eventBus = createPluginEventBus();
  setPluginEventBus(eventBus);
  const jobStore = pluginJobStore(db);
  const lifecycle = pluginLifecycleManager(db, { workerManager });
  const scheduler = createPluginJobScheduler({
    db,
    jobStore,
    workerManager,
  });
  const toolDispatcher = createPluginToolDispatcher({
    workerManager,
    lifecycleManager: lifecycle,
    db,
  });
  const toolGateway = createToolGatewayService(db, {
    pluginToolDispatcher: toolDispatcher,
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
    trustedLocalStdioRuntimeHost,
  });
  // Issue routes are intentionally mounted after the gateway is constructed because
  // issue approval endpoints delegate to it. The intervening routers use distinct
  // route prefixes, so this dependency does not change issue-route precedence.
  api.use(issueRoutes(db, opts.storageService, {
    feedbackExportService: opts.feedbackExportService,
    pluginWorkerManager: workerManager,
    approveToolActionRequest: (input) => toolGateway.approveActionRequest(input),
  }));
  app.use(mcpGatewayProtocolRoutes(toolGateway));
  api.use(toolAccessRoutes(db, {
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
    authPublicBaseUrl: opts.authPublicBaseUrl,
    trustedLocalStdioRuntimeHost,
    toolGateway,
  }));
  api.use(smokeLabRoutes(db, {
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
  }));
  const jobCoordinator = createPluginJobCoordinator({
    db,
    lifecycle,
    scheduler,
    jobStore,
  });
  const hostServiceCleanup = createPluginHostServiceCleanup(lifecycle, hostServicesDisposers);
  let viteHtmlRenderer: ReturnType<typeof createCachedViteHtmlRenderer> | null = null;
  let viteDevServer: { close(): Promise<void> } | null = null;
  let viteHmrServer: HttpServer | null = null;
  const loader = pluginLoader(
    db,
    {
      localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
      migrationDb: opts.pluginMigrationDb,
    },
    {
      workerManager,
      eventBus,
      jobScheduler: scheduler,
      jobStore,
      toolDispatcher,
      lifecycleManager: lifecycle,
      instanceInfo: {
        instanceId: opts.instanceId ?? "default",
        hostVersion: opts.hostVersion ?? "0.0.0",
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
      },
      buildHostHandlers: (pluginId, manifest) => {
        const notifyWorker = (method: string, params: unknown) => {
          const handle = workerManager.getWorker(pluginId);
          if (handle) handle.notify(method, params);
        };
        const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker, {
          pluginWorkerManager: workerManager,
          manifest,
        });
        hostServicesDisposers.set(pluginId, () => services.dispose());
        return createHostClientHandlers({
          pluginId,
          capabilities: manifest.capabilities,
          services,
        });
      },
    },
  );
  runtimePluginLoader = loader;
  api.use(
    toolGatewayRoutes(db, toolGateway),
  );
  api.use(
    pluginRoutes(
      db,
      loader,
      { scheduler, jobStore },
      { workerManager },
      { toolDispatcher },
      { workerManager },
      { toolGateway },
    ),
  );
  api.use(adapterRoutes({
    getNativeRunnerEnabled: async () =>
      (await instanceSettingsService(db).getExperimental()).enableNativeRunner === true,
  }));
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
      authPublicBaseUrl: opts.authPublicBaseUrl,
    }),
  );
  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  app.use(pluginUiStaticRoutes(db, {
    localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
  }));

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (opts.uiMode === "static") {
    // Try published location first (server/ui-dist/), then monorepo dev location (../../ui/dist)
    const candidates = [
      path.resolve(__dirname, "../ui-dist"),
      path.resolve(__dirname, "../../ui/dist"),
    ];
    const uiDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
    if (uiDist) {
      // Hashed asset files (Vite emits them under /assets/<name>.<hash>.<ext>)
      // never change once built, so they can be cached aggressively.
      app.use(
        "/assets",
        express.static(path.join(uiDist, "assets"), {
          maxAge: "1y",
          immutable: true,
        }),
      );
      // Non-hashed static files (favicon.ico, manifest, robots.txt, etc.):
      // short cache so operators who swap them out see the new version
      // reasonably fast, with must-revalidate overrides for index.html and
      // sw.js (see staticUiCacheControl for why those two).
      app.use(
        express.static(uiDist, {
          maxAge: "1h",
          setHeaders(res, filePath) {
            const override = staticUiCacheControl(filePath);
            if (override) {
              res.set("Cache-Control", override);
            }
          },
        }),
      );
      // SPA fallback. Only for non-asset routes — if the browser asks for
      // /assets/something.js that doesn't exist, we must NOT serve the HTML
      // shell: the browser would try to load it as a JavaScript module, fail
      // with a MIME-type error, and cache that broken response. Return 404
      // instead. The index.html response itself is no-cache so a subsequent
      // deploy's updated asset hashes are picked up on next load.
      app.get(/.*/, (req, res) => {
        if (req.path.startsWith("/assets/")) {
          res.status(404).end();
          return;
        }
        res
          .status(200)
          .set("Content-Type", "text/html")
          .set("Cache-Control", "no-cache")
          .end(readBrandedStaticIndexHtml(uiDist));
      });
    } else {
      console.warn("[paperclip] UI dist not found; running in API-only mode");
    }
  }

  if (opts.uiMode === "vite-dev") {
    const uiRoot = path.resolve(__dirname, "../../ui");
    const publicUiRoot = path.resolve(uiRoot, "public");
    const hmrPort = resolveViteHmrPort(opts.serverPort);
    const hmrHost = resolveViteHmrHost(opts.bindHost);
    const hmrProtocol = resolveViteHmrProtocol(process.env.PAPERCLIP_VITE_HMR_PROTOCOL);
    const hmrServer = createHttpServer((_req, res) => {
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("Upgrade Required");
    });
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "custom",
      server: {
        // Listener binding and browser HMR hostname are deliberately separate:
        // exposed branch runtimes stay loopback-only while the browser uses the
        // current MagicDNS hostname through the broker's HTTPS listener.
        host: opts.bindHost,
        middlewareMode: true,
        hmr: {
          server: hmrServer,
          ...(hmrHost ? { host: hmrHost } : {}),
          ...(hmrProtocol ? { protocol: hmrProtocol } : {}),
          port: hmrPort,
          clientPort: hmrPort,
        },
        allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : undefined,
      },
    });
    try {
      await listenViteHmrServer(hmrServer, hmrPort, opts.bindHost);
    } catch (error) {
      await vite.close();
      throw error;
    }
    viteDevServer = vite;
    viteHmrServer = hmrServer;
    viteHtmlRenderer = createCachedViteHtmlRenderer({
      vite,
      uiRoot,
      brandHtml: applyUiBranding,
    });
    const renderViteHtml = viteHtmlRenderer;

    if (fs.existsSync(publicUiRoot)) {
      app.use(express.static(publicUiRoot, { index: false }));
    }
    app.get(/.*/, async (req, res, next) => {
      if (!shouldServeViteDevHtml(req)) {
        next();
        return;
      }
      try {
        const html = await renderViteHtml.render(req.originalUrl);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
    app.use(vite.middlewares);
  }

  app.use(errorHandler);

  jobCoordinator.start();
  scheduler.start();
  let feedbackExportShuttingDown = false;
  let feedbackExportTimer: ReturnType<typeof setInterval> | null = null;
  const disableFeedbackExportFlushes = () => {
    feedbackExportShuttingDown = true;
    if (feedbackExportTimer) {
      clearInterval(feedbackExportTimer);
      feedbackExportTimer = null;
    }
  };
  const flushPendingFeedbackExports = async () => {
    if (feedbackExportShuttingDown) return;
    try {
      await opts.feedbackExportService?.flushPendingFeedbackTraces();
    } catch (err) {
      if (isDatabaseConnectionUnavailableError(err)) {
        disableFeedbackExportFlushes();
        logger.warn({ err }, "Disabling pending feedback export flushes because the database is unavailable");
        return;
      }
      logger.error({ err }, "Failed to flush pending feedback exports");
    }
  };

  feedbackExportTimer = opts.feedbackExportService
    ? setInterval(() => {
      void flushPendingFeedbackExports();
    }, FEEDBACK_EXPORT_FLUSH_INTERVAL_MS)
    : null;
  feedbackExportTimer?.unref?.();
  if (opts.feedbackExportService) {
    void flushPendingFeedbackExports();
  }
  // Abandoned chunked-import spool sweep: hourly (plus once at startup),
  // deleting spool dirs whose transfer saw no activity for 24h and cancelling
  // their still-open ledger runs. Same setInterval + unref + shutdown-clear
  // shape as the feedback export flush above.
  const importTransferSpoolRoot = resolveDefaultImportTransferSpoolRoot();
  const sweepImportTransferSpools = () => {
    sweepAbandonedImportTransferSpools(db, importTransferSpoolRoot)
      .then((result) => {
        if (result.swept > 0) {
          logger.info(result, "swept abandoned company import transfer spools");
        }
      })
      .catch((err) => {
        logger.error({ err }, "abandoned company import transfer spool sweep failed");
      });
  };
  let importTransferSweepTimer: ReturnType<typeof setInterval> | null = setInterval(
    sweepImportTransferSpools,
    IMPORT_TRANSFER_SPOOL_SWEEP_INTERVAL_MS,
  );
  importTransferSweepTimer.unref?.();
  // Startup only (never on the hourly interval — that would kill live
  // applies): apply jobs are in-memory in this single process, so any run
  // still "applying" now was interrupted by the previous shutdown and would
  // otherwise 409 every retry forever. Fail those stranded runs — their
  // spooled parts stay reusable — then run the normal sweep once.
  void companyTransferRunService
    .recoverStrandedApplyingRuns(db)
    .then((recovered) => {
      if (recovered.length > 0) {
        logger.warn(
          { count: recovered.length, runIds: recovered },
          "failed company transfer runs stranded in applying by a restart",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "stranded company transfer apply recovery failed");
    })
    .finally(() => {
      sweepImportTransferSpools();
    });
  void toolDispatcher.initialize().catch((err) => {
    logger.error({ err }, "Failed to initialize plugin tool dispatcher");
  });
  const devWatcher = createPluginDevWatcher(
    lifecycle,
    async (pluginId) => (await pluginRegistry.getById(pluginId))?.packagePath ?? null,
  );
  // Auto-provision bundled plugins so their providers are registered for
  // agent runs. Bundles are excluded from the pnpm
  // workspace and built standalone into the image (see Dockerfile), then
  // installed here from their local paths. This runs BEFORE loadAll() so
  // loadAll() can activate them in the same startup pass.
  //
  // Workers are started exactly once, by loadAll(): the `lifecycle` manager
  // above is constructed without a runtime-capable loader
  // (pluginLifecycleManager(db, { workerManager }) — no `loader` option), so
  // the lifecycle.load() that ensureBundledPlugins performs per newly
  // installed bundle only records the `ready` status and does not spawn a
  // worker (see activateReadyPlugin in services/plugin-lifecycle.ts).
  //
  // Managed instances (`plugins.autoInstall` from PAPERCLIP_MANAGED_CONFIG)
  // drive the key list from the control plane; self-hosted instances keep
  // the pre-existing behavior of ensuring only the kubernetes bundle.
  //
  // Resolution is deliberately synchronous and NOT fail-safe: an
  // unknown key or a path escaping the bundled catalog root throws out of
  // createApp so a managed instance refuses to start (positive allowlist,
  // fail closed).
  // SAFETY: installation is fully fail-safe. Any failure
  // (missing bundle, install error, load error) is caught, logged, and
  // swallowed per plugin so the server ALWAYS finishes booting. A degraded
  // boot (a provider unavailable, some agents cannot run) is strictly
  // preferable to a crash loop.
  //
  // The chain is not awaited here (createApp stays fast), but the settled
  // promise is exposed via `app.locals.bundledPluginsStartup` so boot steps
  // that must not outrun plugin availability — managed sandbox environments
  // (`applyManagedEnvironments`) run before the heartbeat resumes queued
  // runs — can sequence on it. It never rejects.
  const bundledPluginsStartup = ensureBundledPlugins(
    bundledPluginInstalls,
    { registry: pluginRegistry, loader, lifecycle, logger },
    // Managed mode reinstalls soft-uninstalled bundles (the control plane
    // owns provisioning); self-hosted leaves an operator's uninstall alone.
    // Operator-DISABLED plugins are never touched in either mode.
    { reinstallUninstalled: managedAutoInstallKeys !== null },
  )
    .then(() => loader.loadAll())
    .then((result) => {
    if (!result) return;
    for (const loaded of result.results) {
      if (devWatcher && loaded.success && loaded.plugin.packagePath) {
        devWatcher.watch(loaded.plugin.id, loaded.plugin.packagePath);
      }
    }
  }).catch((err) => {
    logger.error({ err }, "Failed to load ready plugins on startup");
  });
  app.locals.bundledPluginsStartup = bundledPluginsStartup;
  // The shutdown hook runs at most once. It caches the in-flight promise, so a
  // second caller (for example the `exit` handler) awaits the same completion
  // instead of starting a second teardown.
  let appServicesShutdown: Promise<void> | null = null;
  const shutdownAppServices = (): Promise<void> => {
    if (appServicesShutdown) return appServicesShutdown;
    appServicesShutdown = (async () => {
      disableFeedbackExportFlushes();
      if (importTransferSweepTimer) {
        clearInterval(importTransferSweepTimer);
        importTransferSweepTimer = null;
      }
      devWatcher?.close();
      viteHtmlRenderer?.dispose();
      void viteDevServer?.close().catch(() => undefined);
      viteHmrServer?.close();
      hostServiceCleanup.disposeAll();
      hostServiceCleanup.teardown();
      // Cancel every live setup-token login session and AWAIT the cancellation,
      // so each direct child stops and the server releases each lease before the
      // caller stops the database and the provider. A lease release that
      // fails stays a durable record for the startup reaper.
      await setupTokenLoginService?.shutdown();
    })();
    return appServicesShutdown;
  };
  app.locals.paperclipShutdown = shutdownAppServices;

  // The `exit` event is synchronous. It cannot await the teardown, so it runs
  // the best-effort cleanup and drops the returned promise. The orderly signal
  // path awaits `shutdownAppServices` in full before the process exits.
  process.once("exit", () => {
    void shutdownAppServices();
  });
  process.once("beforeExit", () => {
    void flushPluginLogBuffer();
  });

  return app;
}
