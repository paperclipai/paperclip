import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { webhookRoutes } from "../routes/webhooks.js";
import { errorHandler } from "../middleware/error-handler.js";

// Mock services
vi.mock("../services/index.js", () => {
  const store: Map<string, any> = new Map();
  let nextId = 0;

  return {
    logActivity: vi.fn().mockResolvedValue(undefined),
    webhookService: () => ({
      list: vi.fn(async (companyId: string) =>
        Array.from(store.values()).filter((h) => h.companyId === companyId),
      ),
      getById: vi.fn(async (id: string) => store.get(id) ?? null),
      create: vi.fn(async (companyId: string, input: any) => {
        nextId++;
        const hook = {
          id: `wh-${nextId}`,
          companyId,
          url: input.url,
          secret: input.secret ?? null,
          events: input.events,
          enabled: input.enabled ?? true,
          description: input.description ?? null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        store.set(hook.id, hook);
        // Mimic real service: strip secret from response
        const { secret: _, ...rest } = hook;
        return rest;
      }),
      update: vi.fn(async (id: string, input: any) => {
        const existing = store.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...input, updatedAt: new Date().toISOString() };
        store.set(id, updated);
        // Mimic real service: strip secret from response
        const { secret: _, ...rest } = updated;
        return rest;
      }),
      remove: vi.fn(async (id: string) => {
        const existing = store.get(id);
        if (!existing) return null;
        store.delete(id);
        return existing;
      }),
      deliverTo: vi.fn().mockResolvedValue(undefined),
      dispatch: vi.fn().mockResolvedValue(undefined),
    }),
    _testStore: store,
    _resetStore: () => {
      store.clear();
      nextId = 0;
    },
  };
});

// Mock authz
vi.mock("../routes/authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
}));

