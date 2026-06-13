import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { issues, plugins, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { appendPublicUrl } from "./middleware/append-public-url.js";
import { healthRoutes } from "./routes/health.js";
import { companyRoutes } from "./routes/companies.js";
import { companySkillRoutes } from "./routes/company-skills.js";
import { teamsCatalogRoutes } from "./routes/teams-catalog.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { issueTreeControlRoutes } from "./routes/issue-tree-control.js";
import { fileResourceRoutes } from "./routes/file-resources.js";
import { routineRoutes } from "./routes/routines.js";
import { environmentRoutes } from "./routes/environments.js";
import { executionWorkspaceRoutes } from "./routes/execution-workspaces.js";
import { goalRoutes } from "./routes/goals.js";
import { boardChatRoutes } from "./routes/board-chat.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { userProfileRoutes } from "./routes/user-profiles.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { sidebarPreferenceRoutes } from "./routes/sidebar-preferences.js";
import { resourceMembershipRoutes } from "./routes/resource-memberships.js";
import { inboxDismissalRoutes } from "./routes/inbox-dismissals.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import { openApiRoutes } from "./routes/openapi.js";
import {
  instanceDatabaseBackupRoutes,
  type InstanceDatabaseBackupService,
} from "./routes/instance-database-backups.js";
import { llmRoutes } from "./routes/llms.js";
import { ccrotateRoutes } from "./routes/ccrotate.js";
import { agentImageBumpRoutes } from "./routes/agent-image-bump.js";
import { authRoutes } from "./routes/auth.js";
import { linearAuthRoutes } from "./routes/linear-auth.js";
import { githubWebhookRoutes } from "./routes/github-webhook.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { workspaceScanRoutes } from "./routes/workspace-scan.js";
import { loadConfig } from "./config.js";
import { pluginRoutes } from "./routes/plugins.js";
import { adapterRoutes } from "./routes/adapters.js";
import { metricsIngestRoutes } from "./routes/metrics-ingest.js";
import { renderMetrics } from "./services/metrics.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { readBrandedStaticIndexHtml } from "./static-index-html.js";
import { applyUiBranding } from "./ui-branding.js";
import { logger } from "./middleware/logger.js";
import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader } from "./services/plugin-loader.js";
import { createPluginWorkerManager, type PluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import { createPluginToolDispatcher } from "./services/plugin-tool-dispatcher.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import { createPluginJobCoordinator } from "./services/plugin-job-coordinator.js";
import { buildHostServices, flushPluginLogBuffer } from "./services/plugin-host-services.js";
import { createPluginEventBus } from "./services/plugin-event-bus.js";
import { setPluginEventBus, setPluginEventOutboxDb } from "./services/activity-log.js";
import { startPluginEventOutbox } from "./services/plugin-event-outbox.js";
import { createPluginDevWatcher } from "./services/plugin-dev-watcher.js";
import { createPluginHostServiceCleanup } from "./services/plugin-host-service-cleanup.js";
import { pluginRegistryService } from "./services/plugin-registry.js";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";
import { createCachedViteHtmlRenderer } from "./vite-html-renderer.js";
import { registerBodyParsers } from "./http/body-parsers.js";

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
const PRECOMPRESSED_STATIC_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".txt",
  ".wasm",
]);
const STATIC_CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

export function isDatabaseConnectionUnavailableError(err: unknown): boolean {
  const error = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (error?.code === "ECONNREFUSED") return true;
  return Boolean(error?.cause && isDatabaseConnectionUnavailableError(error.cause));
}

export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) {
    return serverPort + 10_000;
  }
  return Math.max(1_024, serverPort - 10_000);
}

export function resolveViteHmrHost(bindHost: string): string | undefined {
  const normalized = bindHost.trim().toLowerCase();
  if (normalized === "0.0.0.0" || normalized === "::") return undefined;
  return bindHost;
}

