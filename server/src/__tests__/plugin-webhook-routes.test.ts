import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  list: vi.fn(),
}));

const mockWorkerManager = vi.hoisted(() => ({
  call: vi.fn(),
}));

function registerRouteMocks() {
  vi.doMock("../services/plugin-registry.js", () => ({
    pluginRegistryService: () => mockRegistry,
  }));
  vi.doMock("../services/plugin-lifecycle.js", () => ({
    pluginLifecycleManager: () => ({}) as unknown,
  }));
  vi.doMock("../services/plugin-loader.js", () => ({
    pluginLoader: () => ({}) as unknown,
    getPluginUiContributionMetadata: vi.fn(),
  }));
  vi.doMock("../services/activity-log.js", () => ({
    logActivity: vi.fn(),
  }));
  vi.doMock("../services/live-events.js", () => ({
    publishGlobalLiveEvent: vi.fn(),
  }));
  vi.doMock("../services/plugin-config-validator.js", () => ({
    validateInstanceConfig: vi.fn(),
  }));
}

async function createApp() {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.urlencoded({
    extended: false,
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    } as any;
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "delivery-1" }]),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(undefined),
          })),
        })),
      } as any,
      {} as any,
      undefined,
      { workerManager: mockWorkerManager as any },
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("plugin webhook routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    registerRouteMocks();
    mockRegistry.getById.mockResolvedValue({
      id: "plugin-1",
      status: "ready",
      manifestJson: {
        capabilities: ["webhooks.receive"],
        webhooks: [
          { endpointKey: "slash-command", displayName: "Slash commands" },
          { endpointKey: "slack-events", displayName: "Slack events" },
          { endpointKey: "slack-interactivity", displayName: "Slack interactivity" },
        ],
      },
    });
    mockRegistry.getByKey.mockResolvedValue(null);
    mockWorkerManager.call.mockResolvedValue(undefined);
  });

  it("returns an empty 200 response for Slack slash commands", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/plugins/plugin-1/webhooks/slash-command")
      .set("x-slack-signature", "v0=fake-signature")
      .set("x-slack-request-timestamp", "1234567890")
      .type("form")
      .send({
        command: "/clip",
        text: "help",
        channel_id: "C123",
        user_id: "U123",
        response_url: "https://example.com/response",
      });

    expect(res.status).toBe(200);
    expect(res.text).toBe("");
    expect(mockWorkerManager.call).toHaveBeenCalledTimes(1);
    expect(mockWorkerManager.call).toHaveBeenCalledWith(
      "plugin-1",
      "handleWebhook",
      expect.objectContaining({
        endpointKey: "slash-command",
        rawBody: expect.stringContaining("command=%2Fclip"),
      }),
    );
  });

  it("passes through the Slack url_verification challenge without calling the worker", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/plugins/plugin-1/webhooks/slack-events")
      .set("x-slack-signature", "v0=fake-signature")
      .set("x-slack-request-timestamp", "1234567890")
      .send({
        type: "url_verification",
        challenge: "challenge-123",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: "challenge-123" });
    expect(mockWorkerManager.call).not.toHaveBeenCalled();
  });
});
