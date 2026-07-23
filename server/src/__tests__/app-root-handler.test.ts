import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Route mocks ────────────────────────────────────────────────────────────────
// vi.mock factories are hoisted, so they cannot reference file-level variables.
// Each factory imports express inline to build a no-op Router.
vi.mock("../routes/health.js", async () => { const { Router } = await import("express"); return { healthRoutes: () => Router() }; });
vi.mock("../routes/companies.js", async () => { const { Router } = await import("express"); return { companyRoutes: () => Router() }; });
vi.mock("../routes/company-skills.js", async () => { const { Router } = await import("express"); return { companySkillRoutes: () => Router() }; });
vi.mock("../routes/agents.js", async () => { const { Router } = await import("express"); return { agentRoutes: () => Router() }; });
vi.mock("../routes/projects.js", async () => { const { Router } = await import("express"); return { projectRoutes: () => Router() }; });
vi.mock("../routes/issues.js", async () => { const { Router } = await import("express"); return { issueRoutes: () => Router() }; });
vi.mock("../routes/issue-tree-control.js", async () => { const { Router } = await import("express"); return { issueTreeControlRoutes: () => Router() }; });
vi.mock("../routes/routines.js", async () => { const { Router } = await import("express"); return { routineRoutes: () => Router() }; });
vi.mock("../routes/environments.js", async () => { const { Router } = await import("express"); return { environmentRoutes: () => Router() }; });
vi.mock("../routes/execution-workspaces.js", async () => { const { Router } = await import("express"); return { executionWorkspaceRoutes: () => Router() }; });
vi.mock("../routes/goals.js", async () => { const { Router } = await import("express"); return { goalRoutes: () => Router() }; });
vi.mock("../routes/approvals.js", async () => { const { Router } = await import("express"); return { approvalRoutes: () => Router() }; });
vi.mock("../routes/secrets.js", async () => { const { Router } = await import("express"); return { secretRoutes: () => Router() }; });
vi.mock("../routes/costs.js", async () => { const { Router } = await import("express"); return { costRoutes: () => Router() }; });
vi.mock("../routes/activity.js", async () => { const { Router } = await import("express"); return { activityRoutes: () => Router() }; });
vi.mock("../routes/dashboard.js", async () => { const { Router } = await import("express"); return { dashboardRoutes: () => Router() }; });
vi.mock("../routes/user-profiles.js", async () => { const { Router } = await import("express"); return { userProfileRoutes: () => Router() }; });
vi.mock("../routes/sidebar-badges.js", async () => { const { Router } = await import("express"); return { sidebarBadgeRoutes: () => Router() }; });
vi.mock("../routes/sidebar-preferences.js", async () => { const { Router } = await import("express"); return { sidebarPreferenceRoutes: () => Router() }; });
vi.mock("../routes/inbox-dismissals.js", async () => { const { Router } = await import("express"); return { inboxDismissalRoutes: () => Router() }; });
vi.mock("../routes/instance-settings.js", async () => { const { Router } = await import("express"); return { instanceSettingsRoutes: () => Router() }; });
vi.mock("../routes/instance-database-backups.js", async () => { const { Router } = await import("express"); return { instanceDatabaseBackupRoutes: () => Router() }; });
vi.mock("../routes/llms.js", async () => { const { Router } = await import("express"); return { llmRoutes: () => Router() }; });
vi.mock("../routes/auth.js", async () => { const { Router } = await import("express"); return { authRoutes: () => Router() }; });
vi.mock("../routes/assets.js", async () => { const { Router } = await import("express"); return { assetRoutes: () => Router() }; });
vi.mock("../routes/access.js", async () => { const { Router } = await import("express"); return { accessRoutes: () => Router() }; });
vi.mock("../routes/plugins.js", async () => { const { Router } = await import("express"); return { pluginRoutes: () => Router() }; });
vi.mock("../routes/adapters.js", async () => { const { Router } = await import("express"); return { adapterRoutes: () => Router() }; });
vi.mock("../routes/plugin-ui-static.js", async () => { const { Router } = await import("express"); return { pluginUiStaticRoutes: () => Router() }; });

