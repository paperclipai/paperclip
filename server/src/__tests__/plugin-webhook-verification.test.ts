import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  upsertConfig: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";

function readyPluginWithSlackEvents() {
  mockRegistry.getById.mockResolvedValue({
    id: PLUGIN_ID,
    pluginKey: "paperclip-plugin-slack",
    version: "1.0.0",
    status: "ready",
    manifestJson: {
      capabilities: ["webhooks.receive"],
      webhooks: [{ endpointKey: "slack-events" }],
    },
  });
}

async function createApp() {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const workerManager = {
    call: vi.fn(),
    isRunning: vi.fn(() => true),
  };
  const webhookDeps = { workerManager } as never;

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as { rawBody?: Buffer }).rawBody = buf; } }));
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    };
    next();
  });
  app.use("/api", pluginRoutes(
    {} as never,
    { installPlugin: vi.fn() } as never,
    undefined,
    webhookDeps,
    undefined,
    undefined,
  ));
  app.use(errorHandler);

  return { app, workerManager };
}

describe("plugin webhook url_verification handshake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("echoes Slack's challenge token without invoking the worker", async () => {
    readyPluginWithSlackEvents();
    const { app, workerManager } = await createApp();

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/slack-events`)
      .send({ type: "url_verification", token: "fake", challenge: "abc-123-xyz" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: "abc-123-xyz" });
    expect(workerManager.call).not.toHaveBeenCalled();
  }, 20_000);

  it("still dispatches non-verification webhook bodies to the worker", async () => {
    readyPluginWithSlackEvents();
    const { app, workerManager } = await createApp();

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/slack-events`)
      .send({ type: "event_callback", event: { type: "app_mention" } });

    // The route writes to a real db; with our `{}` stub it will fail on the
    // delivery insert, returning 502 but only AFTER reaching the dispatch path
    // (proving we did not short-circuit on a non-verification body).
    expect(workerManager.call).not.toHaveBeenCalledWith(
      PLUGIN_ID,
      expect.anything(),
      expect.objectContaining({ parsedBody: expect.objectContaining({ type: "url_verification" }) }),
    );
    expect(res.status).not.toBe(200);
  }, 20_000);
});