const { _resetStore } = await import("../services/index.js");

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "test-user", companyIds: ["comp-1"] };
    next();
  });
  app.use(webhookRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("webhook routes", () => {
  let app: express.Express;

  beforeEach(() => {
    (_resetStore as any)();
    app = createTestApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /companies/:companyId/webhooks", () => {
    it("creates a webhook with valid input", async () => {
      const res = await request(app)
        .post("/companies/comp-1/webhooks")
        .send({
          url: "https://hooks.slack.com/test",
          events: ["approval.created", "run.failed"],
          description: "Slack notifications",
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        url: "https://hooks.slack.com/test",
        events: ["approval.created", "run.failed"],
        companyId: "comp-1",
        enabled: true,
      });
    });

    it("creates a webhook with secret but does not expose it in response", async () => {
      const res = await request(app)
        .post("/companies/comp-1/webhooks")
        .send({
          url: "https://example.com/webhook",
          secret: "my-secret-key",
          events: ["run.succeeded"],
        });

      expect(res.status).toBe(201);
      expect(res.body.secret).toBeUndefined();
    });

    it("rejects invalid URL", async () => {
      const res = await request(app)
        .post("/companies/comp-1/webhooks")
        .send({
          url: "not-a-url",
          events: ["approval.created"],
        });

      expect(res.status).toBe(400);
    });

    it("rejects empty events array", async () => {
      const res = await request(app)
        .post("/companies/comp-1/webhooks")
        .send({
          url: "https://example.com/webhook",
          events: [],
        });

      expect(res.status).toBe(400);
    });

    it("rejects invalid event type", async () => {
      const res = await request(app)
        .post("/companies/comp-1/webhooks")
        .send({
          url: "https://example.com/webhook",
          events: ["invalid.event"],
        });

      expect(res.status).toBe(400);
    });

    it("rejects short secret", async () => {
      const res = await request(app)
        .post("/companies/comp-1/webhooks")
        .send({
          url: "https://example.com/webhook",
          secret: "short",
          events: ["run.failed"],
        });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /companies/:companyId/webhooks", () => {
    it("lists webhooks for a company", async () => {
      await request(app)
        .post("/companies/comp-1/webhooks")
        .send({ url: "https://a.com/hook", events: ["run.failed"] });
      await request(app)
        .post("/companies/comp-1/webhooks")
        .send({ url: "https://b.com/hook", events: ["approval.created"] });

      const res = await request(app).get("/companies/comp-1/webhooks");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });
  });

  describe("PATCH /webhooks/:id", () => {
    it("updates a webhook", async () => {
      const createRes = await request(app)
        .post("/companies/comp-1/webhooks")
        .send({ url: "https://a.com/hook", events: ["run.failed"] });
      const id = createRes.body.id;

      const res = await request(app)
        .patch(`/webhooks/${id}`)
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
    });

    it("returns 404 for nonexistent webhook", async () => {
      const res = await request(app)
        .patch("/webhooks/nonexistent")
        .send({ enabled: false });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /webhooks/:id", () => {
    it("deletes a webhook", async () => {
      const createRes = await request(app)
        .post("/companies/comp-1/webhooks")
        .send({ url: "https://a.com/hook", events: ["run.failed"] });
      const id = createRes.body.id;

      const res = await request(app).delete(`/webhooks/${id}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const listRes = await request(app).get("/companies/comp-1/webhooks");
      expect(listRes.body).toHaveLength(0);
    });

    it("returns 404 for nonexistent webhook", async () => {
      const res = await request(app).delete("/webhooks/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /webhooks/:id/test", () => {
    it("dispatches a test webhook", async () => {
      const createRes = await request(app)
        .post("/companies/comp-1/webhooks")
        .send({ url: "https://a.com/hook", events: ["approval.created"] });
      const id = createRes.body.id;

      const res = await request(app).post(`/webhooks/${id}/test`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
    });

    it("returns 404 for nonexistent webhook", async () => {
      const res = await request(app).post("/webhooks/nonexistent/test");
      expect(res.status).toBe(404);
    });
  });
});

describe("webhook HMAC signing", () => {
  it("produces correct sha256 signature", async () => {
    const { _signForTest: sign } = await import("../services/webhooks.js");
    const payload = JSON.stringify({ event: "test", data: {} });
    const secret = "test-secret-key";

    const signature = sign(payload, secret);
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");

    expect(signature).toBe(expected);
  });
});

describe("webhook SSRF protection", () => {
  it("blocks localhost URLs", async () => {
    const { _isBlockedUrlForTest: isBlocked } = await import("../services/webhooks.js");
    expect(isBlocked("http://localhost:3100/api/secrets")).toBe(true);
    expect(isBlocked("http://127.0.0.1/internal")).toBe(true);
    expect(isBlocked("http://0.0.0.0/")).toBe(true);
  });

  it("blocks private IP ranges", async () => {
    const { _isBlockedUrlForTest: isBlocked } = await import("../services/webhooks.js");
    expect(isBlocked("http://10.0.0.1/")).toBe(true);
    expect(isBlocked("http://192.168.1.1/")).toBe(true);
    expect(isBlocked("http://172.16.0.1/")).toBe(true);
  });

  it("blocks cloud metadata endpoints", async () => {
    const { _isBlockedUrlForTest: isBlocked } = await import("../services/webhooks.js");
    expect(isBlocked("http://169.254.169.254/latest/meta-data/")).toBe(true);
    expect(isBlocked("http://metadata.google.internal/")).toBe(true);
  });

  it("allows public URLs", async () => {
    const { _isBlockedUrlForTest: isBlocked } = await import("../services/webhooks.js");
    expect(isBlocked("https://hooks.slack.com/services/T123/B456")).toBe(false);
    expect(isBlocked("https://example.com/webhook")).toBe(false);
  });
});

describe("webhook event types", () => {
  it("exports all expected event types", async () => {
    const { WEBHOOK_EVENT_TYPES } = await import("@paperclipai/shared");

    expect(WEBHOOK_EVENT_TYPES).toContain("approval.created");
    expect(WEBHOOK_EVENT_TYPES).toContain("approval.approved");
    expect(WEBHOOK_EVENT_TYPES).toContain("approval.rejected");
    expect(WEBHOOK_EVENT_TYPES).toContain("run.succeeded");
    expect(WEBHOOK_EVENT_TYPES).toContain("run.failed");
    expect(WEBHOOK_EVENT_TYPES).toContain("run.timed_out");
    expect(WEBHOOK_EVENT_TYPES).toContain("agent.status");
    expect(WEBHOOK_EVENT_TYPES).toContain("issue.created");
    expect(WEBHOOK_EVENT_TYPES).toContain("issue.updated");
  });
});
