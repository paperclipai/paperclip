import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seatRoutes } from "../routes/seats.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const seatId = "33333333-3333-4333-8333-333333333333";

const mockSeatService = vi.hoisted(() => ({
  getDetail: vi.fn(),
  updateDelegatedPermissions: vi.fn(),
  attachHuman: vi.fn(),
  detachHuman: vi.fn(),
  backfillCompany: vi.fn(),
  reconcileModes: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  seatService: () => mockSeatService,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    };
    next();
  });
  app.use("/api", seatRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("seat routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSeatService.attachHuman.mockResolvedValue({
      companyId,
      seatId,
      operatingMode: "assisted",
      currentHumanUserId: "user-1",
      fallbackReassignedIssueCount: 0,
    });
    mockSeatService.detachHuman.mockResolvedValue({
      companyId,
      seatId,
      operatingMode: "vacant",
      currentHumanUserId: null,
      fallbackReassignedIssueCount: 2,
    });
    mockSeatService.backfillCompany.mockResolvedValue({
      seatsCreated: 3,
      seatsUpdated: 1,
      primaryOccupanciesCreated: 3,
      agentsLinkedToSeats: 3,
      ownershipBackfills: {
        issues: 2,
        projects: 1,
        goals: 1,
        routines: 1,
      },
      warnings: [],
    });
    mockSeatService.reconcileModes.mockResolvedValue({
      companyId,
      scannedSeatCount: 3,
      updatedSeatCount: 2,
    });
    mockSeatService.getDetail.mockResolvedValue({
      id: seatId,
      companyId,
      slug: "ops-seat",
      name: "Operations Seat",
      title: "Operations",
      seatType: "manager",
      status: "active",
      operatingMode: "assisted",
      currentHumanUserId: "user-1",
      delegatedPermissions: ["tasks:assign", "users:invite"],
      defaultAgentId: "agent-1",
    });
    mockSeatService.updateDelegatedPermissions.mockResolvedValue({
      id: seatId,
      companyId,
      slug: "ops-seat",
      name: "Operations Seat",
      title: "Operations",
      seatType: "manager",
      status: "active",
      operatingMode: "assisted",
      currentHumanUserId: "user-1",
      delegatedPermissions: ["tasks:assign"],
      defaultAgentId: "agent-1",
    });
  });

  it("attaches a human operator to a seat", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/seats/${seatId}/attach-human`)
      .send({ userId: "user-1" });

    expect(res.status).toBe(200);
    expect(mockSeatService.attachHuman).toHaveBeenCalledWith(companyId, seatId, "user-1");
    expect(res.body.operatingMode).toBe("assisted");
  });

  it("detaches a human operator and returns fallback count", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/seats/${seatId}/detach-human`)
      .send({ userId: "user-1" });

    expect(res.status).toBe(200);
    expect(mockSeatService.detachHuman).toHaveBeenCalledWith(companyId, seatId, "user-1");
    expect(res.body.fallbackReassignedIssueCount).toBe(2);
  });

  it("runs seat backfill for a company", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/seats/backfill`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockSeatService.backfillCompany).toHaveBeenCalledWith(companyId);
    expect(res.body.seatsCreated).toBe(3);
    expect(res.body.ownershipBackfills.issues).toBe(2);
  });

  it("reconciles seat operating modes for a company", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/seats/reconcile-modes`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockSeatService.reconcileModes).toHaveBeenCalledWith(companyId);
    expect(res.body.updatedSeatCount).toBe(2);
  });

  it("returns seat detail including delegated permissions", async () => {
    const app = createApp();
    const res = await request(app).get(`/api/companies/${companyId}/seats/${seatId}`);

    expect(res.status).toBe(200);
    expect(mockSeatService.getDetail).toHaveBeenCalledWith(companyId, seatId);
    expect(res.body.delegatedPermissions).toEqual(["tasks:assign", "users:invite"]);
  });

  it("updates delegated permissions for a seat", async () => {
    const app = createApp();
    const res = await request(app)
      .patch(`/api/companies/${companyId}/seats/${seatId}`)
      .send({ delegatedPermissions: ["tasks:assign"] });

    expect(res.status).toBe(200);
    expect(mockSeatService.updateDelegatedPermissions).toHaveBeenCalledWith(
      companyId,
      seatId,
      ["tasks:assign"],
    );
    expect(res.body.delegatedPermissions).toEqual(["tasks:assign"]);
  });
});
