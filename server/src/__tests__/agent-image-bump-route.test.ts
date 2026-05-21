// BLO-4141: tests for POST /api/admin/agents/bump-agent-image.
// Mocks the service module so the route layer (auth gate + Zod validation +
// response shape) is exercised without an embedded postgres.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBumpAgentImagesForCompany = vi.hoisted(() => vi.fn());

vi.mock("../services/agent-image-bump.js", () => ({
  bumpAgentImagesForCompany: mockBumpAgentImagesForCompany,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["00000000-0000-0000-0000-000000000aaa"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  vi.resetModules();
  const [{ errorHandler }, { agentImageBumpRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/agent-image-bump.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor?: unknown }).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentImageBumpRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe.sequential("POST /api/admin/agents/bump-agent-image", () => {
  beforeEach(() => {
    mockBumpAgentImagesForCompany.mockReset();
  });

  it("rejects with 403 when the actor is not a board token", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyIds: ["00000000-0000-0000-0000-000000000aaa"],
      source: "session",
    });

    const res = await request(app)
      .post("/api/admin/agents/bump-agent-image")
      .send({
        companyId: "00000000-0000-0000-0000-000000000aaa",
        image: "harbor.example/agent:sha-abc-k8s-vendored",
      });

    expect(res.status).toBe(403);
    expect(mockBumpAgentImagesForCompany).not.toHaveBeenCalled();
  });

  it("returns 422 when image is missing from the body", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/admin/agents/bump-agent-image")
      .send({ companyId: "00000000-0000-0000-0000-000000000aaa" });

    expect(res.status).toBe(400);
    expect(mockBumpAgentImagesForCompany).not.toHaveBeenCalled();
  });

  it("returns 422 when companyId is not a valid UUID", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/admin/agents/bump-agent-image")
      .send({
        companyId: "not-a-uuid",
        image: "harbor.example/agent:sha-abc-k8s-vendored",
      });

    expect(res.status).toBe(400);
  });

  it("returns 200 with the service summary on success", async () => {
    mockBumpAgentImagesForCompany.mockResolvedValue({
      bumped: ["agent-idle-1", "agent-idle-2"],
      skipped: ["agent-busy-1"],
      unchanged: ["agent-already-on-target-1"],
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/admin/agents/bump-agent-image")
      .send({
        companyId: "00000000-0000-0000-0000-000000000aaa",
        image: "harbor.example/agent:sha-abc-k8s-vendored",
        source: "ci:docker-agent.yml",
        buildSha: "abc1234",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      bumped: ["agent-idle-1", "agent-idle-2"],
      skipped: ["agent-busy-1"],
      unchanged: ["agent-already-on-target-1"],
    });
    expect(mockBumpAgentImagesForCompany).toHaveBeenCalledTimes(1);
    const callArgs = mockBumpAgentImagesForCompany.mock.calls[0]![1];
    expect(callArgs).toMatchObject({
      companyId: "00000000-0000-0000-0000-000000000aaa",
      targetImage: "harbor.example/agent:sha-abc-k8s-vendored",
      source: "ci:docker-agent.yml@abc1234",
    });
  });

  it("defaults source to 'admin:manual' when omitted", async () => {
    mockBumpAgentImagesForCompany.mockResolvedValue({
      bumped: [],
      skipped: [],
      unchanged: [],
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/admin/agents/bump-agent-image")
      .send({
        companyId: "00000000-0000-0000-0000-000000000aaa",
        image: "harbor.example/agent:sha-abc-k8s-vendored",
      });

    expect(res.status).toBe(200);
    expect(mockBumpAgentImagesForCompany.mock.calls[0]![1]).toMatchObject({
      source: "admin:manual",
    });
  });
});
