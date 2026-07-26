import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { intakeReceiverScopeGuard } from "../middleware/intake-receiver-scope.js";

function createApp() {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const assigneeAgentId = randomUUID();
  const keyId = randomUUID();
  const downstream = vi.fn((_req, res) => res.status(201).json({ ok: true }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "agent",
      source: "agent_key",
      agentId: randomUUID(),
      companyId,
      keyId,
      keyScope: {
        kind: "intake_receiver",
        projectId,
        assigneeAgentId,
        priority: "medium",
      },
    };
    next();
  });
  app.use(intakeReceiverScopeGuard());
  app.use(downstream);
  return { app, assigneeAgentId, companyId, downstream, keyId, projectId };
}

function validIssue(projectId: string, assigneeAgentId: string) {
  return {
    title: "[Uptime] STAGING api-health failing",
    description: "Sanitized uptime transition",
    status: "todo",
    priority: "medium",
    projectId,
    assigneeAgentId,
    idempotencyKey: "uptime-failure-intake:018f6f4e-7f2d-7cc3-9e64-5f7b0f8c1001",
  };
}

describe("intake receiver scope guard", () => {
  it("allows only a fixed sanitized create and body-only comment through", async () => {
    const { app, assigneeAgentId, companyId, downstream, projectId } = createApp();

    const create = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(validIssue(projectId, assigneeAgentId));
    const comments = await request(app)
      .get(`/api/issues/${randomUUID()}/comments`);
    const comment = await request(app)
      .post(`/api/issues/${randomUUID()}/comments`)
      .send({ body: "Sanitized recovery transition" });

    expect(create.status).toBe(201);
    expect(comments.status).toBe(201);
    expect(comment.status).toBe(201);
    expect(downstream).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["cross-project create", ({ companyId, assigneeAgentId }: ReturnType<typeof createApp>) => ({
      method: "post",
      path: `/api/companies/${companyId}/issues`,
      body: validIssue(randomUUID(), assigneeAgentId),
    })],
    ["assignee override", ({ companyId, projectId }: ReturnType<typeof createApp>) => ({
      method: "post",
      path: `/api/companies/${companyId}/issues`,
      body: validIssue(projectId, randomUUID()),
    })],
    ["priority override", ({ companyId, projectId, assigneeAgentId }: ReturnType<typeof createApp>) => ({
      method: "post",
      path: `/api/companies/${companyId}/issues`,
      body: { ...validIssue(projectId, assigneeAgentId), priority: "high" },
    })],
    ["scope mutation field", ({ companyId, projectId, assigneeAgentId }: ReturnType<typeof createApp>) => ({
      method: "post",
      path: `/api/companies/${companyId}/issues`,
      body: { ...validIssue(projectId, assigneeAgentId), workMode: "planning" },
    })],
    ["comment status mutation", () => ({
      method: "post",
      path: `/api/issues/${randomUUID()}/comments`,
      body: { body: "Recovery", resume: true },
    })],
    ["issue read", () => ({ method: "get", path: `/api/issues/${randomUUID()}` })],
    ["issue list", ({ companyId }: ReturnType<typeof createApp>) => ({ method: "get", path: `/api/companies/${companyId}/issues` })],
    ["issue mutation", () => ({ method: "patch", path: `/api/issues/${randomUUID()}`, body: { status: "done" } })],
    ["agent operation", () => ({ method: "get", path: "/api/agents/me" })],
    ["key operation", () => ({ method: "post", path: `/api/agents/${randomUUID()}/keys`, body: { name: "escape" } })],
    ["company operation", ({ companyId }: ReturnType<typeof createApp>) => ({ method: "get", path: `/api/companies/${companyId}` })],
  ])("denies %s before downstream mutation", async (_name, makeRequest) => {
    const fixture = createApp();
    const attempt = makeRequest(fixture);
    const response = await (request(fixture.app) as any)[attempt.method](attempt.path).send(attempt.body);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "intake_receiver_scope_denied" });
    expect(fixture.downstream).not.toHaveBeenCalled();
  });
});
