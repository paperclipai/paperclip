import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seatRoutes } from "../routes/seats.js";
import { errorHandler } from "../middleware/index.js";

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  listActiveUserMemberships: vi.fn(),
}));

const companyId = "22222222-2222-4222-8222-222222222222";
const seatId = "33333333-3333-4333-8333-333333333333";

const mockSeatService = vi.hoisted(() => ({
  listForCompany: vi.fn(),
  getDetail: vi.fn(),
  updateDelegatedPermissions: vi.fn(),
  pauseSeat: vi.fn(),
  resumeSeat: vi.fn(),
  attachHuman: vi.fn(),
  detachHuman: vi.fn(),
  attachShadowAgent: vi.fn(),
  detachShadowAgent: vi.fn(),
  backfillCompany: vi.fn(),
  reconcileModes: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  seatService: () => mockSeatService,
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
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
      previousOperatingMode: "assisted",
      operatingMode: "assisted",
      currentHumanUserId: "user-1",
      fallbackReassignedIssueCount: 0,
    });
    mockSeatService.detachHuman.mockResolvedValue({
      companyId,
      seatId,
      previousOperatingMode: "assisted",
      operatingMode: "vacant",
      currentHumanUserId: null,
      fallbackReassignedIssueCount: 2,
    });
    mockSeatService.attachShadowAgent.mockResolvedValue({
      companyId,
      seatId,
      previousOperatingMode: "assisted",
      operatingMode: "shadowed",
      currentHumanUserId: "user-1",
      fallbackReassignedIssueCount: 0,
    });
    mockSeatService.detachShadowAgent.mockResolvedValue({
      companyId,
      seatId,
      previousOperatingMode: "shadowed",
      operatingMode: "assisted",
      currentHumanUserId: "user-1",
      fallbackReassignedIssueCount: 0,
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
    mockSeatService.listForCompany.mockResolvedValue([
      {
        id: seatId,
        companyId,
        slug: "ops-seat",
        name: "Operations Seat",
        title: "Operations",
        seatType: "manager",
        status: "active",
        pauseReason: null,
        pauseReasons: [],
        operatingMode: "assisted",
        currentHumanUserId: "user-1",
        delegatedPermissions: ["tasks:assign", "users:invite"],
        defaultAgentId: "agent-1",
      },
    ]);
    mockSeatService.getDetail.mockResolvedValue({
      id: seatId,
      companyId,
      slug: "ops-seat",
      name: "Operations Seat",
      title: "Operations",
      seatType: "manager",
      status: "active",
      pauseReason: null,
      pauseReasons: [],
      operatingMode: "assisted",
      currentHumanUserId: "user-1",
      delegatedPermissions: ["tasks:assign", "users:invite"],
      defaultAgentId: "agent-1",
    });
    mockSeatService.updateDelegatedPermissions.mockResolvedValue({
      seat: {
        id: seatId,
        companyId,
        slug: "ops-seat",
        name: "Operations Seat",
        title: "Operations",
        seatType: "manager",
        status: "active",
        pauseReason: null,
        pauseReasons: [],
        operatingMode: "assisted",
        currentHumanUserId: "user-1",
        delegatedPermissions: ["tasks:assign"],
        defaultAgentId: "agent-1",
      },
      previousDelegatedPermissions: ["tasks:assign", "users:invite"],
    });
    mockSeatService.pauseSeat.mockResolvedValue({
      id: seatId,
      companyId,
      slug: "ops-seat",
      name: "Operations Seat",
      title: "Operations",
      seatType: "manager",
      status: "paused",
      pauseReason: "maintenance",
      pauseReasons: ["maintenance"],
      operatingMode: "assisted",
      currentHumanUserId: "user-1",
      delegatedPermissions: ["tasks:assign"],
      defaultAgentId: "agent-1",
    });
    mockSeatService.resumeSeat.mockResolvedValue({
      id: seatId,
      companyId,
      slug: "ops-seat",
      name: "Operations Seat",
      title: "Operations",
      seatType: "manager",
      status: "active",
      pauseReason: null,
      pauseReasons: [],
      operatingMode: "assisted",
      currentHumanUserId: "user-1",
      delegatedPermissions: ["tasks:assign"],
      defaultAgentId: "agent-1",
    });
    mockAccessService.listActiveUserMemberships.mockResolvedValue([
      {
        id: "membership-1",
        companyId,
        principalType: "user",
        principalId: "user-1",
        membershipRole: "member",
        status: "active",
      },
    ]);
  });

  it("attaches a human operator to a seat", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/seats/${seatId}/attach-human`)
      .send({ userId: "user-1" });

    expect(res.status).toBe(200);
    expect(mockSeatService.attachHuman).toHaveBeenCalledWith(companyId, seatId, "user-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "seat.human_attached",
        entityId: seatId,
        details: expect.objectContaining({
          userId: "user-1",
          previousOperatingMode: "assisted",
          operatingMode: "assisted",
        }),
      }),
    );
    expect(res.body.operatingMode).toBe("assisted");
  });

  it("detaches a human operator and returns fallback count", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/seats/${seatId}/detach-human`)
      .send({ userId: "user-1" });

    expect(res.status).toBe(200);
    expect(mockSeatService.detachHuman).toHaveBeenCalledWith(companyId, seatId, "user-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "seat.human_detached",
        entityId: seatId,
        details: expect.objectContaining({
          userId: "user-1",
          previousOperatingMode: "assisted",
          operatingMode: "vacant",
          fallbackReassignedIssueCount: 2,
        }),
      }),
    );
    expect(res.body.fallbackReassignedIssueCount).toBe(2);
  });

  it("attaches a shadow agent to a seat", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/seats/${seatId}/attach-shadow-agent`)
      .send({ agentId: "44444444-4444-4444-8444-444444444444" });

    expect(res.status).toBe(200);
    expect(mockSeatService.attachShadowAgent).toHaveBeenCalledWith(
      companyId,
      seatId,
      "44444444-4444-4444-8444-444444444444",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "seat.shadow_agent_attached",
        entityId: seatId,
        details: expect.objectContaining({
          shadowAgentId: "44444444-4444-4444-8444-444444444444",
          previousOperatingMode: "assisted",
          operatingMode: "shadowed",
        }),
      }),
    );
    expect(res.body.operatingMode).toBe("shadowed");
  });

  it("detaches a shadow agent from a seat", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/seats/${seatId}/detach-shadow-agent`)
      .send({ agentId: "44444444-4444-4444-8444-444444444444" });

    expect(res.status).toBe(200);
    expect(mockSeatService.detachShadowAgent).toHaveBeenCalledWith(
      companyId,
      seatId,
      "44444444-4444-4444-8444-444444444444",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "seat.shadow_agent_detached",
        entityId: seatId,
        details: expect.objectContaining({
          shadowAgentId: "44444444-4444-4444-8444-444444444444",
          previousOperatingMode: "shadowed",
          operatingMode: "assisted",
        }),
      }),
    );
    expect(res.body.operatingMode).toBe("assisted");
  });

  it("runs seat backfill for a company", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/seats/backfill`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockSeatService.backfillCompany).toHaveBeenCalledWith(companyId);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "seat.backfill_executed",
        entityId: companyId,
        details: expect.objectContaining({
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
          warningCount: 0,
          warningCodes: [],
        }),
      }),
    );
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
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "seat.modes_reconciled",
        entityId: companyId,
      }),
    );
    expect(res.body.updatedSeatCount).toBe(2);
  });

  it("returns seat detail including delegated permissions", async () => {
    const app = createApp();
    const res = await request(app).get(`/api/companies/${companyId}/seats/${seatId}`);

    expect(res.status).toBe(200);
    expect(mockSeatService.getDetail).toHaveBeenCalledWith(companyId, seatId);
    expect(res.body.delegatedPermissions).toEqual(["tasks:assign", "users:invite"]);
  });

  it("lists attachable company members for seat assignment without permission-management reads", async () => {
    const app = createApp();
    const res = await request(app).get(`/api/companies/${companyId}/seats/attachable-members`);

    expect(res.status).toBe(200);
    expect(mockAccessService.listActiveUserMemberships).toHaveBeenCalledWith(companyId);
    expect(res.body).toEqual([
      expect.objectContaining({
        principalId: "user-1",
        status: "active",
      }),
    ]);
  });

  it("lists seats for a company", async () => {
    const app = createApp();
    const res = await request(app).get(`/api/companies/${companyId}/seats`);

    expect(res.status).toBe(200);
    expect(mockSeatService.listForCompany).toHaveBeenCalledWith(companyId);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].slug).toBe("ops-seat");
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
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "seat.delegated_permissions_updated",
        entityId: seatId,
        details: expect.objectContaining({
          previousDelegatedPermissions: ["tasks:assign", "users:invite"],
          delegatedPermissions: ["tasks:assign"],
          addedPermissions: [],
          removedPermissions: ["users:invite"],
        }),
      }),
    );
    expect(res.body.delegatedPermissions).toEqual(["tasks:assign"]);
  });

  it("pauses a seat with an operator-managed reason", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/seats/${seatId}/pause`)
      .send({ pauseReason: "maintenance" });

    expect(res.status).toBe(200);
    expect(mockSeatService.pauseSeat).toHaveBeenCalledWith(companyId, seatId, "maintenance");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "seat.paused",
        entityId: seatId,
      }),
    );
    expect(res.body.pauseReason).toBe("maintenance");
  });

  it("resumes operator-managed seat pauses", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/seats/${seatId}/resume`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockSeatService.resumeSeat).toHaveBeenCalledWith(companyId, seatId, null);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "seat.resumed",
        entityId: seatId,
      }),
    );
    expect(res.body.status).toBe("active");
  });
});
