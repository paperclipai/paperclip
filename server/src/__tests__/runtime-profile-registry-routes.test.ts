import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { createRuntimeProfileRegistry } from "../services/runtime-profile-registry.js";

vi.mock("../services/index.js", () => ({
  agentService: () => ({
    resolveByReference: vi.fn(),
  }),
  agentInstructionsService: () => ({}),
  accessService: () => ({}),
  approvalService: () => ({}),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
    resolveAdapterConfigForRuntime: vi.fn(),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any, { runtimeProfiles: createRuntimeProfileRegistry() }));
  app.use(errorHandler);
  return app;
}

describe("runtime profile registry routes", () => {
  it("lists built-in runtime profiles with the expected shape", async () => {
    const res = await request(createApp()).get("/api/runtime-profiles");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const item of res.body as Array<Record<string, unknown>>) {
      expect(typeof item.id).toBe("string");
      expect((item.id as string).length).toBeGreaterThan(0);
      expect(typeof item.label).toBe("string");
      expect((item.label as string).length).toBeGreaterThan(0);
      expect(typeof item.framework).toBe("string");
      expect((item.framework as string).length).toBeGreaterThan(0);
      if (item.defaultHeaderValue !== undefined) {
        expect(typeof item.defaultHeaderValue).toBe("string");
      }
      if (item.description !== undefined) {
        expect(typeof item.description).toBe("string");
      }
    }
    expect(
      (res.body as Array<{ id: string }>).some((item) => item.id === "http+crewai"),
    ).toBe(true);
  });

  it("registers runtime profiles via API", async () => {
    const app = createApp();
    const postRes = await request(app)
      .post("/api/runtime-profiles")
      .send({
        id: "http+swarm",
        label: "HTTP + Swarm",
        framework: "Swarm",
        defaultHeaderValue: "Swarm",
      });
    expect(postRes.status).toBe(201);

    const listRes = await request(app).get("/api/runtime-profiles");
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((item: { id: string }) => item.id === "http+swarm")).toBe(true);
  });
});
