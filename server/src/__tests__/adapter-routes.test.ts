import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

const overridingConfigSchemaAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "claude_local",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  getConfigSchema: async () => ({
    version: 1,
    fields: [
      {
        key: "mode",
        type: "text",
        label: "Mode",
      },
    ],
  }),
};

let registerServerAdapter: typeof import("../adapters/index.js").registerServerAdapter;
let unregisterServerAdapter: typeof import("../adapters/index.js").unregisterServerAdapter;
let setOverridePaused: typeof import("../adapters/registry.js").setOverridePaused;
let adapterRoutes: typeof import("../routes/adapters.js").adapterRoutes;
let errorHandler: typeof import("../middleware/index.js").errorHandler;

function resetAdapterRouteModules() {
  vi.resetModules();
  vi.doUnmock("@paperclipai/adapter-utils");
  vi.doUnmock("@paperclipai/db");
  vi.doUnmock("@paperclipai/shared");
  vi.doUnmock("../adapters/index.js");
  vi.doUnmock("../adapters/index.ts");
  vi.doUnmock("../adapters/registry.js");
  vi.doUnmock("../adapters/registry.ts");
  vi.doUnmock("../adapters/plugin-loader.js");
  vi.doUnmock("../adapters/plugin-loader.ts");
  vi.doUnmock("../adapters/builtin-adapter-types.js");
  vi.doUnmock("../adapters/builtin-adapter-types.ts");
  vi.doUnmock("../services/adapter-plugin-store.js");
  vi.doUnmock("../services/adapter-plugin-store.ts");
  vi.doUnmock("../routes/adapters.js");
  vi.doUnmock("../routes/adapters.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../middleware/logger.js");
  vi.doUnmock("../middleware/logger.ts");
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", adapterRoutes());
  app.use(errorHandler);
  return app;
}

describe("adapter routes", () => {
  beforeEach(async () => {
    resetAdapterRouteModules();
    const [adapters, registry] = await Promise.all([
      import("../adapters/index.ts"),
      import("../adapters/registry.ts"),
    ]);
    registerServerAdapter = adapters.registerServerAdapter;
    unregisterServerAdapter = adapters.unregisterServerAdapter;
    setOverridePaused = registry.setOverridePaused;
    setOverridePaused("claude_local", false);
    unregisterServerAdapter("claude_local");
    registerServerAdapter(overridingConfigSchemaAdapter);
    const [routes, middleware] = await Promise.all([
      import("../routes/adapters.ts"),
      import("../middleware/index.ts"),
    ]);
    adapterRoutes = routes.adapterRoutes;
    errorHandler = middleware.errorHandler;
  });

  afterEach(() => {
    setOverridePaused("claude_local", false);
    unregisterServerAdapter("claude_local");
  });

  it("GET /api/adapters includes capabilities object for each adapter", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    // Every adapter should have a capabilities object
    for (const adapter of res.body) {
      expect(adapter.capabilities).toBeDefined();
      expect(typeof adapter.capabilities.supportsInstructionsBundle).toBe("boolean");
      expect(typeof adapter.capabilities.supportsSkills).toBe("boolean");
      expect(typeof adapter.capabilities.supportsLocalAgentJwt).toBe("boolean");
      expect(typeof adapter.capabilities.requiresMaterializedRuntimeSkills).toBe("boolean");
    }
  });

  it("GET /api/adapters returns correct capabilities for built-in adapters", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);

    // codex_local has instructions bundle + skills + jwt, no materialized skills
    // (claude_local is overridden by beforeEach, so check codex_local instead)
    const codexLocal = res.body.find((a: any) => a.type === "codex_local");
    expect(codexLocal).toBeDefined();
    expect(codexLocal.capabilities).toMatchObject({
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: false,
    });

    // process adapter should have no local capabilities
    const processAdapter = res.body.find((a: any) => a.type === "process");
    expect(processAdapter).toBeDefined();
    expect(processAdapter.capabilities).toMatchObject({
      supportsInstructionsBundle: false,
      supportsSkills: false,
      supportsLocalAgentJwt: false,
      requiresMaterializedRuntimeSkills: false,
    });

    // cursor adapter should require materialized runtime skills
    const cursorAdapter = res.body.find((a: any) => a.type === "cursor");
    expect(cursorAdapter).toBeDefined();
    expect(cursorAdapter.capabilities.requiresMaterializedRuntimeSkills).toBe(true);
    expect(cursorAdapter.capabilities.supportsInstructionsBundle).toBe(true);
  });

  it("GET /api/adapters derives supportsSkills from listSkills/syncSkills presence", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);

    // http adapter has no listSkills/syncSkills
    const httpAdapter = res.body.find((a: any) => a.type === "http");
    expect(httpAdapter).toBeDefined();
    expect(httpAdapter.capabilities.supportsSkills).toBe(false);

    // codex_local has listSkills/syncSkills
    const codexLocal = res.body.find((a: any) => a.type === "codex_local");
    expect(codexLocal).toBeDefined();
    expect(codexLocal.capabilities.supportsSkills).toBe(true);
  });

  it("uses the active adapter when resolving config schema for a paused builtin override", async () => {
    const app = createApp();

    const active = await request(app).get("/api/adapters/claude_local/config-schema");
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body).toMatchObject({
      fields: [{ key: "mode" }],
    });

    const paused = await request(app)
      .patch("/api/adapters/claude_local/override")
      .send({ paused: true });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);

    const builtin = await request(app).get("/api/adapters/claude_local/config-schema");
    expect([200, 404], JSON.stringify(builtin.body)).toContain(builtin.status);
    expect(builtin.body).not.toMatchObject({
      fields: [{ key: "mode" }],
    });
  });

  it("reports whether adapters support local agent runtime auth", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "codex_local",
          supportsLocalAgentJwt: true,
        }),
        expect.objectContaining({
          type: "process",
          supportsLocalAgentJwt: false,
        }),
      ]),
    );
  });
});
