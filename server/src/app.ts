import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler, logger } from "./middleware/index.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { createCorsPolicyMiddleware } from "./middleware/cors-policy.js";
import { buildRateLimitConfigFromEnv, createRateLimitMiddleware, resolveClientIp } from "./middleware/rate-limit.js";
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
import { heartbeatService, logActivity, initNotifications } from "./services/index.js";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";

type UiMode = "none" | "static" | "vite-dev";
const LOGIN_AUTOSTART_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_AUTOSTART_CACHE_MAX = 5000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export async function createApp(
  db: Db,
  opts: {
    uiMode: UiMode;
    storageService: StorageService;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    allowedHostnames: string[];
    bindHost: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const app = express();
  const rateLimitConfig = buildRateLimitConfigFromEnv();
  const authRateLimiter = createRateLimitMiddleware({
    name: "auth",
    windowMs: rateLimitConfig.authWindowMs,
    max: rateLimitConfig.authMax,
    key: (req) => `ip:${resolveClientIp(req)}`,
  });
  const passwordResetRateLimiter = createRateLimitMiddleware({
    name: "auth_password_reset",
    windowMs: rateLimitConfig.resetWindowMs,
    max: rateLimitConfig.resetMax,
    key: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      return email.length > 0 ? `email:${email}` : `ip:${resolveClientIp(req)}`;
    },
    skip: (req) => !req.path.toLowerCase().includes("reset"),
  });
  const heartbeat = heartbeatService(db as any);
  initNotifications(db as any);
  const loginAutostartSeen = new Map<string, number>();

  function shouldRunLoginAutostart(key: string) {
    const now = Date.now();
    for (const [entryKey, ts] of loginAutostartSeen.entries()) {
      if (now - ts > LOGIN_AUTOSTART_CACHE_TTL_MS) loginAutostartSeen.delete(entryKey);
    }
    if (loginAutostartSeen.has(key)) return false;
    if (loginAutostartSeen.size >= LOGIN_AUTOSTART_CACHE_MAX) {
      const oldest = [...loginAutostartSeen.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];
      if (oldest) loginAutostartSeen.delete(oldest);
    }
    loginAutostartSeen.set(key, now);
    return true;
  }

  function withLoginHeartbeatEnabled(raw: unknown) {
    const runtime = asRecord(raw) ?? {};
    const heartbeatConfig = asRecord(runtime.heartbeat) ?? {};
    const nextHeartbeat = {
      ...heartbeatConfig,
      enabled: true,
      wakeOnDemand: true,
      wakeOnAssignment: true,
      wakeOnAutomation: true,
      wakeOnOnDemand: true,
    };
    const next = { ...runtime, heartbeat: nextHeartbeat };
    return {
      next,
      changed: JSON.stringify(runtime) !== JSON.stringify(next),
    };
  }

  async function runSessionLoginAutostart(input: {
    userId: string;
    companyId: string;
    sessionId: string;
  }) {
    const companyAgents = await db
      .select({
        id: agents.id,
        status: agents.status,
        runtimeConfig: agents.runtimeConfig,
      })
      .from(agents)
      .where(eq(agents.companyId, input.companyId));

    const updatedAgentIds: string[] = [];
    const invokableAgentIds = new Set<string>();

    for (const row of companyAgents) {
      if (row.status === "terminated" || row.status === "pending_approval") continue;
      invokableAgentIds.add(row.id);

      const { next, changed } = withLoginHeartbeatEnabled(row.runtimeConfig);
      if (!changed) continue;

      await db
        .update(agents)
        .set({
          runtimeConfig: next,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, row.id));
      updatedAgentIds.push(row.id);
    }

    const openAssignments = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          isNull(issues.hiddenAt),
          inArray(issues.status, ["todo", "in_progress", "blocked"]),
        ),
      );

    const wakeupAgentIds = [...new Set(
      openAssignments
        .map((row) => row.assigneeAgentId)
        .filter((id): id is string => typeof id === "string" && id.length > 0 && invokableAgentIds.has(id)),
    )];

    const queuedWakeups: string[] = [];
    for (const agentId of wakeupAgentIds) {
      try {
        const run = await heartbeat.wakeup(agentId, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "user_login_auto_start",
          requestedByActorType: "user",
          requestedByActorId: input.userId,
          contextSnapshot: {
            wakeReason: "user_login_auto_start",
            loginSessionId: input.sessionId,
          },
        });
        if (run) queuedWakeups.push(agentId);
      } catch (err) {
        logger.warn(
          { err, companyId: input.companyId, agentId, userId: input.userId },
          "session login autostart wakeup failed",
        );
      }
    }

    if (updatedAgentIds.length > 0 || queuedWakeups.length > 0) {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "user",
        actorId: input.userId,
        agentId: null,
        runId: null,
        action: "company.session_login_autostart",
        entityType: "company",
        entityId: input.companyId,
        details: {
          sessionId: input.sessionId,
          updatedAgentIds,
          wakeupAgentIds: queuedWakeups,
        },
      });
    }
  }

  app.use(
    createCorsPolicyMiddleware({
      deploymentMode: opts.deploymentMode,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    }),
  );
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
  if (rateLimitConfig.enabled) {
    app.use("/api/auth", authRateLimiter, passwordResetRateLimiter);
  }
  app.get("/api/auth/get-session", (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const sessionId = req.actor.sessionId ?? `paperclip:${req.actor.source}:${req.actor.userId}`;
    res.json({
      session: {
        id: sessionId,
        userId: req.actor.userId,
      },
      user: {
        id: req.actor.userId,
        email: null,
        name: req.actor.source === "local_implicit" ? "Local Board" : null,
      },
    });

    // Autostart is intentionally scoped to "single-company users" so board users
    // with access to multiple companies are not surprised by broad wakeups.
    if (req.actor.source !== "session" || !req.actor.sessionId) return;
    const companyIds = req.actor.companyIds ?? [];
    if (companyIds.length !== 1) return;

    const companyId = companyIds[0];
    const cacheKey = `${req.actor.sessionId}:${companyId}`;
    if (!shouldRunLoginAutostart(cacheKey)) return;

    void runSessionLoginAutostart({
      userId: req.actor.userId,
      companyId,
      sessionId: req.actor.sessionId,
    }).catch((err) => {
      logger.error(
        { err, userId: req.actor.userId, companyId },
        "session login autostart failed",
      );
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
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    }),
  );
  app.use("/api", api);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (opts.uiMode === "static") {
    // Try published location first (server/ui-dist/), then monorepo dev location (../../ui/dist)
    const candidates = [
      path.resolve(__dirname, "../ui-dist"),
      path.resolve(__dirname, "../../ui/dist"),
    ];
    const uiDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
    if (uiDist) {
      app.use(express.static(uiDist));
      app.get(/.*/, (_req, res) => {
        res.sendFile(path.join(uiDist, "index.html"));
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

  return app;
}
