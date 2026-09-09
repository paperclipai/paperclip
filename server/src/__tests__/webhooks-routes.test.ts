import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webhookRoutes } from "../routes/webhooks.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const webhookId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const deliveryId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const webhook = {
  id: webhookId,
  companyId,
  name: "Test Webhook",
  url: "https://example.com/hook",
  secret: "deadbeef",
  eventTypes: ["alert.created", "incident.opened"],
  active: true,
  consecutiveFailures: 0,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const delivery = {
  id: deliveryId,
  webhookId,
  eventType: "alert.created",
  status: "success",
  attempt: 1,
  nextAttemptAt: null,
  httpStatus: 200,
  latencyMs: 123,
  payloadHash: "abc123",
  payload: { event: "alert.created", timestamp: "2026-01-01T00:00:00.000Z", org_id: companyId, data: {} },
  responseBody: "ok",
  error: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const mockWebhookService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listDeliveries: vi.fn(),
  deliverEvent: vi.fn(),
  testWebhook: vi.fn(),
  retryDelivery: vi.fn(),
  processPendingRetries: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  webhookService: () => mockWebhookService,
}));

const boardActor = { type: "board", companyIds: [companyId] };
const agentActor = { type: "agent", companyId };

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", webhookRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("webhook routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWebhookService.list.mockResolvedValue([webhook]);
    mockWebhookService.get.mockResolvedValue(webhook);
    mockWebhookService.create.mockResolvedValue(webhook);
    mockWebhookService.update.mockResolvedValue({ ...webhook, name: "Updated" });
    mockWebhookService.remove.mockResolvedValue(true);
    mockWebhookService.listDeliveries.mockResolvedValue([delivery]);
    mockWebhookService.testWebhook.mockResolvedValue({ deliveryId });
    mockWebhookService.retryDelivery.mockResolvedValue(true);
  });

  describe("GET /companies/:companyId/webhooks", () => {
    it("returns webhook list for board actor", async () => {
      const app = createApp(boardActor);
      const res = await request(app).get(`/api/companies/${companyId}/webhooks`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(webhookId);
    });

    it("returns webhook list for agent actor", async () => {
      const app = createApp(agentActor);
      const res = await request(app).get(`/api/companies/${companyId}/webhooks`);
      expect(res.status).toBe(200);
    });

    it("returns 403 for wrong company", async () => {
      const app = createApp({ type: "board", companyIds: ["other-company"] });
      const res = await request(app).get(`/api/companies/${companyId}/webhooks`);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /companies/:companyId/webhooks", () => {
    it("creates a webhook with valid body", async () => {
      const app = createApp(boardActor);
      const res = await request(app)
        .post(`/api/companies/${companyId}/webhooks`)
        .send({ name: "Test", url: "https://example.com/hook", eventTypes: ["alert.created"] });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe(webhookId);
    });

    it("returns 400 for invalid url", async () => {
      const app = createApp(boardActor);
      const res = await request(app)
        .post(`/api/companies/${companyId}/webhooks`)
        .send({ name: "Test", url: "not-a-url", eventTypes: ["alert.created"] });
      expect(res.status).toBe(400);
    });

    it("returns 400 for empty eventTypes", async () => {
      const app = createApp(boardActor);
      const res = await request(app)
        .post(`/api/companies/${companyId}/webhooks`)
        .send({ name: "Test", url: "https://example.com/hook", eventTypes: [] });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /webhooks/:id", () => {
    it("updates the webhook", async () => {
      const app = createApp(boardActor);
      const res = await request(app)
        .patch(`/api/webhooks/${webhookId}?companyId=${companyId}`)
        .send({ name: "Updated" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated");
    });

    it("returns 404 when webhook not found", async () => {
      mockWebhookService.update.mockResolvedValue(null);
      const app = createApp(boardActor);
      const res = await request(app)
        .patch(`/api/webhooks/${webhookId}?companyId=${companyId}`)
        .send({ name: "X" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /webhooks/:id", () => {
    it("deletes the webhook", async () => {
      const app = createApp(boardActor);
      const res = await request(app).delete(`/api/webhooks/${webhookId}?companyId=${companyId}`);
      expect(res.status).toBe(204);
    });

    it("returns 404 when not found", async () => {
      mockWebhookService.remove.mockResolvedValue(false);
      const app = createApp(boardActor);
      const res = await request(app).delete(`/api/webhooks/${webhookId}?companyId=${companyId}`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /webhooks/:id/test", () => {
    it("fires a test ping", async () => {
      const app = createApp(boardActor);
      const res = await request(app).post(`/api/webhooks/${webhookId}/test?companyId=${companyId}`);
      expect(res.status).toBe(202);
      expect(res.body.deliveryId).toBe(deliveryId);
    });

    it("returns 404 when webhook not found", async () => {
      mockWebhookService.testWebhook.mockResolvedValue(null);
      const app = createApp(boardActor);
      const res = await request(app).post(`/api/webhooks/${webhookId}/test?companyId=${companyId}`);
      expect(res.status).toBe(404);
    });
  });

  describe("GET /webhooks/:id/deliveries", () => {
    it("returns delivery list", async () => {
      const app = createApp(boardActor);
      const res = await request(app).get(`/api/webhooks/${webhookId}/deliveries?companyId=${companyId}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(deliveryId);
    });
  });

  describe("POST /webhook-deliveries/:id/retry", () => {
    it("retries a delivery", async () => {
      const app = createApp(boardActor);
      const res = await request(app).post(`/api/webhook-deliveries/${deliveryId}/retry?companyId=${companyId}`);
      expect(res.status).toBe(202);
      expect(res.body.deliveryId).toBe(deliveryId);
    });

    it("returns 404 when delivery not found", async () => {
      mockWebhookService.retryDelivery.mockResolvedValue(false);
      const app = createApp(boardActor);
      const res = await request(app).post(`/api/webhook-deliveries/${deliveryId}/retry?companyId=${companyId}`);
      expect(res.status).toBe(404);
    });
  });
});
