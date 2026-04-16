import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { templateRoutes } from "../routes/templates.js";
import type { TemplateRegistryService } from "../services/template-registry.js";
import type { TemplateRegistry } from "@paperclipai/shared";

const validRegistry: TemplateRegistry = {
  version: 1,
  generated_at: "2026-04-16T14:00:00Z",
  source: "https://github.com/paperclipai/companies",
  companies: [
    { slug: "a", name: "A", description: "x", agents_count: 1, skills_count: 0, tags: [], url: "https://example.com" },
  ],
};

function mkRegistry(registry: TemplateRegistry = validRegistry): TemplateRegistryService {
  return { get: async () => registry, invalidate: () => {} };
}

function mkApp(opts: { actor?: "board" | "admin" | "none"; registry?: TemplateRegistryService; portability?: unknown }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.actor === "board") (req as any).actor = { type: "board", userId: "u1", isInstanceAdmin: false, source: "session", companyIds: [] };
    else if (opts.actor === "admin") (req as any).actor = { type: "board", userId: "u1", isInstanceAdmin: true, source: "session", companyIds: [] };
    else (req as any).actor = { type: "none" };
    next();
  });
  app.use("/api/templates", templateRoutes({
    registry: opts.registry ?? mkRegistry(),
    portability: (opts.portability as any) ?? { importBundle: async () => ({ company: { id: "new" }, agents: [], warnings: [] }) },
  }));
  return app;
}

describe("GET /api/templates/companies", () => {
  it("returns 401 for unauthenticated requests", async () => {
    const res = await request(mkApp({ actor: "none" })).get("/api/templates/companies");
    expect(res.status).toBe(401);
  });

  it("returns registry companies for board users", async () => {
    const res = await request(mkApp({ actor: "board" })).get("/api/templates/companies");
    expect(res.status).toBe(200);
    expect(res.body.companies).toHaveLength(1);
    expect(res.body.companies[0].slug).toBe("a");
  });

  it("returns 503 when registry load fails", async () => {
    const failing: TemplateRegistryService = { get: async () => { throw new Error("boom"); }, invalidate: () => {} };
    const res = await request(mkApp({ actor: "board", registry: failing })).get("/api/templates/companies");
    expect(res.status).toBe(503);
  });
});
