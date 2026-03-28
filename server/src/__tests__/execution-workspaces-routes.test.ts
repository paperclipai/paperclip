import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { errorHandler } from "../middleware/index.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  logActivity: vi.fn(async () => undefined),
  workspaceOperationService: () => ({
    create: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  }),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("execution workspace route query parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutionWorkspaceService.list.mockResolvedValue([]);
  });

  it("normalizes duplicate status query params to a safe first string", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_ID}/execution-workspaces?status=active&status=idle`,
    );

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.list).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        status: "active",
      }),
    );
  });
});

