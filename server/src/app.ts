import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createGzip, createDeflate } from "node:zlib";
import { pipeline } from "node:stream";
import type { Db } from "@ironworksai/db";
import type { DeploymentExposure, DeploymentMode } from "@ironworksai/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { cacheControl, etag } from "./middleware/cache.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { enforceProjectLimit, enforceStorageLimit, enforcePlaybookRunLimit } from "./middleware/tier-limits.js";
import { healthRoutes } from "./routes/health.js";
import { companyRoutes } from "./routes/companies.js";
import { companySkillRoutes } from "./routes/company-skills.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { routineRoutes } from "./routes/routines.js";
import { executionWorkspaceRoutes } from "./routes/execution-workspaces.js";
import { goalRoutes } from "./routes/goals.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import { llmRoutes } from "./routes/llms.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { libraryRoutes } from "./routes/library.js";
import { playbookRoutes } from "./routes/playbooks.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { setupRoutes } from "./routes/setup.js";
import { hiringRoutes } from "./routes/hiring.js";
import { agentMemoryRoutes } from "./routes/agent-memory.js";
import { announcementRoutes } from "./routes/announcements.js";
import { roleTemplateRoutes } from "./routes/role-templates.js";
import { teamTemplateRoutes } from "./routes/team-templates.js";
import { aiGenerateRoutes } from "./routes/ai-generate.js";
import { privacyRoutes, startRetentionScheduler } from "./routes/privacy.js";
import { supportPublicRoutes } from "./routes/support.js";
import { goalStatsRoutes } from "./routes/goal-stats.js";
import { aiGoalBreakdownRoutes } from "./routes/ai-goal-breakdown.js";
import { messagingRoutes, emailWebhookRoutes } from "./routes/messaging.js";
import { slimRoutes } from "./routes/slim.js";
import { adminRoutes } from "./routes/admin.js";
// Plugin system disabled — not needed for V1 productization
// import { pluginRoutes } from "./routes/plugins.js";
// import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { applyUiBranding } from "./ui-branding.js";
import { logger } from "./middleware/logger.js";
// Plugin system disabled
// import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader } from "./services/plugin-loader.js";
// import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
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
import { createHostClientHandlers } from "@ironworksai/plugin-sdk";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";

