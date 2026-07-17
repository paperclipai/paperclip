import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockCloudUpstreamService = vi.hoisted(() => ({
  list: vi.fn(),
  startConnect: vi.fn(),
  finishConnect: vi.fn(),
  preview: vi.fn(),
  createRun: vi.fn(),
  readRun: vi.fn(),
  cancelRun: vi.fn(),
  activateRunEntities: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  cloudUpstreamService: () => mockCloudUpstreamService,
  logActivity: mockLogActivity,
}));

import { errorHandler } from "../middleware/index.js";
import { cloudUpstreamRoutes } from "../routes/cloud-upstreams.js";

function createApp(actor: any = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "owner" }],
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", cloudUpstreamRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("cloud upstream routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableCloudSync: true });
  });

  it("denies cross-company connect start before invoking the service", async () => {
    const res = await request(createApp())
      .post("/api/cloud-upstreams/connect/start")
      .send({
        companyId: "company-2",
        remoteUrl: "https://cloud.example.test",
        redirectUri: "http://localhost/callback",
      });

    expect(res.status).toBe(403);
    expect(mockCloudUpstreamService.startConnect).not.toHaveBeenCalled();
  });

  it("logs cloud upstream connect start with requester attribution", async () => {
    mockCloudUpstreamService.startConnect.mockResolvedValue({
      pendingConnectionId: "pending-1",
      authorizationUrl: "https://cloud.example.test/oauth/authorize",
      connection: { id: "conn-1" },
    });

    const res = await request(createApp())
      .post("/api/cloud-upstreams/connect/start")
      .send({
        companyId: "company-1",
        remoteUrl: "https://cloud.example.test",
        redirectUri: "http://localhost/callback",
      });

    expect(res.status).toBe(200);
    expect(mockCloudUpstreamService.startConnect).toHaveBeenCalledWith({
      companyId: "company-1",
      remoteUrl: "https://cloud.example.test",
      redirectUri: "http://localhost/callback",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "cloud_upstream.connect_started",
        actorType: "user",
        actorId: "user-1",
        entityId: "pending-1",
        details: { remoteUrl: "https://cloud.example.test" },
      }),
    );
  });

  it("logs cloud upstream connect finish", async () => {
    mockCloudUpstreamService.finishConnect.mockResolvedValue({
      id: "conn-1",
      companyId: "company-1",
      target: { origin: "https://cloud.example.test" },
    });

    const res = await request(createApp())
      .post("/api/cloud-upstreams/connect/finish")
      .send({
        pendingConnectionId: "pending-1",
        code: "oauth-code",
        state: "oauth-state",
      });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "cloud_upstream.connected",
        actorType: "user",
        actorId: "user-1",
        entityId: "conn-1",
        details: { targetOrigin: "https://cloud.example.test" },
      }),
    );
  });

  it("logs cloud upstream run cancellation", async () => {
    mockCloudUpstreamService.cancelRun.mockResolvedValue({
      id: "run-1",
      connectionId: "conn-1",
      status: "cancelled",
    });

    const res = await request(createApp())
      .post("/api/cloud-upstreams/conn-1/push-runs/run-1/cancel")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "cloud_upstream.push_cancelled",
        entityId: "run-1",
        details: { connectionId: "conn-1", status: "cancelled" },
      }),
    );
  });

  it("logs cloud upstream activation completion", async () => {
    mockCloudUpstreamService.activateRunEntities.mockResolvedValue({
      id: "run-2",
      connectionId: "conn-2",
    });

    const res = await request(createApp())
      .post("/api/cloud-upstreams/conn-2/push-runs/run-2/activation")
      .send({ companyId: "company-1", entityType: "agents" });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "cloud_upstream.activation_completed",
        entityId: "run-2",
        details: { connectionId: "conn-2", entityType: "agents" },
      }),
    );
  });
});
