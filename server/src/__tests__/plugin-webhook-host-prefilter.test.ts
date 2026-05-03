import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

const mockSecrets = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/plugin-secrets-handler.js", () => ({
  createPluginSecretsHandler: () => mockSecrets,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

const pluginDbId = "11111111-1111-4111-8111-111111111111";
const pluginKey = "paperclip.github-test";
const webhookPath = `/api/plugins/${pluginDbId}/webhooks/github`;
const secretRef = "22222222-2222-4222-8222-222222222222";
const webhookSecret = "github-webhook-secret";

function createDb() {
  const delivery = { id: "33333333-3333-4333-8333-333333333333" };
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([delivery])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(undefined)),
      })),
    })),
  };
}

async function createApp() {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);
  const workerManager = { call: vi.fn(() => Promise.resolve(undefined)) };
  const db = createDb();
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  app.use("/api", pluginRoutes(
    db as never,
    { installPlugin: vi.fn() } as never,
    undefined,
    { workerManager } as never,
  ));
  app.use(errorHandler);
  return { app, db, workerManager };
}

function readyPlugin() {
  mockRegistry.getById.mockResolvedValue({
    id: pluginDbId,
    pluginKey,
    version: "1.0.0",
    status: "ready",
    manifestJson: {
      id: pluginKey,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "GitHub Test",
      capabilities: ["webhooks.receive", "secrets.read-ref"],
      webhooks: [
        {
          endpointKey: "github",
          displayName: "GitHub",
          hostPrefilter: {
            kind: "github-hmac-sha256",
            secretRefConfigKey: "githubWebhookSecretRef",
            maxBodyBytes: 1024,
          },
        },
      ],
      entrypoints: { worker: "./dist/worker.js" },
    },
  });
  mockRegistry.getConfig.mockResolvedValue({
    pluginId: pluginDbId,
    configJson: { githubWebhookSecretRef: secretRef },
  });
  mockSecrets.resolve.mockResolvedValue(webhookSecret);
}

function githubSignature(body: string) {
  return `sha256=${createHmac("sha256", webhookSecret).update(body, "utf8").digest("hex")}`;
}

describe.sequential("plugin webhook host prefilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readyPlugin();
  });

  it("rejects missing GitHub signatures before recording a delivery", async () => {
    const { app, db, workerManager } = await createApp();

    const res = await request(app)
      .post(webhookPath)
      .set("content-type", "application/json")
      .send(JSON.stringify({ ok: true }));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Webhook rejected by host prefilter" });
    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
    expect(mockSecrets.resolve).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("rejects invalid GitHub signatures before recording a delivery", async () => {
    const { app, db, workerManager } = await createApp();

    const res = await request(app)
      .post(webhookPath)
      .set("content-type", "application/json")
      .set("x-hub-signature-256", `sha256=${"0".repeat(64)}`)
      .send(JSON.stringify({ ok: true }));

    expect(res.status).toBe(401);
    expect(mockRegistry.getConfig).toHaveBeenCalledWith(pluginDbId);
    expect(mockSecrets.resolve).toHaveBeenCalledWith({ secretRef });
    expect(db.insert).not.toHaveBeenCalled();
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("records and dispatches accepted GitHub signatures", async () => {
    const { app, db, workerManager } = await createApp();
    const body = JSON.stringify({ ok: true });

    const res = await request(app)
      .post(webhookPath)
      .set("content-type", "application/json")
      .set("x-hub-signature-256", githubSignature(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      deliveryId: "33333333-3333-4333-8333-333333333333",
      status: "success",
    });
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginDbId, "handleWebhook", expect.objectContaining({
      endpointKey: "github",
      rawBody: body,
    }));
  });
});
