import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { departmentRoutes } from "../routes/departments.js";
import { HttpError } from "../errors.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const departmentId = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  setForAgent: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => ({ decide: mocks.decide }),
}));

vi.mock("../services/departments.js", () => ({
  departmentService: () => ({ setForAgent: mocks.setForAgent }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));

vi.mock("../services/authorization.js", () => ({
  authorizationDeniedDetails: (decision: { reason?: string; code?: string }) => ({
    reason: decision.reason,
    ...(decision.code ? { code: decision.code } : {}),
  }),
  authorizationService: () => ({ decideMany: () => Promise.resolve([]) }),
  responsibleUserAuthzShadowMode: () => false,
}));

vi.mock("@paperclipai/db", () => ({
  agents: { id: { name: "id" }, companyId: { name: "companyId" } },
  departments: { id: { name: "id" }, companyId: { name: "companyId" } },
}));

vi.mock("@paperclipai/shared", async () => {
  const { z } = await import("zod");
  const departmentIds = z.object({
    departmentIds: z.array(z.string().uuid()).max(20),
  }).strict();
  const name = z.object({ name: z.string().min(1).max(200) }).strict();
  return {
    setAgentDepartmentsSchema: departmentIds,
    createDepartmentSchema: name,
    updateDepartmentSchema: name,
  };
});

function app(actor: express.Request["actor"]) {
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ id: agentId, companyId }]),
      }),
    }),
  };
  const api = express();
  api.use(express.json());
  api.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  api.use(departmentRoutes(db as never));
  api.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : "error" });
  });
  return api;
}

const operator: express.Request["actor"] = {
  type: "board",
  userId: "operator-user",
  source: "session",
  isInstanceAdmin: false,
  companyIds: [companyId],
  memberships: [{ companyId, status: "active", membershipRole: "operator" }],
};

describe("PUT /agents/:id/departments", () => {
  beforeEach(() => {
    mocks.decide.mockReset();
    mocks.setForAgent.mockReset();
    mocks.logActivity.mockReset();
  });

  it("rejects a board operator without agent_config:update", async () => {
    mocks.decide.mockResolvedValue({
      allowed: false,
      reason: "deny_no_grant",
      explanation: "Missing permission: agents:configure or agents:suggest-changes.",
    });

    const res = await request(app(operator))
      .put(`/agents/${agentId}/departments`)
      .send({ departmentIds: [departmentId] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: agents:configure or agents:suggest-changes.");
    expect(mocks.decide).toHaveBeenCalledWith({
      actor: operator,
      action: "agent_config:update",
      resource: { type: "agent", companyId, agentId },
    });
    expect(mocks.setForAgent).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });
});
