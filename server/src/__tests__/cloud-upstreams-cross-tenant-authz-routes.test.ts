import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

// Two tenants. The acting board user belongs ONLY to company A.
const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mockCloudUpstreamService = vi.hoisted(() => ({
  list: vi.fn(async () => ({ connections: [], runs: [] })),
  startConnect: vi.fn(async () => ({})),
  finishConnect: vi.fn(async () => ({})),
  preview: vi.fn(async () => ({})),
  createRun: vi.fn(async () => ({})),
  readRun: vi.fn(async () => ({})),
  cancelRun: vi.fn(async () => ({})),
  activateRunEntities: vi.fn(async () => ({})),
}));

vi.mock("../services/index.js", () => ({
  cloudUpstreamService: () => mockCloudUpstreamService,
  instanceSettingsService: () => ({
    getExperimental: vi.fn(async () => ({ enableCloudSync: true })),
  }),
}));

// Uses the REAL authz module (the guard under test) and the REAL errorHandler.
import { errorHandler } from "../middleware/index.js";
import { cloudUpstreamRoutes } from "../routes/cloud-upstreams.js";

let currentActor: Record<string, unknown>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = currentActor;
    next();
  });
  app.use("/api", cloudUpstreamRoutes({} as any));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Board user who belongs to company A only (not an instance admin).
  currentActor = {
    type: "board",
    source: "authenticated",
    userId: "user-a",
    isInstanceAdmin: false,
    companyIds: [COMPANY_A],
    memberships: [{ companyId: COMPANY_A, role: "owner", status: "active" }],
  };
});

describe("cloud-upstreams cross-tenant authz", () => {
  it("denies reading another tenant's upstreams (GET ?companyId=B)", async () => {
    const res = await request(buildApp()).get(`/api/cloud-upstreams?companyId=${COMPANY_B}`);
    expect(res.status).toBe(403);
    expect(mockCloudUpstreamService.list).not.toHaveBeenCalled();
  });

  it("allows reading the actor's own tenant (GET ?companyId=A)", async () => {
    const res = await request(buildApp()).get(`/api/cloud-upstreams?companyId=${COMPANY_A}`);
    expect(res.status).toBe(200);
    expect(mockCloudUpstreamService.list).toHaveBeenCalledWith(COMPANY_A);
  });

  it("denies creating a push-run for another tenant (POST companyId=B)", async () => {
    const res = await request(buildApp())
      .post(`/api/cloud-upstreams/conn-1/push-runs`)
      .send({ companyId: COMPANY_B });
    expect(res.status).toBe(403);
    expect(mockCloudUpstreamService.createRun).not.toHaveBeenCalled();
  });

  it("denies previewing another tenant's connection (POST companyId=B)", async () => {
    const res = await request(buildApp())
      .post(`/api/cloud-upstreams/conn-1/push-runs/preview`)
      .send({ companyId: COMPANY_B });
    expect(res.status).toBe(403);
    expect(mockCloudUpstreamService.preview).not.toHaveBeenCalled();
  });

  it("denies cancelling a run in another tenant (POST companyId=B)", async () => {
    const res = await request(buildApp())
      .post(`/api/cloud-upstreams/conn-1/push-runs/run-1/cancel`)
      .send({ companyId: COMPANY_B });
    expect(res.status).toBe(403);
    expect(mockCloudUpstreamService.cancelRun).not.toHaveBeenCalled();
  });
});
