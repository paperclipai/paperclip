import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAutonomyKernel = vi.hoisted(() => ({
  getAutonomyInbox: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  autonomyKernelService: () => mockAutonomyKernel,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  vi.resetModules();
  const [{ errorHandler }, { autonomyRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/autonomy.js") as Promise<typeof import("../routes/autonomy.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", autonomyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("autonomy routes", () => {
  beforeEach(() => {
    mockAutonomyKernel.getAutonomyInbox.mockReset();
  });

  it("lists the company-scoped autonomy inbox", async () => {
    mockAutonomyKernel.getAutonomyInbox.mockResolvedValue([
      {
        id: "approval-1",
        companyId: "company-1",
        kind: "approval_gate",
        severity: "warning",
        status: "pending",
        title: "Autonomy approval required",
        summary: "deploy_production requires approval.",
        laneKey: "deploy",
        runId: "run-1",
        issueId: "issue-1",
        agentId: "agent-1",
        incident: null,
        approvalGate: { id: "gate-1", approvalId: "approval-1" },
        evidenceEntry: null,
        createdAt: "2026-05-07T00:00:00.000Z",
        updatedAt: "2026-05-07T00:00:00.000Z",
      },
    ]);

    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/autonomy/inbox");

    expect(res.status).toBe(200);
    expect(mockAutonomyKernel.getAutonomyInbox).toHaveBeenCalledWith("company-1");
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ kind: "approval_gate", approvalGate: { approvalId: "approval-1" } });
  });

  it("rejects board users without access to the company", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-2",
      companyIds: ["other-company"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/companies/company-1/autonomy/inbox");

    expect(res.status).toBe(403);
    expect(mockAutonomyKernel.getAutonomyInbox).not.toHaveBeenCalled();
  });

  it("rejects agent keys because the autonomy inbox is an operator surface", async () => {
    const app = await createApp({
      type: "agent",
      companyId: "company-1",
      agentId: "agent-1",
      runId: null,
    });

    const res = await request(app).get("/api/companies/company-1/autonomy/inbox");

    expect(res.status).toBe(403);
    expect(mockAutonomyKernel.getAutonomyInbox).not.toHaveBeenCalled();
  });
});
