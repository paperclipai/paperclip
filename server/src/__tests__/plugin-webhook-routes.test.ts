import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  pluginWebhookDeliveries,
  plugins,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { createRawWebhookBodyParser } from "../middleware/raw-webhook-body.js";
import { pluginRoutes } from "../routes/plugins.js";
import { errorHandler } from "../middleware/error-handler.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function createTestDb() {
  const testDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-webhook-");
  cleanups.push(testDb.cleanup);
  return createDb(testDb.connectionString);
}

async function seedPlugin(db: ReturnType<typeof createDb>) {
  const manifest = {
    id: "demo-plugin",
    apiVersion: 1,
    displayName: "Demo Plugin",
    version: "0.1.0",
    capabilities: ["webhooks.receive"],
    webhooks: [{ endpointKey: "demo-ingest" }],
    entrypoints: { worker: "./dist/worker.js" },
  } as const;

  const [plugin] = await db.insert(plugins).values({
    pluginKey: manifest.id,
    packageName: "@paperclipai/demo-plugin",
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    categories: [],
    manifestJson: manifest as any,
    status: "ready",
  }).returning();

  return plugin;
}

function createApp(db: ReturnType<typeof createDb>, workerManager: { call: ReturnType<typeof vi.fn> }) {
  const app = express();
  const jsonParser = express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  });
  app.use("/api/plugins/:pluginId/webhooks/:endpointKey", createRawWebhookBodyParser());
  app.use((req, res, next) => {
    if ((req as unknown as { rawBodyParsed?: boolean }).rawBodyParsed) {
      next();
      return;
    }
    jsonParser(req, res, next);
  });
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", pluginRoutes(db as any, {} as any, undefined, { workerManager } as any));
  app.use(errorHandler);
  return app;
}

describe("plugin webhook routes", () => {
  it("preserves raw json payloads for plugin webhooks", async () => {
    const db = await createTestDb();
    const plugin = await seedPlugin(db);
    const workerManager = { call: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(db, workerManager);

    const res = await request(app)
      .post(`/api/plugins/${plugin.pluginKey}/webhooks/demo-ingest`)
      .set("content-type", "application/json")
      .send({ hello: "world" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(workerManager.call).toHaveBeenCalledWith(
      plugin.id,
      "handleWebhook",
      expect.objectContaining({
        endpointKey: "demo-ingest",
        rawBody: "{\"hello\":\"world\"}",
        parsedBody: { hello: "world" },
      }),
    );
  }, 15_000);

  it("preserves raw non-json payloads for plugin webhooks", async () => {
    const db = await createTestDb();
    const plugin = await seedPlugin(db);
    const workerManager = { call: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(db, workerManager);

    const res = await request(app)
      .post(`/api/plugins/${plugin.pluginKey}/webhooks/demo-ingest`)
      .set("content-type", "text/plain")
      .send("hello=world");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(workerManager.call).toHaveBeenCalledWith(
      plugin.id,
      "handleWebhook",
      expect.objectContaining({
        endpointKey: "demo-ingest",
        rawBody: "hello=world",
        parsedBody: undefined,
      }),
    );

    const deliveries = await db.select().from(pluginWebhookDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.payload).toEqual({});
  }, 15_000);
});
