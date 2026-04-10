import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { healthRoutes } from "./routes/health.js";
import { companyRoutes } from "./routes/companies.js";
import { companySkillRoutes } from "./routes/company-skills.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { routineRoutes } from "./routes/routines.js";
import { executionWorkspaceRoutes } from "./routes/execution-workspaces.js";
import { goalRoutes } from "./routes/goals.js";
import { subAgentRunRoutes } from "./routes/sub-agent-runs.js";
import { teamRoutes } from "./routes/teams.js";
import { projectExtrasRoutes } from "./routes/project-extras.js";
import { roomRoutes } from "./routes/rooms.js";
import { approvalRoutes } from "./routes/approvals.js";
import { githubWebhookRoutes } from "./routes/github-webhooks.js";
import { recruitingRoutes } from "./routes/recruiting.js";
import { secretRoutes } from "./routes/secrets.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import { llmRoutes } from "./routes/llms.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { pluginRoutes } from "./routes/plugins.js";
import { adapterRoutes } from "./routes/adapters.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { agentStreamRoutes } from "./routes/agent-streams.js";
import { leaderProcessRoutes } from "./routes/leader-processes.js";
import { createStreamBus } from "./services/stream-bus.js";
import { createRoomStreamBus } from "./services/room-stream-bus.js";
import { createAgentStreamBus } from "./services/agent-stream-bus.js";
import { createAgentSessionService } from "./services/agent-sessions.js";
import { createLeaderProcessService } from "./services/leader-processes.js";
import { createPm2Backend, ensureLogRotateInstalled } from "./services/process-backend-pm2.js";
import { createWorkspaceProvisioner } from "./services/workspace-provisioner.js";
import { applyUiBranding } from "./ui-branding.js";
import { logger } from "./middleware/logger.js";
import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader } from "./services/plugin-loader.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import { createPluginToolDispatcher } from "./services/plugin-tool-dispatcher.js";
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

type UiMode = "none" | "static" | "vite-dev";
const FEEDBACK_EXPORT_FLUSH_INTERVAL_MS = 5_000;