type UiMode = "none" | "static" | "vite-dev";

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

  // ── Global Rate Limiting (SEC-ADV-013) ──
  // Simple in-memory sliding window rate limiter. No external dependency.
  const rateBuckets = new Map<string, { count: number; resetAt: number }>();
  const RATE_LIMIT = 200; // requests per window
  const RATE_WINDOW_MS = 60_000; // 1 minute
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api") || req.method === "OPTIONS") return next();
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
      rateBuckets.set(ip, bucket);
    }
    bucket.count++;
    if (bucket.count > RATE_LIMIT) {
      res.status(429).json({ error: "Too many requests. Try again later." });
      return;
    }
    // Prune stale buckets every ~1000 requests
    if (bucket.count === 1 && rateBuckets.size > 1000) {
      for (const [k, v] of rateBuckets) { if (now > v.resetAt) rateBuckets.delete(k); }
    }
    next();
  });

  // ── Security Headers (no external dependency) ──
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (opts.uiMode !== "vite-dev") {
      res.setHeader("Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com; frame-src 'none'; object-src 'none'; base-uri 'self'");
    }
    next();
  });

  // ── HTTP Compression ──
  // Use Node.js built-in zlib for gzip/deflate compression on API responses.
  app.use((req, res, next) => {
    const acceptEncoding = req.headers["accept-encoding"] ?? "";
    // Skip compression for Server-Sent Events and tiny responses
    const origEnd = res.end.bind(res);
    const origWrite = res.write.bind(res);
    // Only compress JSON API responses (not static files — express.static handles those)
    if (req.path.startsWith("/api") && typeof acceptEncoding === "string") {
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        const json = JSON.stringify(body);
        // Only compress if payload is reasonably large (> 1KB)
        if (json.length > 1024) {
          const encoding = acceptEncoding.includes("gzip")
            ? "gzip"
            : acceptEncoding.includes("deflate")
              ? "deflate"
              : null;
          if (encoding) {
            const compressor =
              encoding === "gzip" ? createGzip() : createDeflate();
            res.setHeader("Content-Encoding", encoding);
            res.removeHeader("Content-Length");
            if (!res.headersSent) {
              res.setHeader("Content-Type", "application/json");
            }
            const chunks: Buffer[] = [];
            compressor.on("data", (chunk: Buffer) => chunks.push(chunk));
            compressor.on("end", () => {
              const compressed = Buffer.concat(chunks);
              origEnd(compressed);
            });
            compressor.end(json);
            return res;
          }
        }
        return originalJson(body);
      };
    }
    next();
  });

  // ── ETag support for conditional GET requests ──
  app.use(etag());

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
        id: `ironworks:${req.actor.source}:${req.actor.userId}`,
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

  // ── Cache-Control headers per route pattern ──
  api.get("/health", cacheControl(30, "public"));
  api.get("/companies/:id/dashboard", cacheControl(30));
  api.get("/companies/:id/agents", cacheControl(60));
  api.get("/companies/:id/agents/slim", cacheControl(60));
  api.get("/companies/:id/projects", cacheControl(60));
  api.get("/companies/:id/goals", cacheControl(60));
  api.get("/companies/:id/issues", cacheControl(15));
  api.get("/companies/:id/activity", cacheControl(10));
  api.get("/companies/:id/costs/*path", cacheControl(60));
  api.get("/companies/:id/knowledge/*path", cacheControl(120));

  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
    }),
  );
  // ── Tier enforcement middleware ──
  // SEC-ADV-001: Wire billing tier limits to mutation endpoints
  api.post("/companies/:companyId/projects", enforceProjectLimit(db));
  api.post("/companies/:companyId/playbooks/:playbookId/run", enforcePlaybookRunLimit(db));
  api.post("/companies/:companyId/assets", enforceStorageLimit(db));
  api.post("/companies/:companyId/assets/*path", enforceStorageLimit(db));

  api.use("/admin", adminRoutes(db));
  api.use("/companies", companyRoutes(db, opts.storageService));
  api.use(companySkillRoutes(db));
  api.use(agentRoutes(db));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService));
  api.use(routineRoutes(db));
  api.use(executionWorkspaceRoutes(db));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db));
  api.use(secretRoutes(db));
  api.use(costRoutes(db));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(instanceSettingsRoutes(db));
  api.use(libraryRoutes(db));
  api.use(playbookRoutes(db));
  api.use(knowledgeRoutes(db));
  api.use(hiringRoutes(db));
  api.use(agentMemoryRoutes(db));
  api.use(announcementRoutes(db));
  api.use(roleTemplateRoutes(db));
  api.use(teamTemplateRoutes(db));
  api.use(aiGenerateRoutes(db));
  api.use(privacyRoutes(db));
  api.use(goalStatsRoutes(db));
  api.use(aiGoalBreakdownRoutes(db));
  api.use(messagingRoutes(db));
  api.use(slimRoutes(db));

  // Start daily data retention cleanup
  startRetentionScheduler(db);

  // ── Plugin system disabled for V1 productization ──
  // The plugin system adds complexity without customer value at this stage.
  // Re-enable when extension marketplace is needed (100+ clients).
  // Original code preserved in git history.
  const pluginRegistry = pluginRegistryService(db);
  const eventBus = createPluginEventBus();
  setPluginEventBus(eventBus);
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    }),
  );
  // Setup routes are public (no auth required — user isn't logged in yet)
  app.use("/api", setupRoutes(db));
  // Email webhook is public (called by Mailgun/SendGrid — no auth)
  app.use("/api", emailWebhookRoutes(db));
  // Support ticket submission is public (landing site contact form)
  app.use("/api", supportPublicRoutes(db));
  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  // Plugin UI static routes disabled
  // app.use(pluginUiStaticRoutes(db, {
  //   localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
  // }));

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
      // Static assets — Vite hashes filenames so hashed files are immutable
      app.use(express.static(uiDist, {
        maxAge: "1y",
        immutable: true,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith("index.html") || filePath.endsWith(".html")) {
            res.setHeader("Cache-Control", "no-cache");
          } else {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      }));
      app.get(/.*/, (_req, res) => {
        res.status(200).set({ "Content-Type": "text/html", "Cache-Control": "no-cache" }).end(indexHtml);
      });
    } else {
      console.warn("[ironworks] UI dist not found; running in API-only mode");
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

  // Plugin startup disabled
  // jobCoordinator.start();
  // scheduler.start();

  return app;
}
