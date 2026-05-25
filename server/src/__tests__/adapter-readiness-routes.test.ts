import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorHandler } from "../middleware/index.js";
import { adapterReadinessRoutes } from "../routes/adapter-readiness.js";
import { modelAssuranceRoutes } from "../routes/model-assurance.js";

const mockGetLatestReadiness = vi.hoisted(() => vi.fn());
const mockProbeReadiness = vi.hoisted(() => vi.fn());
const mockGetLatestModelAssurance = vi.hoisted(() => vi.fn());
const mockProbeModelAssurance = vi.hoisted(() => vi.fn());
const mockRefreshOnboardingSetup = vi.hoisted(() => vi.fn());

vi.mock("../services/adapter-readiness/index.js", () => ({
  adapterReadinessService: () => ({
    getLatestForAgent: mockGetLatestReadiness,
    probeAgent: mockProbeReadiness,
  }),
}));

vi.mock("../services/model-assurance/index.js", () => ({
  modelAssuranceService: () => ({
    getLatestForAgent: mockGetLatestModelAssurance,
    probeAgent: mockProbeModelAssurance,
  }),
}));

vi.mock("../services/onboarding-setup-state.js", () => ({
  onboardingSetupStateService: () => ({
    refreshFromEvidence: mockRefreshOnboardingSetup,
  }),
}));

function app(actor: Partial<Express.Request["actor"]> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "11111111-1111-4111-8111-111111111111",
      companyIds: ["company-1"],
      memberships: [],
      isInstanceAdmin: true,
      ...actor,
    } as typeof req.actor;
    next();
  });
  app.use("/api", adapterReadinessRoutes({} as never));
  app.use("/api", modelAssuranceRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("adapter readiness routes", () => {
  beforeEach(() => {
    mockGetLatestReadiness.mockReset();
    mockProbeReadiness.mockReset();
    mockGetLatestModelAssurance.mockReset();
    mockProbeModelAssurance.mockReset();
    mockRefreshOnboardingSetup.mockReset();
  });

  it("returns latest agent readiness", async () => {
    mockGetLatestReadiness.mockResolvedValue({ status: "ready" });

    const res = await request(app()).get("/api/companies/company-1/agents/agent-1/adapter-readiness");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready" });
    expect(mockGetLatestReadiness).toHaveBeenCalledWith("company-1", "agent-1");
  });

  it("probes agent readiness with validated adapter input and board user id", async () => {
    mockProbeReadiness.mockResolvedValue({ status: "warning" });
    mockRefreshOnboardingSetup.mockResolvedValue(null);

    const res = await request(app())
      .post("/api/companies/company-1/agents/agent-1/adapter-readiness/probe")
      .send({ adapterType: "codex_local", strictMode: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "warning" });
    expect(mockProbeReadiness).toHaveBeenCalledWith("company-1", "agent-1", {
      adapterType: "codex_local",
      strictMode: false,
      checkedByUserId: "11111111-1111-4111-8111-111111111111",
    });
    expect(mockRefreshOnboardingSetup).toHaveBeenCalledWith("company-1");
  });

  it("rejects legacy gemini_local adapter probes", async () => {
    const res = await request(app())
      .post("/api/companies/company-1/agents/agent-1/adapter-readiness/probe")
      .send({ adapterType: "gemini_local", strictMode: false });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Validation error" });
    expect(mockProbeReadiness).not.toHaveBeenCalled();
  });

  it("rejects same-company agent keys for adapter readiness probe mutations", async () => {
    const res = await request(app({
      type: "agent",
      companyId: "company-1",
      agentId: "agent-2",
      runId: null,
    } as Partial<Express.Request["actor"]>))
      .post("/api/companies/company-1/agents/agent-1/adapter-readiness/probe")
      .send({ adapterType: "codex_local", strictMode: false });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Board access required" });
    expect(mockProbeReadiness).not.toHaveBeenCalled();
  });

  it("rejects same-company agent keys for model assurance probe mutations", async () => {
    const res = await request(app({
      type: "agent",
      companyId: "company-1",
      agentId: "agent-2",
      runId: null,
    } as Partial<Express.Request["actor"]>))
      .post("/api/companies/company-1/agents/agent-1/model-assurance/probe")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Board access required" });
    expect(mockProbeModelAssurance).not.toHaveBeenCalled();
  });

  it("returns latest model assurance for an agent", async () => {
    mockGetLatestModelAssurance.mockResolvedValue({ policyStatus: "approved_primary" });

    const res = await request(app()).get("/api/companies/company-1/agents/agent-1/model-assurance");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ policyStatus: "approved_primary" });
    expect(mockGetLatestModelAssurance).toHaveBeenCalledWith("company-1", "agent-1");
  });
});