export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) {
    return serverPort + 10_000;
  }
  return Math.max(1_024, serverPort - 10_000);
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
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    allowedHostnames: string[];
    bindHost: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    instanceId?: string;
    hostVersion?: string;
    localPluginDir?: string;
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const app = express();

  app.use(express.json({
    // Company import/export payloads can inline full portable packages.
    limit: "10mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  app.use(httpLogger);
  const privateHostnameGateEnabled =
    opts.deploymentMode === "authenticated" && opts.deploymentExposure === "private";
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
  app.get("/api/auth/get-session", (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json({
      session: {
        id: `paperclip:${req.actor.source}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user: {
        id: req.actor.userId,
        email: null,
        name: req.actor.source === "local_implicit" ? "Local Board" : null,
      },
    });
  });
  if (opts.betterAuthHandler) {
    app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
  }
  app.use(llmRoutes(db));

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
    }),
  );
  api.use("/companies", companyRoutes(db, opts.storageService));
  api.use(companySkillRoutes(db));
  // agentRoutes's beforeDelete hook needs leaderProcess which is
  // created later in this function. Use a holder closure so the
  // route can look up the current instance when a delete arrives.
  let leaderProcessRef: import("./services/leader-processes.js").LeaderProcessService | null = null;
  api.use(
    agentRoutes(db, {
      beforeDelete: async (agentId) => {
        if (leaderProcessRef) {
          await leaderProcessRef.destroyForAgent({ agentId });
        }
      },
    }),
  );
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService, {
    feedbackExportService: opts.feedbackExportService,
  }));
  api.use(routineRoutes(db));
  api.use(executionWorkspaceRoutes(db));
  api.use(goalRoutes(db));
  api.use(subAgentRunRoutes(db));
  api.use(teamRoutes(db));
  api.use(projectExtrasRoutes(db));
  // Phase 4: shared stream bus primitive. Room + agent adapters sit
  // on top of this single instance. The existing plugin-stream-bus
  // remains unchanged — its own instance is created separately in
  // the plugin loader below.
  const streamBus = createStreamBus();
  const roomStreamBus = createRoomStreamBus(streamBus);
  const agentStreamBus = createAgentStreamBus(streamBus);
  api.use(
    roomRoutes(db, opts.storageService, {
      buses: { room: roomStreamBus, agent: agentStreamBus },
    }),
  );
  api.use(approvalRoutes(db));
  // Phase 5.2d — unauthenticated GitHub PR webhook. HMAC is the auth;
  // we intentionally register it BEFORE any auth gate so GitHub can
  // POST without a session cookie.
  api.use(githubWebhookRoutes(db));
  // Phase 5.2e — Recruiting propose endpoint (wraps the hire_agent
  // approval flow so the UI can submit a single form).
  api.use(recruitingRoutes(db));
  api.use(secretRoutes(db));
  api.use(costRoutes(db));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(instanceSettingsRoutes(db));

  // Phase 4: leader CLI lifecycle — agentSessionService + leaderProcessService
  // + PM2 backend + workspace provisioner. Wired together with the stream
  // buses created above so SSE + CLI start/stop share a single object graph.
  const agentSessions = createAgentSessionService(db);
  const processBackend = createPm2Backend();
  const workspaceProvisioner = createWorkspaceProvisioner({ db });
  const leaderProcess = createLeaderProcessService({
    db,
    sessions: agentSessions,
    workspaces: workspaceProvisioner,
    backend: processBackend,
    instanceId: opts.instanceId ?? "default",
    logger: {
      info: (obj, msg) => logger.info(obj, msg ?? ""),
      warn: (obj, msg) => logger.warn(obj, msg ?? ""),
      error: (obj, msg) => logger.error(obj, msg ?? ""),
    },
  });
  leaderProcessRef = leaderProcess;
  api.use(agentStreamRoutes({ db, agentStreamBus }));
  api.use(leaderProcessRoutes({ db, leaderProcess, backend: processBackend }));
  const hostServicesDisposers = new Map<string, () => void>();
  const workerManager = createPluginWorkerManager();
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
  const jobCoordinator = createPluginJobCoordinator({
    db,
    lifecycle,
    scheduler,
    jobStore,
  });
  const hostServiceCleanup = createPluginHostServiceCleanup(lifecycle, hostServicesDisposers);
  const loader = pluginLoader(
    db,
    { localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR },
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
      },
      buildHostHandlers: (pluginId, manifest) => {
        const notifyWorker = (method: string, params: unknown) => {
          const handle = workerManager.getWorker(pluginId);
          if (handle) handle.notify(method, params);
        };
        const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker);
        hostServicesDisposers.set(pluginId, () => services.dispose());
        return createHostClientHandlers({
          pluginId,
          capabilities: manifest.capabilities,
          services,
        });
      },
    },
  );
  api.use(
    pluginRoutes(
      db,
      loader,
      { scheduler, jobStore },
      { workerManager },
      { toolDispatcher },
      { workerManager },
    ),
  );
  api.use(adapterRoutes());
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
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
      const indexHtml = applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"));
      app.use(express.static(uiDist));
      app.get(/.*/, (_req, res) => {
        res.status(200).set("Content-Type", "text/html").end(indexHtml);
      });
    } else {
      console.warn("[paperclip] UI dist not found; running in API-only mode");
    }
  }

  if (opts.uiMode === "vite-dev") {
    const uiRoot = path.resolve(__dirname, "../../ui");
    const hmrPort = resolveViteHmrPort(opts.serverPort);
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "custom",
      server: {
        middlewareMode: true,
        hmr: {
          host: opts.bindHost,
          port: hmrPort,
          clientPort: hmrPort,
        },
        allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : undefined,
      },
    });

    app.use(vite.middlewares);
    app.get(/.*/, async (req, res, next) => {
      try {
        const templatePath = path.resolve(uiRoot, "index.html");
        const template = fs.readFileSync(templatePath, "utf-8");
        const html = applyUiBranding(await vite.transformIndexHtml(req.originalUrl, template));
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
  }

  app.use(errorHandler);

  jobCoordinator.start();
  scheduler.start();
  const feedbackExportTimer = opts.feedbackExportService
    ? setInterval(() => {
      void opts.feedbackExportService?.flushPendingFeedbackTraces().catch((err) => {
        logger.error({ err }, "Failed to flush pending feedback exports");
      });
    }, FEEDBACK_EXPORT_FLUSH_INTERVAL_MS)
    : null;
  feedbackExportTimer?.unref?.();
  if (opts.feedbackExportService) {
    void opts.feedbackExportService.flushPendingFeedbackTraces().catch((err) => {
      logger.error({ err }, "Failed to flush pending feedback exports");
    });
  }
  void toolDispatcher.initialize().catch((err) => {
    logger.error({ err }, "Failed to initialize plugin tool dispatcher");
  });
  const devWatcher = opts.uiMode === "vite-dev"
    ? createPluginDevWatcher(
      lifecycle,
      async (pluginId) => (await pluginRegistry.getById(pluginId))?.packagePath ?? null,
    )
    : null;
  void loader.loadAll().then((result) => {
    if (!result) return;
    for (const loaded of result.results) {
      if (devWatcher && loaded.success && loaded.plugin.packagePath) {
        devWatcher.watch(loaded.plugin.id, loaded.plugin.packagePath);
      }
    }
  }).catch((err) => {
    logger.error({ err }, "Failed to load ready plugins on startup");
  });
  process.once("exit", () => {
    if (feedbackExportTimer) clearInterval(feedbackExportTimer);
    devWatcher?.close();
    hostServiceCleanup.disposeAll();
    hostServiceCleanup.teardown();
  });
  process.once("beforeExit", () => {
    void flushPluginLogBuffer();
  });

  // Phase 4: PM2 logrotate + leader process reconciliation.
  // Best-effort — any failure is logged but does not block startup.
  ensureLogRotateInstalled().catch((err) => {
    logger.warn({ err }, "pm2-logrotate install failed (logs will not auto-rotate)");
  });
  leaderProcess
    .reconcile()
    .then(async (result) => {
      if (result.reconciled || result.crashed || result.orphanStopped) {
        logger.info(
          { ...result },
          "leader process reconcile completed",
        );
      }

      // Auto-start all leader agents (claude_local) that aren't already running.
      // This ensures leaders are always on after server boot.
      try {
        const { agents: agentsSchema } = await import("@paperclipai/db");
        const { eq, and, ne } = await import("drizzle-orm");
        const allLeaders = await (db as any)
          .select({ id: agentsSchema.id, companyId: agentsSchema.companyId, name: agentsSchema.name })
          .from(agentsSchema)
          .where(
            and(
              eq(agentsSchema.adapterType, "claude_local"),
              ne(agentsSchema.status, "terminated"),
            ),
          );

        if (allLeaders.length === 0) return;

        // Check which ones are already running
        const running = new Set<string>();
        for (const leader of allLeaders) {
          const detail = await leaderProcess.status({ agentId: leader.id });
          if (detail?.alive) running.add(leader.id);
        }

        const toStart = allLeaders.filter((a: any) => !running.has(a.id));
        if (toStart.length === 0) {
          logger.info({ alreadyRunning: running.size }, "all leader agents already running");
          return;
        }

        let ok = 0;
        let fail = 0;
        for (const leader of toStart) {
          try {
            await leaderProcess.start({ companyId: leader.companyId, agentId: leader.id });
            ok++;
            logger.info({ agentId: leader.id, name: leader.name }, "auto-started leader agent");
          } catch (err: any) {
            fail++;
            logger.warn({ agentId: leader.id, name: leader.name, err: err?.message }, "failed to auto-start leader agent");
          }
        }
        logger.info({ started: ok, failed: fail, alreadyRunning: running.size, total: allLeaders.length }, "leader auto-start completed");
      } catch (err) {
        logger.error({ err }, "leader auto-start failed");
      }
    })
    .catch((err) => {
      logger.error({ err }, "leader process reconcile failed");
    });

  // Periodic reconcile — catches runtime crashes that happen AFTER
  // startup. Without this, a leader that crashes at 2pm stays in
  // DB-"running" forever until someone manually restarts, calls
  // /cli/status while reconcile happens to run, or reboots the
  // server. 30s is a compromise between detection latency and DB
  // load (reconcile is O(leaders) + O(pm2-list), both cheap).
  const reconcileInterval = setInterval(() => {
    leaderProcess
      .reconcile()
      .then((result) => {
        if (result.crashed || result.orphanStopped) {
          logger.warn(
            { ...result },
            "periodic reconcile corrected drift",
          );
        }
      })
      .catch((err) => {
        logger.error({ err }, "periodic reconcile failed");
      });
  }, 30_000);
  reconcileInterval.unref();
  process.once("exit", () => clearInterval(reconcileInterval));

  return app;
}
