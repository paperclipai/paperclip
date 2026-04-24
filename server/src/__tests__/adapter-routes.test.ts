import express from "express";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  app.use("/api", adapterRoutesFactory());
  app.use(errorHandlerMiddleware);
  return app;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function requestWithApp<T>(
  app: express.Express,
  run: (agent: request.SuperTest<request.Test>) => Promise<T>,
) {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await run(request(server));
  } finally {
    await closeServer(server);
  }
}

let registerServerAdapterFn!: typeof import("../adapters/index.js").registerServerAdapter;
let unregisterServerAdapterFn!: typeof import("../adapters/index.js").unregisterServerAdapter;
let setOverridePausedFn!: typeof import("../adapters/registry.js").setOverridePaused;
let adapterRoutesFactory!: typeof import("../routes/adapters.js").adapterRoutes;
let errorHandlerMiddleware!: typeof import("../middleware/index.js").errorHandler;

describe.sequential("adapter routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ registerServerAdapter: registerServerAdapterFn, unregisterServerAdapter: unregisterServerAdapterFn } = await import("../adapters/index.js"));
    ({ setOverridePaused: setOverridePausedFn } = await import("../adapters/registry.js"));
    ({ adapterRoutes: adapterRoutesFactory } = await import("../routes/adapters.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
    setOverridePausedFn("claude_local", false);
    registerServerAdapterFn(overridingConfigSchemaAdapter);
  });

  afterEach(() => {
    setOverridePausedFn("claude_local", false);
    unregisterServerAdapterFn("claude_local");
  });

  it.sequential("uses the active adapter when resolving config schema for a paused builtin override", async () => {
    const app = createApp();

    const active = await requestWithApp(app, (agent) =>
      agent.get("/api/adapters/claude_local/config-schema"),
    );
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body).toMatchObject({
      fields: [{ key: "mode" }],
    });

    const paused = await requestWithApp(app, (agent) =>
      agent
        .patch("/api/adapters/claude_local/override")
        .send({ paused: true }),
    );
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body.changed).toBe(true);

    const builtin = await requestWithApp(app, (agent) =>
      agent.get("/api/adapters/claude_local/config-schema"),
    );
    expect(builtin.status, JSON.stringify(builtin.body)).toBe(404);
    expect(String(builtin.body.error ?? "")).toContain("does not provide a config schema");
  });
});