// ── Middleware mocks ───────────────────────────────────────────────────────────
vi.mock("../middleware/index.js", () => ({
  httpLogger: (_req: unknown, _res: unknown, next: () => void) => next(),
  errorHandler: (_err: unknown, _req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) =>
    res.status(500).json({ error: "Server error" }),
}));
vi.mock("../middleware/auth.js", () => ({
  actorMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../middleware/board-mutation-guard.js", () => ({
  boardMutationGuard: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../middleware/private-hostname-guard.js", () => ({
  privateHostnameGuard: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolvePrivateHostnameAllowSet: () => new Set<string>(),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ── Plugin service mocks ───────────────────────────────────────────────────────
vi.mock("../services/plugin-loader.js", () => ({
  DEFAULT_LOCAL_PLUGIN_DIR: "/tmp/test-plugins",
  pluginLoader: () => ({ loadAll: vi.fn().mockResolvedValue(null) }),
}));
vi.mock("../services/plugin-worker-manager.js", () => ({
  createPluginWorkerManager: () => ({ getWorker: vi.fn() }),
}));
vi.mock("../services/plugin-job-scheduler.js", () => ({
  createPluginJobScheduler: () => ({ start: vi.fn(), stop: vi.fn() }),
}));
vi.mock("../services/plugin-job-store.js", () => ({
  pluginJobStore: () => ({}),
}));
vi.mock("../services/plugin-tool-dispatcher.js", () => ({
  createPluginToolDispatcher: () => ({ initialize: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({}),
}));
vi.mock("../services/plugin-job-coordinator.js", () => ({
  createPluginJobCoordinator: () => ({ start: vi.fn() }),
}));
vi.mock("../services/plugin-host-services.js", () => ({
  buildHostServices: () => ({ dispose: vi.fn() }),
  flushPluginLogBuffer: vi.fn(),
}));
vi.mock("../services/plugin-event-bus.js", () => ({
  createPluginEventBus: () => ({}),
}));
vi.mock("../services/activity-log.js", () => ({
  setPluginEventBus: vi.fn(),
}));
vi.mock("../services/plugin-dev-watcher.js", () => ({
  createPluginDevWatcher: () => ({ watch: vi.fn(), close: vi.fn() }),
}));
vi.mock("../services/plugin-host-service-cleanup.js", () => ({
  createPluginHostServiceCleanup: () => ({ disposeAll: vi.fn(), teardown: vi.fn() }),
}));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({ getById: vi.fn() }),
}));
vi.mock("@paperclipai/plugin-sdk", () => ({
  createHostClientHandlers: vi.fn(() => ({})),
}));
vi.mock("../vite-html-renderer.js", () => ({
  createCachedViteHtmlRenderer: () => ({ render: vi.fn(), dispose: vi.fn() }),
}));
vi.mock("../ui-branding.js", () => ({
  applyUiBranding: (html: string) => html,
}));

// ── Imports ────────────────────────────────────────────────────────────────────
import { createApp } from "../app.js";
import type { Db } from "@paperclipai/db";

const MINIMAL_OPTS = {
  serverPort: 3100,
  storageService: {} as never,
  deploymentMode: "local_trusted" as const,
  deploymentExposure: "private" as const,
  allowedHostnames: [],
  bindHost: "127.0.0.1",
  authReady: true,
  companyDeletionEnabled: false,
};

describe("GET / root handler — API-only modes", () => {
  // Silence the expected console.warn about missing dist
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a JSON Paperclip API message when uiMode is none", async () => {
    const app = await createApp({} as Db, { ...MINIMAL_OPTS, uiMode: "none" });
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Paperclip API", api: "/api" });
  });

  it("returns a JSON Paperclip API message when uiMode is static but dist is missing", async () => {
    // Default dist paths don't exist in the test environment, so the else-branch fires.
    const app = await createApp({} as Db, { ...MINIMAL_OPTS, uiMode: "static" });
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Paperclip API", api: "/api" });
  });

  it("returns 200 (not 404) for SPA routes when uiMode is static but dist is missing", async () => {
    const app = await createApp({} as Db, { ...MINIMAL_OPTS, uiMode: "static" });
    const res = await request(app).get("/BRA/issues");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Paperclip API", api: "/api" });
  });

  it("returns 200 (not 404) for SPA routes when uiMode is none", async () => {
    const app = await createApp({} as Db, { ...MINIMAL_OPTS, uiMode: "none" });
    const res = await request(app).get("/BRA/issues");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Paperclip API", api: "/api" });
  });

  it("returns 404 for /assets/* routes when dist is missing", async () => {
    const app = await createApp({} as Db, { ...MINIMAL_OPTS, uiMode: "static" });
    const res = await request(app).get("/assets/main.abc123.js");
    expect(res.status).toBe(404);
  });
});
