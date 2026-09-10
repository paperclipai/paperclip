import { PassThrough } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  PRODUCT_FEEDBACK_SCHEMA_VERSION,
  type ProductFeedbackCapability,
} from "@paperclipai/shared";
import { createHttpLogger } from "../middleware/logger.js";
import { productFeedbackRoutes } from "../routes/product-feedback.js";
import {
  ProductFeedbackRelayError,
  type ProductFeedbackRelay,
} from "../services/product-feedback-relay.js";

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

const companyId = "11111111-1111-4111-8111-111111111111";
const receipt = {
  ok: true as const,
  duplicate: false,
  submissionId: "708db09f-1a29-4dd6-ad62-99b19b6902b4",
  receiptId: "808db09f-1a29-4dd6-ad62-99b19b6902b4",
};

const enabledCapability: ProductFeedbackCapability = {
  enabled: true,
  limits: { feedbackMaxLength: 5_000, diagnosticCount: 5 },
};

function createApp(input: {
  capability?: ProductFeedbackCapability;
  actor?: Partial<Express.Request["actor"]>;
  relay?: ProductFeedbackRelay;
  logStream?: PassThrough;
} = {}) {
  const app = express();
  if (input.logStream) {
    app.use(createHttpLogger(pino({ level: "error" }, input.logStream)));
  }
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user-1",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...input.actor,
    };
    next();
  });
  app.use("/api", productFeedbackRoutes({
    db: {} as Db,
    capability: input.capability ?? enabledCapability,
    relay: input.relay,
  }));
  return app;
}

const validRequest = {
  companyId,
  schemaVersion: PRODUCT_FEEDBACK_SCHEMA_VERSION,
  submissionId: receipt.submissionId,
  submittedAt: "2026-09-03T12:00:00.000Z",
  feedback: "Please make review status clearer.",
  followUpConsent: true,
  reporterEmail: "reporter@example.com",
  context: {
    routeTemplate: "/company/issues",
    appVersion: "2026.9.3",
    deploymentMode: "local_trusted",
    browser: "Chrome 151",
    operatingSystem: "macOS 15",
    diagnostics: [],
  },
};

describe("POST /api/product-feedback", () => {
  beforeEach(() => {
    mockLogActivity.mockClear();
  });

  it("is absent while the capability is disabled", async () => {
    const relay = { submit: vi.fn() };
    const response = await request(createApp({
      capability: { ...enabledCapability, enabled: false },
      relay,
    })).post("/api/product-feedback").send(validRequest);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("product_feedback_disabled");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(relay.submit).not.toHaveBeenCalled();
  });

  it("fails closed without a server-bound relay and preserves a safe retry message", async () => {
    const response = await request(createApp()).post("/api/product-feedback").send(validRequest);

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("product_feedback_unavailable");
    expect(JSON.stringify(response.body)).not.toContain("reporter@example.com");
  });

  it("redacts reporter email and feedback text from HTTP error logs", async () => {
    const logStream = new PassThrough();
    let output = "";
    logStream.on("data", (chunk) => {
      output += chunk.toString();
    });

    const response = await request(createApp({ logStream }))
      .post("/api/product-feedback")
      .send({
        ...validRequest,
        reporterEmail: "privacy-canary@example.test",
        feedback: "private feedback canary",
      });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(response.status).toBe(503);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("privacy-canary@example.test");
    expect(output).not.toContain("private feedback canary");
  });

  it("rejects unknown trust fields and malformed context", async () => {
    const response = await request(createApp())
      .post("/api/product-feedback")
      .send({ ...validRequest, trusted: true });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("invalid_product_feedback_request");
  });

  it("requires contact data exactly when follow-up consent is enabled", async () => {
    const { reporterEmail: _email, ...withoutEmail } = validRequest;
    const missingEmail = await request(createApp()).post("/api/product-feedback").send(withoutEmail);
    const unexpectedEmail = await request(createApp())
      .post("/api/product-feedback")
      .send({ ...validRequest, followUpConsent: false });

    expect(missingEmail.status).toBe(400);
    expect(unexpectedEmail.status).toBe(400);
  });

  it("requires a board session and conceals out-of-scope companies", async () => {
    const relay = { submit: vi.fn() };
    const forbidden = await request(createApp({ actor: { type: "agent", source: "api_key" }, relay }))
      .post("/api/product-feedback")
      .send(validRequest);
    const concealed = await request(createApp({ actor: { companyIds: [], source: "session" }, relay }))
      .post("/api/product-feedback")
      .send(validRequest);

    expect(forbidden.status).toBe(403);
    expect(concealed.status).toBe(404);
    expect(relay.submit).not.toHaveBeenCalled();
  });

  it("relays the strict payload without the local company id and logs only safe metadata", async () => {
    const submit = vi.fn().mockResolvedValue(receipt);
    const response = await request(createApp({ relay: { submit } }))
      .post("/api/product-feedback")
      .send(validRequest);

    expect(response.status).toBe(202);
    expect(response.body).toEqual(receipt);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      submissionId: validRequest.submissionId,
      feedback: validRequest.feedback,
      reporterEmail: validRequest.reporterEmail,
    }));
    expect(submit.mock.calls[0]?.[0]).not.toHaveProperty("companyId");
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      action: "product_feedback.submission_requested",
      entityType: "product_feedback_submission",
      entityId: validRequest.submissionId,
      details: expect.objectContaining({
        destination: "paperclip_telemetry_backend",
        followUpConsent: true,
        diagnosticCount: 0,
      }),
    }));
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain(validRequest.reporterEmail);
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain(validRequest.feedback);
  });

  it("preserves rate-limit semantics without exposing downstream response bodies", async () => {
    const relay = { submit: vi.fn().mockRejectedValue(new ProductFeedbackRelayError(429)) };
    const response = await request(createApp({ relay })).post("/api/product-feedback").send(validRequest);

    expect(response.status).toBe(429);
    expect(response.body.code).toBe("product_feedback_rate_limited");
  });
});
