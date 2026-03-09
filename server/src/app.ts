import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { logger } from "./middleware/logger.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { healthRoutes } from "./routes/health.js";
import { companyRoutes } from "./routes/companies.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { goalRoutes } from "./routes/goals.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { llmRoutes } from "./routes/llms.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { pluginRoutes } from "./routes/plugins.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader } from "./services/plugin-loader.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import { createPluginToolDispatcher } from "./services/plugin-tool-dispatcher.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import { createPluginJobCoordinator } from "./services/plugin-job-coordinator.js";
import { buildHostServices } from "./services/plugin-host-services.js";
import { createPluginEventBus } from "./services/plugin-event-bus.js";
import { subscribeDomainEvents, publishGlobalLiveEvent } from "./services/index.js";
import { createPluginDevWatcher } from "./services/plugin-dev-watcher.js";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";

type UiMode = "none" | "static" | "vite-dev";

/**
 * Configuration options for the Paperclip application.
 */
export interface AppOptions {
  /** How to serve the UI: 'none' (API only), 'static' (compiled dist), or 'vite-dev' (HMR). */
  uiMode: UiMode;
  /** Service for handling file uploads and asset storage. */
  storageService: StorageService;
  /** Deployment mode: 'local' or 'authenticated'. */
  deploymentMode: DeploymentMode;
  /** Network exposure: 'public' or 'private'. */
  deploymentExposure: DeploymentExposure;
  /** List of hostnames allowed to access the server (enforced in private mode). */
  allowedHostnames: string[];
  /** The host interface to bind to (e.g., 'localhost' or '0.0.0.0'). */
  bindHost: string;
  /** Whether the authentication system is fully configured and ready. */
  authReady: boolean;
  /** Whether company deletion is enabled in the UI/API. */
  companyDeletionEnabled: boolean;
  /** Unique ID for this server instance (used for multi-instance coordination). */
  instanceId?: string;
  /** The version of the host application (passed to plugins). */
  hostVersion?: string;
  /** Directory where plugins are installed. Defaults to ~/.paperclip/plugins/ */
  localPluginDir?: string;
  /** Optional middleware handler for Better Auth. */
  betterAuthHandler?: express.RequestHandler;
  /** Optional function to resolve the current session from a request. */
  resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
}

/**
 * Creates and configures the Paperclip Express application.
 *
 * This function initializes all domain services, mounts API and plugin routes,
 * sets up authentication and hostname guarding, and starts the plugin runtime services.
 *
 * @param db - The database connection instance.
 * @param opts - Application configuration options.
 * @returns An object containing the Express app and a shutdown function.
 */
export async function createApp(
  db: Db,
  opts: AppOptions,
) {
  const app = express();

  app.use(express.json());
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
    app.all("/api/auth/*authPath", opts.betterAuthHandler);
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
  api.use("/companies", companyRoutes(db));
  api.use(agentRoutes(db));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db));
  api.use(secretRoutes(db));
  api.use(costRoutes(db));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  // ---------------------------------------------------------------------------
  // Plugin runtime services — job scheduler, worker manager, tool dispatcher
  // ---------------------------------------------------------------------------
  const workerManager = createPluginWorkerManager({
    onWorkerEvent(event) {
      publishGlobalLiveEvent({
        type: event.type,
        payload: {
          pluginId: event.pluginId,
          code: event.code ?? null,
          signal: event.signal ?? null,
          willRestart: event.willRestart ?? null,
        },
      });
    },
  });
  const eventBus = createPluginEventBus();

  // Bridge core domain events to the plugin event bus. This allows plugins to
  // react to things like issue creation, agent status changes, etc.
  const unsubscribeDomainEvents = subscribeDomainEvents((event) => {
    void eventBus.emit(event).catch((err) => {
      logger.error({ err, eventType: event.eventType }, "Failed to bridge domain event to plugin bus");
    });
  });

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

  // Create the plugin loader with full runtime services
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
        // Lazy notifyWorker — the worker handle doesn't exist yet at build
        // time, so we look it up on each call (which only happens after the
        // worker is running and sending RPC requests).
        const notifyWorker = (method: string, params: unknown) => {
          const handle = workerManager.getWorker(pluginId);
          if (handle) handle.notify(method, params);
        };
        const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker);
        return createHostClientHandlers({
          pluginId,
          capabilities: manifest.capabilities,
          services,
        });
      },
    },
  );

  // Mount plugin API routes with all optional deps wired in
  api.use(
    pluginRoutes(
      db,
      loader,
      { scheduler, jobStore },     // jobDeps
      { workerManager },            // webhookDeps
      { toolDispatcher },           // toolDeps
      { workerManager },            // bridgeDeps
    ),
  );
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

  // Mount plugin UI static file serving at /_plugins/:pluginId/ui/*
  // This must come after auth middleware but before the main UI fallback route.
  // See PLUGIN_SPEC.md §19.0.3 — Bundle Serving
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
      const indexHtml = fs.readFileSync(path.join(uiDist, "index.html"), "utf-8");
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
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "spa",
      server: {
        middlewareMode: true,
        allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : undefined,
      },
    });

    app.use(vite.middlewares);
    app.get(/.*/, async (req, res, next) => {
      try {
        const templatePath = path.resolve(uiRoot, "index.html");
        const template = fs.readFileSync(templatePath, "utf-8");
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
  }

  app.use(errorHandler);

  // ---------------------------------------------------------------------------
  // Start plugin runtime services
  // ---------------------------------------------------------------------------
  jobCoordinator.start();
  scheduler.start();

  // Initialize tool dispatcher — loads tools from all ready plugins and
  // subscribes to lifecycle events for dynamic tool registration/removal.
  void toolDispatcher.initialize().catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to initialize plugin tool dispatcher",
    );
  });

  // Dev watcher — watches local-path plugins for file changes and restarts workers
  const devWatcher = createPluginDevWatcher(lifecycle);

  // Load and activate all plugins that are in 'ready' status, then start
  // watching any local-path plugins for file changes.
  void loader.loadAll().then((result) => {
    if (result) {
      for (const loaded of result.results) {
        if (loaded.success && loaded.plugin.packagePath) {
          devWatcher.watch(loaded.plugin.id, loaded.plugin.packagePath);
        }
      }
    }
  }).catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to load ready plugins on startup",
    );
  });

  logger.info("Plugin runtime services started (scheduler, worker manager, tool dispatcher, loader)");

  /**
   * Gracefully shut down plugin runtime services.
   *
   * Call this when the server is stopping to:
   * 1. Stop the job scheduler tick loop
   * 2. Tear down the tool dispatcher (unsubscribe lifecycle events)
   * 3. Stop all plugin worker processes (graceful drain → SIGTERM → SIGKILL)
   */
  async function shutdownPlugins(): Promise<void> {
    logger.info("Shutting down plugin runtime services…");

    unsubscribeDomainEvents();
    devWatcher.close();
    jobCoordinator.stop();
    scheduler.stop();
    toolDispatcher.teardown();
    await workerManager.stopAll();

    logger.info("Plugin runtime services stopped");
  }

  return { app, shutdownPlugins };
}
