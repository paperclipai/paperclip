import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { llmRoutes } from "../routes/llms.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockListServerAdapters = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../adapters/index.js", () => ({
  listServerAdapters: mockListServerAdapters,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", llmRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("llm routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListServerAdapters.mockReturnValue([
      { type: "codex_local", agentConfigurationDoc: "# codex_local agent configuration" },
    ]);
  });

  it("documents timer heartbeats as opt-in for new hires", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/llms/agent-configuration.txt");

    expect(res.status).toBe(200);
    expect(res.text).toContain("Timer heartbeats are opt-in for new hires.");
    expect(res.text).toContain("Leave runtimeConfig.heartbeat.enabled false");
  });
});