export function shouldServeViteDevHtml(req: ExpressRequest): boolean {
  const pathname = req.path;
  if (VITE_DEV_STATIC_PATHS.has(pathname)) return false;
  if (VITE_DEV_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  return req.accepts(["html"]) === "html";
}

function acceptsGzip(req: ExpressRequest): boolean {
  const header = req.headers["accept-encoding"];
  const value = Array.isArray(header) ? header.join(",") : (header ?? "");
  return /\bgzip\b/i.test(value);
}

function createPrecompressedStaticMiddleware(rootDir: string): express.RequestHandler {
  const root = path.resolve(rootDir);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (req.headers.range || !acceptsGzip(req)) {
      next();
      return;
    }

    const extension = path.extname(req.path);
    if (!PRECOMPRESSED_STATIC_EXTENSIONS.has(extension)) {
      next();
      return;
    }

    let assetPath: string;
    try {
      assetPath = path.resolve(root, `.${req.path}`);
    } catch {
      next();
      return;
    }
    if (assetPath !== root && !assetPath.startsWith(rootPrefix)) {
      next();
      return;
    }

    const gzipPath = `${assetPath}.gz`;
    let assetStat: fs.Stats;
    let gzipStat: fs.Stats;
    try {
      assetStat = fs.statSync(assetPath);
      gzipStat = fs.statSync(gzipPath);
    } catch {
      next();
      return;
    }
    if (!assetStat.isFile() || !gzipStat.isFile() || gzipStat.mtimeMs + 1000 < assetStat.mtimeMs) {
      next();
      return;
    }

    const contentType = STATIC_CONTENT_TYPES.get(extension);
    if (contentType) {
      res.set("Content-Type", contentType);
    }
    res
      .status(200)
      .set("Cache-Control", "public, max-age=31536000, immutable")
      .set("Content-Encoding", "gzip")
      .set("Content-Length", String(gzipStat.size))
      .set("Last-Modified", assetStat.mtime.toUTCString())
      .vary("Accept-Encoding");

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(gzipPath);
    stream.on("error", next);
    stream.pipe(res);
  };
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
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    allowedHostnames: string[];
    bindHost: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    authPublicBaseUrl?: string | null;
    instanceId?: string;
    hostVersion?: string;
    localPluginDir?: string;
    pluginMigrationDb?: Db;
    pluginWorkerManager?: PluginWorkerManager;
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
    /** Random per-process token for trusted loopback bootstrap. */
    internalBootstrapToken?: string;
  },
) {
  const app = express();
  // JSON + urlencoded + raw catch-all, each capturing req.rawBody so the
  // API->worker proxy can forward the exact provider-signed bytes for HMAC
  // verification. See server/src/http/body-parsers.ts.
  registerBodyParsers(app);

  // Prometheus exposition (BLO-8328). Mounted ahead of httpLogger and
  // actorMiddleware: scrapes are unauthenticated (access is gated at the
  // network layer by the ServiceMonitor scrape-allow NetworkPolicy) and would
  // otherwise spam request logs every scrape interval.
  app.get("/metrics", async (_req, res, next) => {
    try {
      const { contentType, body } = await renderMetrics();
      res.status(200).set("Content-Type", contentType).send(body);
    } catch (err) {
      next(err);
    }
  });

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
      internalBootstrapToken: opts.internalBootstrapToken,
    }),
  );
  app.use("/api/auth", authRoutes(db));
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
  // Integrations discovery — tells the UI which optional features are available
  // Linear integration is now fully handled by the paperclip-plugin-linear plugin.
  const appConfig = loadConfig();
  app.get("/api/integrations", (_req, res) => {
    res.json({
      linear: !!appConfig.linearOAuthClientId,
    });
  });

  // Minimal OAuth callback page — captures the code from Linear and sends it
  // back to the opener window via postMessage. The plugin settings UI listens
  // for this message and exchanges the code for a token via the plugin action.
  app.get("/api/auth/linear/callback", (req, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const error = req.query.error as string | undefined;
    res.status(200).set("Content-Type", "text/html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Linear OAuth</title>
<style>body{background:#0a0a0a;color:#a1a1aa;font-family:ui-monospace,monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{text-align:center;padding:2rem}.icon{font-size:48px;margin-bottom:1rem}h1{font-size:14px;font-weight:500;margin:0 0 .5rem}p{font-size:12px;color:#52525b;margin:0}</style></head>
<body><div class="card">
<div class="icon">${error ? "&#10007;" : "&#10003;"}</div>
<h1>${error ? "OAuth Error: " + error : "Connecting to Linear..."}</h1>
<p>${error ? "Please try again." : "This window will close automatically."}</p>
</div>
<script>
if(window.opener){window.opener.postMessage({type:"linear-oauth-callback",code:${JSON.stringify(code ?? null)},state:${JSON.stringify(state ?? null)},error:${JSON.stringify(error ?? null)}},"*")}
${error ? "" : "setTimeout(function(){window.close()},2000)"}
</script></body></html>`);
  });

  // The /api/auth/{*authPath} catch-all that routes everything else to
  // betterAuthHandler is mounted further down, after the linear-auth router
  // is wired with its plugin-job dependencies (see "Mount linear-auth router"
  // below). Mounting the catch-all here would 404 the linear endpoints before
  // the scheduler-aware router gets a chance to handle them.

  app.use(llmRoutes(db));

  const hostServicesDisposers = new Map<string, () => void>();
  // Forward reference: the worker manager's onWorkerEvent (below) must reach the
  // host-service cleanup controller, but that controller is constructed later
  // (it depends on the plugin lifecycle). onWorkerEvent only fires at runtime on
  // a worker crash — long after init completes — so a forward reference is safe.
  let hostServiceCleanup: ReturnType<typeof createPluginHostServiceCleanup> | undefined;
  const { createPluginStreamBus } = await import("./services/plugin-stream-bus.js");
  const streamBus = createPluginStreamBus();
  const workerManager = opts.pluginWorkerManager ?? createPluginWorkerManager({
    onStreamNotification: (pluginId, method, params) => {
      const channel = String(params.channel ?? "");
      const companyId = String(params.companyId ?? "");
      if (!channel) return;
      if (method === "streams.emit") {
        streamBus.publish(pluginId, channel, companyId, params.event ?? params.data);
      } else if (method === "streams.close") {
        streamBus.publish(pluginId, channel, companyId, null, "close");
      } else if (method === "streams.open") {
        streamBus.publish(pluginId, channel, companyId, null, "open");
      }
    },
    // On a worker crash, dispose that plugin's host-service subscriptions so the
    // auto-restarted generation re-subscribes cleanly instead of leaving stale
    // (duplicate) event handlers registered. Each leaked handler multiplies the
    // host→worker notification fan-out that drives off-heap stdin buildup.
    onWorkerEvent: (event) => {
      if (event.type === "plugin.worker.crashed") {
        hostServiceCleanup?.handleWorkerEvent({
          type: event.type,
          pluginId: event.pluginId,
        });
      }
    },
  });

  // Mount API routes
  const api = Router();
  api.use(boardMutationGuard());
  api.use(
    "/health",
    appendPublicUrl(opts.authPublicBaseUrl ?? null),
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
    }),
  );
  api.use(openApiRoutes());
  api.use("/companies", companyRoutes(db, opts.storageService));
  api.use(llmRoutes(db));
  api.use(companySkillRoutes(db));
  api.use(teamsCatalogRoutes(db));
  api.use(agentRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService, {
    feedbackExportService: opts.feedbackExportService,
    pluginWorkerManager: workerManager,
  }));
  api.use(issueTreeControlRoutes(db));
  api.use(fileResourceRoutes(db));
  api.use(routineRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(environmentRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(executionWorkspaceRoutes(db));
  api.use(goalRoutes(db));
  api.use(boardChatRoutes(db, { deploymentMode: opts.deploymentMode }));
  api.use(approvalRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(secretRoutes(db));
  api.use(costRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
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
  // Plugin domain events are enqueued to a DB outbox (every tier) and emitted
  // by a single worker-tier poller, so events raised on the API tier (where
  // plugins aren't loaded) still reach subscribed plugins. See plugin-event-outbox.ts.
  setPluginEventOutboxDb(db);
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

  // Mount linear-auth router. Delegates /import and /sync to the linear
  // plugin's initial-import / periodic-sync jobs (see linear-auth.ts), so the
  // UI buttons share secrets/teamId with the working webhook sync code path
  // instead of the legacy GraphQL fetch (which derived teamKey from the first
  // issue's identifier prefix and ran against a separate token store —
  // produced "0 synced, N errors" in the BLO Linear deployment).
  const triggerLinearPluginJob = async (jobKey: "initial-import" | "periodic-sync") => {
    const [pluginRow] = await db
      .select({ id: plugins.id })
      .from(plugins)
      .where(eq(plugins.pluginKey, "paperclip-plugin-linear"))
      .limit(1);
    if (!pluginRow) return null;
    const job = await jobStore.getJobByKey(pluginRow.id, jobKey);
    if (!job) return null;
    return await scheduler.triggerJob(job.id, "manual");
  };
  app.use(
    "/api/auth/linear",
    linearAuthRoutes(db, {
      clientId: appConfig.linearOAuthClientId,
      clientSecret: appConfig.linearOAuthClientSecret,
      redirectUri: appConfig.linearOAuthRedirectUri,
      secretsProvider: appConfig.secretsProvider,
      triggerPluginJob: triggerLinearPluginJob,
      // 2026-05-06 BLO-3182 RCA: Linear comments must drive a wake on
      // the issue's assignee, not just sit silently in the comment
      // thread. We construct heartbeatService lazily so the existing
      // route signature stays clean. enqueueWakeup is no-op-safe when
      // the assignee is missing or paused.
      wakeIssueAssigneeOnComment: async (input) => {
        const [issueRow] = await db
          .select({ assigneeAgentId: issues.assigneeAgentId })
          .from(issues)
          .where(eq(issues.id, input.issueId))
          .limit(1);
        if (!issueRow?.assigneeAgentId) return;
        const { heartbeatService } = await import("./services/heartbeat.js");
        const heartbeat = heartbeatService(db, { pluginWorkerManager: workerManager });
        await heartbeat.wakeup(issueRow.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "linear_comment",
          payload: {
            issueId: input.issueId,
            commentId: input.commentId,
            source: "linear",
          },
          contextSnapshot: {
            issueId: input.issueId,
            taskId: input.issueId,
            commentId: input.commentId,
            wakeReason: "issue_commented",
            wakeSource: "automation",
            wakeTriggerDetail: "system",
            commentSource: "linear",
            commentAuthor: input.linearCommentAuthor,
          },
        });
      },
    }),
  );
  if (opts.betterAuthHandler) {
    app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
  }

  // 2026-05-06 BLO-3182 RCA Phase D: GitHub webhook receiver. CI is the
  // priority external trigger ("particularly CI job completion since
  // that takes a long time" per operator) -- a 13-min round-trip
  // (8min CI + 5min heartbeat tick) just to react to a failure was
  // the operator-facing pain. The route is HMAC-verified against
  // GITHUB_WEBHOOK_SECRET and refuses every request when the secret
  // isn't configured.
  app.use(
    "/api/webhooks/github",
    githubWebhookRoutes(db, {
      webhookSecret: appConfig.githubWebhookSecret || null,
      pluginWorkerManager: workerManager,
      prReviewerAgentId: appConfig.githubPrReviewerAgentId || null,
      dependabotAgentId: appConfig.githubDependabotAgentId || null,
      dependabotMinSeverity: (["low", "medium", "high", "critical"] as const).find(
        (level) => level === appConfig.githubDependabotMinSeverity,
      ),
    }),
  );

  hostServiceCleanup = createPluginHostServiceCleanup(lifecycle, hostServicesDisposers);
  let viteHtmlRenderer: ReturnType<typeof createCachedViteHtmlRenderer> | null = null;
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
        const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker, lifecycle, {
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
  api.use(
    pluginRoutes(
      db,
      loader,
      { scheduler, jobStore },
      { workerManager },
      { toolDispatcher },
      { workerManager, streamBus },
      {
        nodeRole: appConfig.paperclipNodeRole,
        workersInternalUrl: appConfig.paperclipWorkersInternalUrl,
      },
    ),
  );
  api.use(adapterRoutes());
  // Adapter-originated metric ingestion (BLO-8328): the claude_k8s adapter
  // reports dispatch refusals here; the handler applies the cardinality
  // guardrail and increments the counter exposed on /metrics.
  api.use(metricsIngestRoutes(db));
  api.use(workspaceScanRoutes());
  // ccrotate pool status — used by in-cluster health-check CronJob and any
  // agent that wants to query pool depth without `kubectl exec`. Mounts at
  // /api/ccrotate/status (the inner router defines /status).
  api.use("/ccrotate", ccrotateRoutes());
  api.use(agentImageBumpRoutes(db));
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
      // Hashed asset files (Vite emits them under /assets/<name>.<hash>.<ext>)
      // never change once built, so they can be cached aggressively.
      app.use(
        "/assets",
        createPrecompressedStaticMiddleware(path.join(uiDist, "assets")),
        express.static(path.join(uiDist, "assets"), {
          maxAge: "1y",
          immutable: true,
        }),
      );
      // Non-hashed static files (favicon.ico, manifest, robots.txt, etc.):
      // short cache so operators who swap them out see the new version
      // reasonably fast. Override for `index.html` specifically — it is
      // served by this middleware for `/` and `/index.html`, and it must
      // never outlive the asset hashes it points at.
      app.use(
        express.static(uiDist, {
          maxAge: "1h",
          setHeaders(res, filePath) {
            if (path.basename(filePath) === "index.html") {
              res.set("Cache-Control", "no-cache");
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
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "custom",
      server: {
        middlewareMode: true,
        hmr: {
          ...(hmrHost ? { host: hmrHost } : {}),
          port: hmrPort,
          clientPort: hmrPort,
        },
        allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : undefined,
      },
    });
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
  void toolDispatcher.initialize().catch((err) => {
    logger.error({ err }, "Failed to initialize plugin tool dispatcher");
  });
  const devWatcher = createPluginDevWatcher(
    lifecycle,
    async (pluginId) => (await pluginRegistry.getById(pluginId))?.packagePath ?? null,
  );
  // Auto-install the bundled kubernetes sandbox-provider plugin so the
  // "kubernetes" sandbox provider is registered for agent runs. The plugin is
  // excluded from the pnpm workspace and built standalone into the image (see
  // Dockerfile), then installed here from its local path. This runs BEFORE
  // loadAll() so loadAll() can activate it in the same startup pass.
  //
  // SAFETY: this is fail-safe. Any failure is caught, logged, and swallowed so
  // the server finishes booting in a degraded state instead of crash-looping.
  const ensureBundledKubernetesPlugin = async (): Promise<void> => {
    const KUBERNETES_PLUGIN_KEY = "paperclip.kubernetes-sandbox-provider";
    const pluginPath =
      process.env["PAPERCLIP_KUBERNETES_PLUGIN_PATH"] ??
      "/app/packages/plugins/sandbox-providers/kubernetes";
    try {
      const existing = await pluginRegistry.getByKey(KUBERNETES_PLUGIN_KEY);
      if (existing) {
        logger.info(
          { pluginKey: KUBERNETES_PLUGIN_KEY, status: existing.status },
          "kubernetes sandbox plugin already installed; skipping auto-install",
        );
        return;
      }
      if (!fs.existsSync(path.join(pluginPath, "dist", "manifest.js"))) {
        logger.info(
          { pluginPath },
          "kubernetes sandbox plugin bundle not present; skipping auto-install",
        );
        return;
      }
      logger.info({ pluginPath }, "auto-installing bundled kubernetes sandbox plugin");
      const discovered = await loader.installPlugin({ localPath: pluginPath });
      if (!discovered.manifest) {
        logger.error("kubernetes sandbox plugin installed but manifest is missing");
        return;
      }
      const installed = await pluginRegistry.getByKey(discovered.manifest.id);
      if (installed) {
        await lifecycle.load(installed.id);
        logger.info(
          { pluginId: installed.id, pluginKey: installed.pluginKey },
          "kubernetes sandbox plugin auto-installed and loaded",
        );
      } else {
        logger.error("kubernetes sandbox plugin installed but not found in registry");
      }
    } catch (err) {
      logger.error(
        { err },
        "Failed to auto-install the kubernetes sandbox plugin; continuing boot (degraded: kubernetes provider unavailable)",
      );
    }
  };

  // loader.loadAll() activates every status='ready' plugin, which calls
  // workerManager.startWorker() on each. On the API tier the workerManager
  // is the stub from services/plugin-worker-manager-stub.ts; every call
  // throws ApiTierPluginWorkerError, plugin-loader catches it and writes
  // status='error' to the DB. That strands every ready plugin on every
  // api-tier pod boot; the worker tier subsequently loads zero plugins
  // because they're all errored. Mirrors the bundled-plugin-install skip
  // in server/src/index.ts so plugin lifecycle only runs on the tier that
  // can host workers.
  let stopPluginEventOutbox: (() => void) | null = null;
  if (appConfig.paperclipNodeRole === "api") {
    logger.info(
      { role: appConfig.paperclipNodeRole },
      "skipping plugin loadAll on startup (API tier — workers tier owns plugin lifecycle)",
    );
  } else {
    void ensureBundledKubernetesPlugin()
      .then(() => loader.loadAll())
      .then((result) => {
        if (result) {
          for (const loaded of result.results) {
            if (devWatcher && loaded.success && loaded.plugin.packagePath) {
              devWatcher.watch(loaded.plugin.id, loaded.plugin.packagePath);
            }
          }
          // Start the outbox poller only after plugins have subscribed, so an
          // early event isn't marked processed with no handler to receive it.
          stopPluginEventOutbox = startPluginEventOutbox(db, eventBus);
        }
      })
      .catch((err) => {
        logger.error({ err }, "Failed to load ready plugins on startup");
      });
  }
  let appServicesShutdown = false;
  const shutdownAppServices = () => {
    if (appServicesShutdown) return;
    appServicesShutdown = true;
    stopPluginEventOutbox?.();
    disableFeedbackExportFlushes();
    devWatcher?.close();
    viteHtmlRenderer?.dispose();
    hostServiceCleanup?.disposeAll();
    hostServiceCleanup?.teardown();
  };
  app.locals.paperclipShutdown = shutdownAppServices;

  process.once("exit", shutdownAppServices);
  process.once("beforeExit", () => {
    void flushPluginLogBuffer();
  });

  return app;
}
