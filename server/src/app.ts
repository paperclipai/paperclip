import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { companies as companiesTable, agents as agentsTable, companyMemberships, principalPermissionGrants } from "@paperclipai/db";
import { eq } from "drizzle-orm";
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
import { pluginRoutes } from "./routes/plugins.js";
import { adapterRoutes } from "./routes/adapters.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
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

  // CORS — permite el Studio frontend (localhost en dev, Railway en prod)
  app.use((req, res, next) => {
    const origin = req.headers.origin || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
  });

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

  // ── Debug: read comments from a specific issue ───────────────────────────────
  app.get("/api/internal/read-issue-comments", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" }); return;
    }
    const issueId = (req.query.issueId as string) ?? "";
    if (!issueId) { res.status(400).json({ error: "issueId required" }); return; }
    try {
      const { issues: issuesTable, issueComments } = await import("@paperclipai/db");
      const issue = await (db as any)
        .select({ id: issuesTable.id, status: issuesTable.status, title: issuesTable.title })
        .from(issuesTable)
        .where(eq(issuesTable.id, issueId))
        .limit(1)
        .then((r: any[]) => r[0] ?? null);

      const comments = await (db as any)
        .select()
        .from(issueComments)
        .where(eq((issueComments as any).issueId, issueId))
        .orderBy((issueComments as any).createdAt)
        .limit(10);

      res.json({
        issue,
        commentCount: comments.length,
        comments: comments.map((c: any) => ({
          id: c.id,
          bodyLength: (c.body || "").length,
          bodyPreview: (c.body || "").slice(0, 200),
          createdAt: c.createdAt,
        })),
        rawFirstComment: comments[0] ? Object.keys(comments[0]) : [],
      });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Debug: list recent issues in a company ────────────────────────────────────
  app.get("/api/internal/list-recent-issues", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" }); return;
    }
    const companyId = (req.query.companyId as string) ?? "";
    if (!companyId) { res.status(400).json({ error: "companyId required" }); return; }
    try {
      const { issues: issuesTable } = await import("@paperclipai/db");
      const issues = await (db as any)
        .select({
          id: issuesTable.id,
          title: issuesTable.title,
          status: issuesTable.status,
          identifier: (issuesTable as any).identifier,
          createdAt: issuesTable.createdAt,
        })
        .from(issuesTable)
        .where(eq(issuesTable.companyId, companyId))
        .orderBy((issuesTable as any).createdAt)
        .limit(20);
      res.json({ issues: issues.reverse() });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Debug: test issue counter + insert transaction ───────────────────────────
  app.get("/api/internal/test-issue-tx", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" }); return;
    }
    const companyId = (req.query.companyId as string) ?? "";
    if (!companyId) { res.status(400).json({ error: "companyId required" }); return; }
    try {
      const { issues: issuesTable, companies: companiesTable } = await import("@paperclipai/db");
      const { sql: sqlFn } = await import("drizzle-orm");
      const result = await (db as any).transaction(async (tx: any) => {
        // Step 1: increment counter
        const [company] = await tx
          .update(companiesTable)
          .set({ issueCounter: sqlFn`${companiesTable.issueCounter} + 1` })
          .where(eq(companiesTable.id, companyId))
          .returning({ issueCounter: companiesTable.issueCounter, issuePrefix: companiesTable.issuePrefix });
        if (!company) throw new Error("Company not found or update returned no rows");
        const identifier = `${company.issuePrefix}-${company.issueCounter}`;
        // Step 2: insert issue
        const [issue] = await tx.insert(issuesTable).values({
          companyId,
          title:       "Debug TX test",
          status:      "backlog",
          issueNumber: company.issueCounter,
          identifier,
          originKind:  "manual",
        }).returning({ id: issuesTable.id, identifier: (issuesTable as any).identifier });
        return { company, identifier, issueId: issue.id };
      });
      res.json({ ok: true, result });
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.slice(0, 800) : undefined,
      });
    }
  });

  // ── Diagnostic: list projects for a company ──────────────────────────────────
  app.get("/api/internal/list-projects", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" }); return;
    }
    const companyId = (req.query.companyId as string) ?? "";
    if (!companyId) { res.status(400).json({ error: "companyId required" }); return; }
    try {
      const { projects: projectsTable } = await import("@paperclipai/db");
      const projects = await (db as any)
        .select({ id: projectsTable.id, name: projectsTable.name })
        .from(projectsTable)
        .where(eq((projectsTable as any).companyId, companyId))
        .limit(10);
      res.json({ projects });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Debug: test issue creation in a company ──────────────────────────────────
  app.get("/api/internal/test-issue-create", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" }); return;
    }
    const companyId  = (req.query.companyId as string) ?? "";
    const projectId  = (req.query.projectId as string) ?? "";
    if (!companyId) { res.status(400).json({ error: "companyId required" }); return; }
    try {
      const { issues: issuesTable } = await import("@paperclipai/db");
      const [issue] = await (db as any)
        .insert(issuesTable)
        .values({
          companyId,
          projectId:   projectId || null,
          title:       "Test issue from debug endpoint",
          status:      "backlog",
          description: "Test",
        })
        .returning({ id: issuesTable.id, identifier: (issuesTable as any).identifier });
      res.json({ ok: true, issue });
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
      });
    }
  });

  // ── Diagnostic: list all companies with IDs and issuePrefixes ───────────────
  app.get("/api/internal/list-companies", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      const companies = await (db as any)
        .select({ id: companiesTable.id, name: companiesTable.name, issuePrefix: companiesTable.issuePrefix })
        .from(companiesTable)
        .orderBy(companiesTable.createdAt);
      res.json({ companies });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Helper: grant tasks:assign to an agent ───────────────────────────────────
  async function grantTasksAssign(companyId: string, agentId: string) {
    // 1. Ensure membership
    await (db as any).insert(companyMemberships).values({
      companyId, principalType: "agent", principalId: agentId,
      status: "active", membershipRole: "member",
    }).onConflictDoNothing();
    // 2. Grant tasks:assign permission
    await (db as any).insert(principalPermissionGrants).values({
      companyId, principalType: "agent", principalId: agentId,
      permissionKey: "tasks:assign", scope: null, grantedByUserId: null,
    }).onConflictDoNothing();
  }

  // ── Landing page previews ────────────────────────────────────────────────────
  // POST /preview  → saves HTML, returns {id, url}
  // GET  /preview/:id → serves the HTML
  const previewStore = new Map<string, string>();

  app.post("/preview", (req, res) => {
    let html = "";
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      html = Buffer.concat(chunks).toString("utf-8");
      if (!html) { res.status(400).json({ error: "empty body" }); return; }
      const id = Math.random().toString(36).slice(2, 10);
      previewStore.set(id, html);
      setTimeout(() => previewStore.delete(id), 24 * 60 * 60 * 1000);
      // Siempre usar la URL pública de Railway, no PAPERCLIP_API_URL (que puede ser localhost)
      const baseUrl = "https://spirited-charm-production.up.railway.app";
      res.json({ id, url: `${baseUrl}/preview/${id}` });
    });
    req.on("error", (err) => res.status(500).json({ error: String(err) }));
  });

  app.get("/preview/:id", (req, res) => {
    const html = previewStore.get(req.params.id);
    if (!html) { res.status(404).send("<h1>Preview not found or expired</h1>"); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  // ── Supabase proxy — expone datos de vídeos sin revelar la clave secreta ──────
  // SUPABASE_URL puede venir como "https://xxx.supabase.co/rest/v1" (con path) o
  // como "https://xxx.supabase.co" (sin path). Normalizamos al base URL.
  function supabaseBase(): string {
    const raw = process.env.SUPABASE_URL || "https://nuaajypknpjbsyhssclm.supabase.co";
    // Quitar /rest/v1 si ya viene incluido en la variable de entorno
    return raw.replace(/\/rest\/v1\/?$/, "");
  }
  function supabaseKey(): string {
    return process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
  }
  function sbFetch(path: string, extra?: HeadersInit) {
    const base = supabaseBase();
    const key  = supabaseKey();
    return fetch(`${base}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, ...extra }
    });
  }

  // GET /api/content/videos?limit=30&offset=0
  app.get("/api/content/videos", async (req, res) => {
    const limit  = Math.min(Number(req.query.limit)  || 30, 100);
    const offset = Number(req.query.offset) || 0;
    try {
      const r = await sbFetch(
        `videos?select=id,created_at,tema,video_url,audio_url,image_urls,status&order=created_at.desc&limit=${limit}&offset=${offset}`
      );
      if (!r.ok) {
        const errBody = await r.text().catch(() => "");
        res.status(r.status).json({ error: "Supabase error", status: r.status, detail: errBody.slice(0,200) });
        return;
      }
      const rows = await r.json();
      res.setHeader("Cache-Control", "no-store");
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // GET /api/creator/config — exposes public Supabase config for the landing page auth
  app.get("/api/creator/config", (_req, res) => {
    const supabaseUrl     = supabaseBase();
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
    res.json({ supabaseUrl, supabaseAnonKey: supabaseAnonKey || null });
  });

  // GET /api/admin/users?secret=X — list all Supabase Auth users
  app.get("/api/admin/users", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    if (!secret || secret !== (process.env.ADMIN_SECRET ?? "")) {
      res.status(403).json({ error: "forbidden" }); return;
    }
    try {
      const base = supabaseBase();
      const key  = supabaseKey();
      const r = await fetch(`${base}/auth/v1/admin/users?per_page=1000`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!r.ok) { res.status(r.status).json({ error: "Supabase error" }); return; }
      const data = await r.json();
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // PATCH /api/admin/users/:id?secret=X — update user plan in metadata
  app.patch("/api/admin/users/:id", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    if (!secret || secret !== (process.env.ADMIN_SECRET ?? "")) {
      res.status(403).json({ error: "forbidden" }); return;
    }
    const { plan } = req.body as { plan?: string };
    if (!plan) { res.status(400).json({ error: "plan required" }); return; }
    try {
      const base = supabaseBase();
      const key  = supabaseKey();
      const r = await fetch(`${base}/auth/v1/admin/users/${req.params.id}`, {
        method:  "PUT",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ user_metadata: { plan } }),
      });
      if (!r.ok) { res.status(r.status).json({ error: "Supabase error" }); return; }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // GET /api/content/stats
  app.get("/api/content/stats", async (req, res) => {
    try {
      const [totalR, videosR] = await Promise.all([
        sbFetch("videos?select=id&limit=1", { Prefer: "count=exact" }),
        sbFetch("videos?select=id,created_at,tema,video_url,image_urls&order=created_at.desc&limit=100"),
      ]);
      const total     = parseInt(totalR.headers.get("content-range")?.split("/")[1] || "0", 10);
      const videos    = videosR.ok ? await videosR.json() : [];
      const withVideo = Array.isArray(videos) ? videos.filter((v: any) => v.video_url).length : 0;
      const withImages= Array.isArray(videos) ? videos.filter((v: any) => v.image_urls?.length).length : 0;
      res.setHeader("Cache-Control", "no-store");
      res.json({ total, withVideo, withImages, costPerVideo: 2.30 });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Studio sound effects ─────────────────────────────────────────────────────
  app.get("/sounds/:file", (req, res) => {
    const allowed = ["success.m4a", "error.m4a"];
    const file    = req.params.file;
    if (!allowed.includes(file)) { res.status(404).end(); return; }
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../frontend/sounds", file);
    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader("Cache-Control", "public, max-age=31536000");
    res.sendFile(p, (err) => { if (err) res.status(404).end(); });
  });

  // ── TikTok URL verification file ────────────────────────────────────────────
  app.get("/tiktokLEfIkRPAJgbq8y0D9WQQDhDqo2ZVtqxa.txt", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.send("tiktok-developers-site-verification=LEfIkRPAJgbq8y0D9WQQDhDqo2ZVtqxa");
  });

  // ── Legal pages (required for TikTok app review) ────────────────────────────
  app.get("/terms", (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Terms of Service — AI Content Agents</title>
    <style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.7;color:#222}h1{font-size:24px}h2{font-size:18px;margin-top:32px}</style></head><body>
    <h1>Terms of Service — AI Content Agents</h1>
    <p><em>Last updated: April 2026</em></p>
    <h2>1. Acceptance of Terms</h2>
    <p>By using AI Content Agents ("the Service"), you agree to these Terms of Service. If you do not agree, do not use the Service.</p>
    <h2>2. Description of Service</h2>
    <p>AI Content Agents is an AI-powered content creation tool that analyzes public social media trends to help creators generate video scripts, content strategies, and marketing materials.</p>
    <h2>3. Use of TikTok Data</h2>
    <p>The Service accesses TikTok public content data through TikTok's official APIs solely to analyze trends and inform content creation strategies. We do not store personal user data beyond what is necessary to provide the service.</p>
    <h2>4. User Responsibilities</h2>
    <p>Users are responsible for complying with TikTok's Terms of Service and applicable laws when using content generated by this Service.</p>
    <h2>5. Limitation of Liability</h2>
    <p>The Service is provided "as is" without warranties. We are not liable for any damages arising from use of the Service.</p>
    <h2>6. Changes to Terms</h2>
    <p>We may update these terms at any time. Continued use of the Service constitutes acceptance of updated terms.</p>
    <h2>7. Contact</h2>
    <p>For questions about these terms, contact: alejandrojesusperezblanco4@gmail.com</p>
    </body></html>`);
  });

  app.get("/privacy", (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Privacy Policy — AI Content Agents</title>
    <style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.7;color:#222}h1{font-size:24px}h2{font-size:18px;margin-top:32px}</style></head><body>
    <h1>Privacy Policy — AI Content Agents</h1>
    <p><em>Last updated: April 2026</em></p>
    <h2>1. Information We Collect</h2>
    <p>We access public TikTok profile data (display name, follower count, video count, public videos) through TikTok's official API when users explicitly request analysis of a TikTok account.</p>
    <h2>2. How We Use Information</h2>
    <p>Collected data is used solely to generate content strategy insights and is not sold, shared, or used for advertising purposes.</p>
    <h2>3. Data Retention</h2>
    <p>Analyzed data is retained only for the duration of the active session and is not permanently stored in identifiable form.</p>
    <h2>4. TikTok API Compliance</h2>
    <p>We comply with TikTok's API Terms of Service. We only access data that is publicly available and only request permissions necessary for the Service's functionality.</p>
    <h2>5. Third-Party Services</h2>
    <p>We use TikTok API, YouTube Data API, and OpenRouter AI services. Each service has its own privacy policy.</p>
    <h2>6. Your Rights</h2>
    <p>You may request deletion of any data associated with your use of the Service by contacting us.</p>
    <h2>7. Contact</h2>
    <p>Privacy questions: alejandrojesusperezblanco4@gmail.com</p>
    </body></html>`);
  });

  // ── Internal one-time seed endpoint ─────────────────────────────────────────
  // Creates process agents that can't be created via the UI.
  // Protected by the first 16 chars of BETTER_AUTH_SECRET.
  // Usage: GET /api/internal/seed-agents?secret=<first-16-chars>
  app.get("/api/internal/seed-agents", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      // Buscar la compañía correcta: la que tiene el Director, no necesariamente la primera.
      const allAgentsGlobal: { id: string; name: string; companyId: string }[] = await (db as any)
        .select({ id: agentsTable.id, name: agentsTable.name, companyId: agentsTable.companyId })
        .from(agentsTable)
        .limit(300);

      const director = allAgentsGlobal.find((a) => a.name.toLowerCase() === "director");
      const targetCompanyId = director?.companyId;

      // Fallback: primera compañía en la tabla
      const [firstCompany] = await (db as any)
        .select({ id: companiesTable.id, name: companiesTable.name })
        .from(companiesTable)
        .limit(1);

      const [company] = targetCompanyId
        ? await (db as any)
            .select({ id: companiesTable.id, name: companiesTable.name })
            .from(companiesTable)
            .where(eq(companiesTable.id, targetCompanyId))
        : [firstCompany];

      if (!company) {
        res.status(500).json({ error: "No company found in DB" });
        return;
      }

      const allAgents = allAgentsGlobal.filter((a) => a.companyId === company.id);

      const AGENTS_TO_CREATE = [
        {
          name: "Popcorn Auto",
          envVar: "POPCORN_AGENT_ID",
          title: "Higgsfield Coherent Image Generator",
          adapterConfig: { command: "python3", args: ["agents/popcorn.py"], cwd: "/app" },
          budgetMonthlyCents: 6000,
        },
      ];

      const results: Record<string, { id: string; created: boolean }> = {};

      // Actualizar agentes existentes por ID conocido (timeout extendido, etc.)
      const AGENTS_TO_PATCH_BY_ID: Array<{ id: string; label: string; adapterConfig: Record<string, unknown> }> = [
        {
          id: "62e14c73-905b-45ce-b4d9-4cd532ec3dca", // Imagen Video
          label: "Imagen Video",
          adapterConfig: { command: "python3", args: ["agents/imagen_video.py"], cwd: "/app", timeoutSec: 1800 },
        },
      ];
      for (const patch of AGENTS_TO_PATCH_BY_ID) {
        const target = allAgentsGlobal.find((a) => a.id === patch.id);
        if (target) {
          await (db as any).update(agentsTable).set({ adapterConfig: patch.adapterConfig }).where(eq(agentsTable.id, patch.id));
          results[`patch_${patch.label}`] = { id: patch.id, created: false };
          console.log(`  ✅ Patched ${patch.label} (${patch.id}) → timeoutSec=${patch.adapterConfig.timeoutSec}`);
        } else {
          console.log(`  ⚠️  Agent ${patch.label} (${patch.id}) not found in DB — skip patch`);
        }
      }

      for (const spec of AGENTS_TO_CREATE) {
        const existing = allAgents.find(
          (a) => a.name.toLowerCase() === spec.name.toLowerCase(),
        );
        if (existing) {
          // Actualizar adapterConfig para aplicar correcciones (ej. python → python3)
          await (db as any)
            .update(agentsTable)
            .set({ adapterConfig: spec.adapterConfig })
            .where(eq(agentsTable.id, existing.id));
          results[spec.envVar] = { id: existing.id, created: false };
          continue;
        }
        const [created] = await (db as any)
          .insert(agentsTable)
          .values({
            companyId: company.id,
            name: spec.name,
            role: "engineer",
            title: spec.title,
            status: "idle",
            adapterType: "process",
            adapterConfig: spec.adapterConfig,
            budgetMonthlyCents: spec.budgetMonthlyCents,
            reportsTo: director?.id ?? null,
          })
          .returning({ id: agentsTable.id });
        results[spec.envVar] = { id: created.id, created: true };
      }

      const envLines = Object.entries(results)
        .map(([k, v]) => `${k}=${v.id}`)
        .join("\n");

      res.json({
        ok: true,
        company: company.name,
        results,
        envVars: envLines,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── TikTok OAuth — one-time token setup ─────────────────────────────────────
  // Step 1: GET /auth/tiktok/start  → redirects to TikTok login
  // Step 2: TikTok redirects to GET /auth/tiktok/callback?code=...
  //         → exchanges code for tokens, shows them in browser
  // Copy TIKTOK_ACCESS_TOKEN + TIKTOK_REFRESH_TOKEN to Railway Variables.

  app.get("/auth/tiktok/start", (req, res) => {
    const clientKey   = process.env.TIKTOK_CLIENT_KEY ?? "";
    const baseUrl     = (process.env.PAPERCLIP_API_URL ?? "https://spirited-charm-production.up.railway.app").replace(/\/$/, "");
    const redirectUri = `${baseUrl}/auth/tiktok/callback`;
    const scope       = "user.info.basic,video.upload,video.publish,video.list";
    const state       = Math.random().toString(36).slice(2);

    const authUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${clientKey}&scope=${encodeURIComponent(scope)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    res.redirect(authUrl);
  });

  app.get("/auth/tiktok/callback", async (req, res) => {
    const code        = (req.query.code as string) ?? "";
    const clientKey   = process.env.TIKTOK_CLIENT_KEY ?? "";
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET ?? "";
    const baseUrl     = (process.env.PAPERCLIP_API_URL ?? "https://spirited-charm-production.up.railway.app").replace(/\/$/, "");
    const redirectUri = `${baseUrl}/auth/tiktok/callback`;

    if (!code) {
      res.status(400).send("No code received from TikTok");
      return;
    }

    try {
      const params = new URLSearchParams({
        client_key:    clientKey,
        client_secret: clientSecret,
        code,
        grant_type:    "authorization_code",
        redirect_uri:  redirectUri,
      });

      const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    params.toString(),
      });
      const tokenData = await tokenRes.json() as Record<string, unknown>;

      const accessToken  = tokenData.access_token  as string ?? "";
      const refreshToken = tokenData.refresh_token as string ?? "";
      const openId       = tokenData.open_id       as string ?? "";
      const expiresIn    = tokenData.expires_in    as number ?? 0;

      res.send(`
        <html><body style="font-family:monospace;padding:32px;background:#111;color:#eee">
        <h2>✅ TikTok Auth Success</h2>
        <p>Copia estos valores en <strong>Railway Variables</strong>:</p>
        <pre style="background:#222;padding:16px;border-radius:8px">
TIKTOK_ACCESS_TOKEN=${accessToken}
TIKTOK_REFRESH_TOKEN=${refreshToken}
TIKTOK_OPEN_ID=${openId}
        </pre>
        <p>El access token expira en ${Math.round(expiresIn / 3600)}h. El refresh token lo renueva automáticamente.</p>
        </body></html>
      `);
    } catch (err) {
      res.status(500).send(`Error exchanging code: ${err}`);
    }
  });

  // ── Seed growth agents in DiscontrolGrowth ──────────────────────────────────
  // Usage: GET /api/internal/seed-growth-agents?secret=<first-16-chars>
  app.get("/api/internal/seed-growth-agents", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      const [company] = await (db as any)
        .select({ id: companiesTable.id, name: companiesTable.name })
        .from(companiesTable)
        .where(eq(companiesTable.issuePrefix, "DISAA"))
        .limit(1);

      if (!company) {
        res.status(404).json({ error: "DiscontrolGrowth not found (issuePrefix DISAA)" });
        return;
      }

      const GROWTH_AGENTS = [
        {
          name: "CEO Growth",
          envVar: "GROWTH_CEO_AGENT_ID",
          title: "Sales & Growth Orchestrator — Diskontrol",
          role: "manager" as const,
          adapterConfig: { command: "python3", args: ["agents/growth/ceo.py"], cwd: "/app", timeoutSec: 1800 },
          budgetMonthlyCents: 10000,
        },
        {
          name: "Lead Scout",
          envVar: "GROWTH_LEAD_SCOUT_AGENT_ID",
          title: "Local Business Lead Finder",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/growth/lead_scout.py"], cwd: "/app", timeoutSec: 300 },
          budgetMonthlyCents: 5000,
        },
        {
          name: "Lead Qualifier",
          envVar: "GROWTH_LEAD_QUALIFIER_AGENT_ID",
          title: "Lead Scoring & Prioritization",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/growth/lead_qualifier.py"], cwd: "/app", timeoutSec: 120 },
          budgetMonthlyCents: 4000,
        },
        {
          name: "Outreach Writer",
          envVar: "GROWTH_OUTREACH_WRITER_AGENT_ID",
          title: "Personalized Outreach Message Generator",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/growth/outreach_writer.py"], cwd: "/app", timeoutSec: 120 },
          budgetMonthlyCents: 5000,
        },
        {
          name: "Sender",
          envVar: "GROWTH_SENDER_AGENT_ID",
          title: "Multi-channel Message Sender",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/growth/sender.py"], cwd: "/app", timeoutSec: 120 },
          budgetMonthlyCents: 3000,
        },
        {
          name: "Tracker",
          envVar: "GROWTH_TRACKER_AGENT_ID",
          title: "Lead Response Tracker & Follow-up",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/growth/tracker.py"], cwd: "/app", timeoutSec: 60 },
          budgetMonthlyCents: 2000,
        },
      ];

      const existingAgents: { id: string; name: string; status: string }[] = await (db as any)
        .select({ id: agentsTable.id, name: agentsTable.name, status: agentsTable.status })
        .from(agentsTable)
        .where(eq(agentsTable.companyId, company.id));

      const results: Record<string, { id: string; created: boolean }> = {};
      let ceoId: string | null = null;

      for (const spec of GROWTH_AGENTS) {
        const existing = existingAgents.find(a => a.name.toLowerCase() === spec.name.toLowerCase());

        if (existing) {
          if (existing.status === "terminated") {
            await (db as any).delete(agentsTable).where(eq(agentsTable.id, existing.id));
          } else {
            await (db as any).update(agentsTable).set({ adapterType: "process", adapterConfig: spec.adapterConfig, status: "idle" }).where(eq(agentsTable.id, existing.id));
            results[spec.envVar] = { id: existing.id, created: false };
            if (spec.name === "CEO Growth") ceoId = existing.id;
            continue;
          }
        }

        const insertValues: Record<string, unknown> = {
          companyId: company.id, name: spec.name, role: spec.role,
          title: spec.title, status: "idle", adapterType: "process",
          adapterConfig: spec.adapterConfig, budgetMonthlyCents: spec.budgetMonthlyCents,
        };
        if (spec.name !== "CEO Growth" && ceoId) insertValues.reportsTo = ceoId;

        const [created] = await (db as any).insert(agentsTable).values(insertValues).returning({ id: agentsTable.id });
        results[spec.envVar] = { id: created.id, created: true };
        if (spec.name === "CEO Growth") ceoId = created.id;
      }

      if (ceoId) await grantTasksAssign(company.id, ceoId);

      res.json({ ok: true, company: company.name, companyId: company.id, results,
        envVars: Object.entries(results).map(([k,v]) => `${k}=${v.id}`).join("\n") });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Seed dropshipping agents in DiscontrolDrops ─────────────────────────────
  // Finds company by issuePrefix and creates all dropshipping agents.
  // Usage: GET /api/internal/seed-drops-agents?secret=<first-16-chars>
  app.get("/api/internal/seed-drops-agents", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      // Buscar empresa por issuePrefix (el slug de la URL)
      const [company] = await (db as any)
        .select({ id: companiesTable.id, name: companiesTable.name })
        .from(companiesTable)
        .where(eq(companiesTable.issuePrefix, "DISA"))
        .limit(1);

      if (!company) {
        res.status(404).json({ error: "DiscontrolDrops company not found (issuePrefix DISA)" });
        return;
      }

      const DROPS_AGENTS = [
        {
          name: "CEO",
          envVar: "DROPS_CEO_AGENT_ID",
          title: "Dropshipping Orchestrator",
          role: "manager" as const,
          adapterConfig: { command: "python3", args: ["agents/drops/ceo.py"], cwd: "/app", timeoutSec: 1800 },
          budgetMonthlyCents: 10000,
        },
        {
          name: "Product Hunter",
          envVar: "DROPS_PRODUCT_HUNTER_AGENT_ID",
          title: "Winning Product Finder",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/drops/product_hunter.py"], cwd: "/app", timeoutSec: 180 },
          budgetMonthlyCents: 5000,
        },
        {
          name: "Ad Spy",
          envVar: "DROPS_AD_SPY_AGENT_ID",
          title: "Facebook & TikTok Ad Analyzer",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/drops/ad_spy.py"], cwd: "/app", timeoutSec: 180 },
          budgetMonthlyCents: 5000,
        },
        {
          name: "Lead Qualifier",
          envVar: "DROPS_LEAD_QUALIFIER_AGENT_ID",
          title: "Product & Niche Qualifier",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/drops/lead_qualifier.py"], cwd: "/app", timeoutSec: 120 },
          budgetMonthlyCents: 4000,
        },
        {
          name: "Web Designer",
          envVar: "DROPS_WEB_DESIGNER_AGENT_ID",
          title: "Shopify Landing Page Designer",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/drops/web_designer.py"], cwd: "/app", timeoutSec: 180 },
          budgetMonthlyCents: 5000,
        },
        {
          name: "Marketing Creator",
          envVar: "DROPS_MARKETING_CREATOR_AGENT_ID",
          title: "Ad Copy & Marketing Assets Creator",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/drops/marketing_creator.py"], cwd: "/app", timeoutSec: 180 },
          budgetMonthlyCents: 5000,
        },
      ];

      const existingAgents: { id: string; name: string }[] = await (db as any)
        .select({ id: agentsTable.id, name: agentsTable.name })
        .from(agentsTable)
        .where(eq(agentsTable.companyId, company.id));

      const results: Record<string, { id: string; created: boolean }> = {};
      let ceoId: string | null = null;

      for (const spec of DROPS_AGENTS) {
        const existing = existingAgents.find(
          (a) => a.name.toLowerCase() === spec.name.toLowerCase(),
        );

        if (existing) {
          // Forzar adapterType=process + adapterConfig correcto (fix onboarding CEO)
          await (db as any)
            .update(agentsTable)
            .set({ adapterType: "process", adapterConfig: spec.adapterConfig, status: "idle" })
            .where(eq(agentsTable.id, existing.id));
          results[spec.envVar] = { id: existing.id, created: false };
          if (spec.name === "CEO") ceoId = existing.id;
          continue;
        }

        const insertValues: Record<string, unknown> = {
          companyId:          company.id,
          name:               spec.name,
          role:               spec.role,
          title:              spec.title,
          status:             "idle",
          adapterType:        "process",
          adapterConfig:      spec.adapterConfig,
          budgetMonthlyCents: spec.budgetMonthlyCents,
        };
        if (spec.name !== "CEO" && ceoId) {
          insertValues.reportsTo = ceoId;
        }

        const [created] = await (db as any)
          .insert(agentsTable)
          .values(insertValues)
          .returning({ id: agentsTable.id });

        results[spec.envVar] = { id: created.id, created: true };
        if (spec.name === "CEO") ceoId = created.id;
      }

      // Grant tasks:assign to CEO so it can create + assign sub-issues
      if (ceoId) await grantTasksAssign(company.id, ceoId);

      const envLines = Object.entries(results)
        .map(([k, v]) => `${k}=${v.id}`)
        .join("\n");

      res.json({ ok: true, company: company.name, companyId: company.id, results, envVars: envLines });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Seed trading agents in DiscontrolsBags ──────────────────────────────────
  // Creates Polymarket trading agents in the DiscontrolsBags company.
  // Protected by the first 16 chars of BETTER_AUTH_SECRET.
  // Usage: GET /api/internal/seed-trading-agents?secret=<first-16-chars>
  app.get("/api/internal/seed-trading-agents", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      const TRADING_COMPANY_ID = "866b74e7-79a7-4166-9f9f-025faa751aa1";

      const TRADING_AGENTS = [
        {
          name: "CEO",
          envVar: "CEO_AGENT_ID",
          title: "Trading Orchestrator — Polymarket",
          role: "manager" as const,
          adapterConfig: { command: "python3", args: ["agents/trading/ceo.py"], cwd: "/app", timeoutSec: 1800 },
          budgetMonthlyCents: 10000,
          reportsTo: null as string | null,
        },
        {
          name: "Market Scanner",
          envVar: "MARKET_SCANNER_AGENT_ID",
          title: "Polymarket Opportunity Scanner",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/trading/stock_analyzer.py"], cwd: "/app", timeoutSec: 120 },
          budgetMonthlyCents: 4000,
          reportsTo: null as string | null,
        },
        {
          name: "Probability Estimator",
          envVar: "PROBABILITY_ESTIMATOR_AGENT_ID",
          title: "LLM-based Probability Analyst",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/trading/strategy_designer.py"], cwd: "/app", timeoutSec: 120 },
          budgetMonthlyCents: 6000,
          reportsTo: null as string | null,
        },
        {
          name: "Risk Manager",
          envVar: "RISK_MANAGER_AGENT_ID",
          title: "Position Sizing & Risk Control",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/trading/strategy_critic.py"], cwd: "/app", timeoutSec: 60 },
          budgetMonthlyCents: 2000,
          reportsTo: null as string | null,
        },
        {
          name: "Executor",
          envVar: "EXECUTOR_AGENT_ID",
          title: "Polymarket Order Executor",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/trading/strategy_optimizer.py"], cwd: "/app", timeoutSec: 120 },
          budgetMonthlyCents: 2000,
          reportsTo: null as string | null,
        },
        {
          name: "Reporter",
          envVar: "REPORTER_AGENT_ID",
          title: "Trade Reporter — Telegram & Logs",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/trading/reporter.py"], cwd: "/app", timeoutSec: 60 },
          budgetMonthlyCents: 2000,
          reportsTo: null as string | null,
        },
        {
          name: "Wallet Analyzer",
          envVar: "WALLET_ANALYZER_AGENT_ID",
          title: "Polymarket Whale Tracker & Copy Signal",
          role: "engineer" as const,
          adapterConfig: { command: "python3", args: ["agents/trading/wallet_analyzer.py"], cwd: "/app", timeoutSec: 300 },
          budgetMonthlyCents: 4000,
          reportsTo: null as string | null,
        },
      ];

      // Listar agentes existentes en la empresa de trading (incluyendo terminated)
      const existingAgents: { id: string; name: string; status: string }[] = await (db as any)
        .select({ id: agentsTable.id, name: agentsTable.name, status: agentsTable.status })
        .from(agentsTable)
        .where(eq(agentsTable.companyId, TRADING_COMPANY_ID));

      const results: Record<string, { id: string; created: boolean }> = {};
      let ceoId: string | null = null;

      for (const spec of TRADING_AGENTS) {
        const existing = existingAgents.find(
          (a) => a.name.toLowerCase() === spec.name.toLowerCase(),
        );

        if (existing) {
          if (existing.status === "terminated") {
            // Borrar el registro terminado y crear uno limpio
            await (db as any).delete(agentsTable).where(eq(agentsTable.id, existing.id));
            console.log(`  🗑️  Deleted terminated ${spec.name} (${existing.id})`);
            // Continuar al bloque de inserción
          } else {
            // Restaurar status idle + actualizar adapterConfig
            await (db as any)
              .update(agentsTable)
              .set({ adapterType: "process", adapterConfig: spec.adapterConfig, status: "idle" })
              .where(eq(agentsTable.id, existing.id));
            results[spec.envVar] = { id: existing.id, created: false };
            if (spec.name === "CEO") ceoId = existing.id;
            console.log(`  ✅ Restored ${spec.name} (${existing.id}) → idle`);
            continue;
          }
        }

        const insertValues: Record<string, unknown> = {
          companyId:           TRADING_COMPANY_ID,
          name:                spec.name,
          role:                spec.role,
          title:               spec.title,
          status:              "idle",
          adapterType:         "process",
          adapterConfig:       spec.adapterConfig,
          budgetMonthlyCents:  spec.budgetMonthlyCents,
        };
        // Los agentes (excepto CEO) reportan al CEO
        if (spec.name !== "CEO" && ceoId) {
          insertValues.reportsTo = ceoId;
        }

        const [created] = await (db as any)
          .insert(agentsTable)
          .values(insertValues)
          .returning({ id: agentsTable.id });

        results[spec.envVar] = { id: created.id, created: true };
        if (spec.name === "CEO") ceoId = created.id;
        console.log(`  ✅ Created ${spec.name} (${created.id})`);
      }

      if (ceoId) await grantTasksAssign(TRADING_COMPANY_ID, ceoId);

      const envLines = Object.entries(results)
        .map(([k, v]) => `${k}=${v.id}`)
        .join("\n");

      res.json({
        ok: true,
        company: "DiscontrolsBags",
        companyId: TRADING_COMPANY_ID,
        results,
        envVars: envLines,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Auth diagnostics ────────────────────────────────────────────────────────
  // GET /api/internal/check-auth-user?email=X&secret=Y
  app.get("/api/internal/check-auth-user", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" }); return;
    }
    const email = ((req.query.email as string) ?? "").toLowerCase().trim();
    if (!email) { res.status(400).json({ error: "email required" }); return; }
    try {
      const { authUsers: users, authAccounts: accounts } = await import("@paperclipai/db");
      const user = await (db as any)
        .select({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified, createdAt: users.createdAt })
        .from(users).where(eq(users.email, email)).limit(1).then((r: any[]) => r[0] ?? null);
      if (!user) { res.json({ exists: false, email }); return; }
      const accts = await (db as any)
        .select({ providerId: accounts.providerId, hasPassword: accounts.password })
        .from(accounts).where(eq(accounts.userId, user.id));
      res.json({ exists: true, user, accounts: accts.map((a: any) => ({ providerId: a.providerId, hasPassword: !!a.hasPassword })) });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/internal/delete-auth-user — delete user so they can re-register
  // Body: { email, secret }
  app.post("/api/internal/delete-auth-user", async (req, res) => {
    const secret = ((req.body as any)?.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" }); return;
    }
    const email = (((req.body as any)?.email as string) ?? "").toLowerCase().trim();
    if (!email) { res.status(400).json({ error: "email required" }); return; }
    try {
      const { authUsers: users } = await import("@paperclipai/db");
      const user = await (db as any)
        .select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1).then((r: any[]) => r[0] ?? null);
      if (!user) { res.json({ deleted: false, reason: "user not found" }); return; }
      await (db as any).delete(users).where(eq(users.id, user.id));
      res.json({ deleted: true, userId: user.id, email });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Restore user memberships to all companies ────────────────────────────────
  // Usage: GET /api/internal/restore-user-access?userId=X&secret=Y
  app.get("/api/internal/restore-user-access", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" }); return;
    }
    const userId = (req.query.userId as string) ?? "";
    if (!userId) { res.status(400).json({ error: "userId required" }); return; }
    try {
      // Get all companies
      const companies = await (db as any)
        .select({ id: companiesTable.id, name: companiesTable.name })
        .from(companiesTable);

      const { and: _and } = await import("drizzle-orm");
      const results: Record<string, string> = {};
      for (const company of companies) {
        // Check if membership exists FOR THIS SPECIFIC COMPANY
        const existing = await (db as any)
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(_and(
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.companyId, company.id),
          ))
          .limit(1)
          .then((r: any[]) => r[0] ?? null);

        if (!existing) {
          await (db as any).insert(companyMemberships).values({
            companyId:      company.id,
            principalType:  "user",
            principalId:    userId,
            status:         "active",
            membershipRole: "admin",
          });
          results[company.name] = "granted";
        } else {
          results[company.name] = "already_exists";
        }
      }
      res.json({ ok: true, userId, results });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Grant instance admin role to a user ──────────────────────────────────────
  // Usage: GET /api/internal/grant-instance-admin?userId=X&secret=Y
  app.get("/api/internal/grant-instance-admin", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" }); return;
    }
    const userId = (req.query.userId as string) ?? "";
    if (!userId) { res.status(400).json({ error: "userId required" }); return; }
    try {
      const { instanceUserRoles } = await import("@paperclipai/db");
      await (db as any)
        .insert(instanceUserRoles)
        .values({ userId, role: "instance_admin" })
        .onConflictDoNothing();
      res.json({ ok: true, userId, role: "instance_admin" });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Fix trading agent scripts in DiscontrolsBags ────────────────────────────
  // Usage: GET /api/internal/fix-trading-scripts?secret=<first-16-chars-BETTER_AUTH_SECRET>
  app.get("/api/internal/fix-trading-scripts", async (req, res) => {
    const secret = (req.query.secret as string) ?? "";
    const expectedSecret = (process.env.BETTER_AUTH_SECRET ?? "").slice(0, 16);
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      res.status(403).json({ error: "forbidden" }); return;
    }
    const TRADING_COMPANY_ID = "866b74e7-79a7-4166-9f9f-025faa751aa1";
    const FIXES = [
      { name: "Market Scanner",        args: ["agents/trading/stock_analyzer.py"],     timeoutSec: 120 },
      { name: "Probability Estimator", args: ["agents/trading/strategy_designer.py"],  timeoutSec: 120 },
      { name: "Risk Manager",          args: ["agents/trading/strategy_critic.py"],     timeoutSec: 60  },
      { name: "Executor",              args: ["agents/trading/strategy_optimizer.py"],  timeoutSec: 120 },
    ];
    try {
      const existing: { id: string; name: string; adapterConfig: unknown }[] = await (db as any)
        .select({ id: agentsTable.id, name: agentsTable.name, adapterConfig: agentsTable.adapterConfig })
        .from(agentsTable)
        .where(eq(agentsTable.companyId, TRADING_COMPANY_ID));

      const results: Record<string, { id: string; updated: boolean }> = {};
      for (const fix of FIXES) {
        const agent = existing.find(a => a.name.toLowerCase() === fix.name.toLowerCase());
        if (!agent) { results[fix.name] = { id: "not found", updated: false }; continue; }
        const current = (agent.adapterConfig as Record<string, unknown>) ?? {};
        await (db as any).update(agentsTable)
          .set({ adapterConfig: { ...current, args: fix.args, timeoutSec: fix.timeoutSec } })
          .where(eq(agentsTable.id, agent.id));
        results[fix.name] = { id: agent.id, updated: true };
      }
      res.json({ ok: true, results });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Quick fix: set timeoutSec on process agents by ID ───────────────────────
  // Auth: Bearer <PAPERCLIP_API_KEY>
  // Usage: GET /api/internal/fix-agent-timeout?id=<agent-id>&timeoutSec=1800
  app.get("/api/internal/fix-agent-timeout", async (req, res) => {
    const agentId = (req.query.id as string) ?? "";
    const timeoutSec = Number(req.query.timeoutSec ?? 1800);
    if (!agentId) {
      res.status(400).json({ error: "id required" });
      return;
    }
    try {
      const rows: { id: string; name: string; adapterConfig: unknown }[] = await (db as any)
        .select({ id: agentsTable.id, name: agentsTable.name, adapterConfig: agentsTable.adapterConfig })
        .from(agentsTable)
        .where(eq(agentsTable.id, agentId));
      if (!rows.length) {
        res.status(404).json({ error: "agent not found" });
        return;
      }
      const current = rows[0].adapterConfig as Record<string, unknown> ?? {};
      // Sobrescribir tanto timeoutSec como timeout (legacy) para cubrir ambos campos
      const updated = { ...current, timeoutSec, timeout: timeoutSec };
      await (db as any).update(agentsTable).set({ adapterConfig: updated }).where(eq(agentsTable.id, agentId));
      res.json({ ok: true, agent: rows[0].name, id: agentId, timeoutSec, adapterConfig: updated });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

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
  api.use(agentRoutes(db));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService, {
    feedbackExportService: opts.feedbackExportService,
  }));
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

  // DiscontrolCreator frontend — todas las pantallas sin auth
  const serveCreatorPage = (file: string) => (_req: any, res: any) => {
    const p = path.resolve(process.cwd(), "frontend", file);
    if (fs.existsSync(p)) res.sendFile(p);
    else res.status(404).send(`${file} not found.`);
  };
  app.get("/",             serveCreatorPage("landing.html"));
  app.get("/cuenta",       serveCreatorPage("cuenta.html"));
  app.get("/panel",        serveCreatorPage("admin.html"));
  app.get("/studio",       serveCreatorPage("index.html"));
  app.get("/agentes",      serveCreatorPage("agentes.html"));
  app.get("/estadisticas", serveCreatorPage("estadisticas.html"));
  app.get("/biblioteca",   serveCreatorPage("biblioteca.html"));
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

  return app;
}
