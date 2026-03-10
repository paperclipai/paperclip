import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../middleware/index.js", () => ({
  httpLogger: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  errorHandler: (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  },
}));

vi.mock("../middleware/auth.js", () => ({
  actorMiddleware: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).actor = { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" };
    next();
  },
}));

vi.mock("../middleware/board-mutation-guard.js", () => ({
  boardMutationGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../middleware/private-hostname-guard.js", () => ({
  privateHostnameGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  resolvePrivateHostnameAllowSet: () => new Set(["127.0.0.1", "localhost"]),
}));

vi.mock("../routes/health.js", () => ({ healthRoutes: () => express.Router() }));
vi.mock("../routes/companies.js", () => ({ companyRoutes: () => express.Router() }));
vi.mock("../routes/agents.js", () => ({ agentRoutes: () => express.Router() }));
vi.mock("../routes/projects.js", () => ({ projectRoutes: () => express.Router() }));
vi.mock("../routes/issues.js", () => ({ issueRoutes: () => express.Router() }));
vi.mock("../routes/goals.js", () => ({ goalRoutes: () => express.Router() }));
vi.mock("../routes/approvals.js", () => ({ approvalRoutes: () => express.Router() }));
vi.mock("../routes/secrets.js", () => ({ secretRoutes: () => express.Router() }));
vi.mock("../routes/costs.js", () => ({ costRoutes: () => express.Router() }));
vi.mock("../routes/activity.js", () => ({ activityRoutes: () => express.Router() }));
vi.mock("../routes/dashboard.js", () => ({ dashboardRoutes: () => express.Router() }));
vi.mock("../routes/sidebar-badges.js", () => ({ sidebarBadgeRoutes: () => express.Router() }));
vi.mock("../routes/llms.js", () => ({ llmRoutes: () => express.Router() }));
vi.mock("../routes/assets.js", () => ({ assetRoutes: () => express.Router() }));
vi.mock("../routes/access.js", () => ({ accessRoutes: () => express.Router() }));

import { createApp } from "../app.js";

const tempArtifacts: string[] = [];

afterEach(() => {
  for (const fileOrDir of tempArtifacts.splice(0)) fs.rmSync(fileOrDir, { recursive: true, force: true });
});

async function makeApp() {
  const uiDistDir = path.resolve(process.cwd(), '..', 'ui', 'dist');
  fs.mkdirSync(uiDistDir, { recursive: true });
  const indexPath = path.join(uiDistDir, 'index.html');
  fs.writeFileSync(indexPath, "<!doctype html><html><body>Paperclip SPA</body></html>");
  tempArtifacts.push(indexPath);
  return createApp({} as never, {
    uiMode: "static",
    storageService: {} as never,
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    allowedHostnames: [],
    bindHost: "127.0.0.1",
    authReady: true,
    companyDeletionEnabled: true,
  });
}

describe("SPA fallback", () => {
  it("serves index.html for direct deep links", async () => {
    const app = await makeApp();

    for (const route of ["/TAP/dashboard", "/TAP/issues", "/issues"]) {
      const res = await request(app).get(route);
      expect(res.status, route).toBe(200);
      expect(res.headers["content-type"], route).toContain("text/html");
      expect(res.text, route).toContain("Paperclip SPA");
    }
  });

  it("keeps unknown API routes as API 404s", async () => {
    const app = await makeApp();
    const res = await request(app).get("/api/not-found");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "API route not found" });
  });
});
