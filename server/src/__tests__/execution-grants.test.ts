import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog, agentConfigRevisions, agents, approvals, companies, companyMemberships, companySecrets, createDb,
  executionGrantPolicies, executionGrants, heartbeatRuns, issueApprovals,
  issueThreadInteractions, issues, principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { executionGrantApprovalDetails, executionGrantRequestHash } from "../services/execution-grant-contract.js";
import { issueExecutionGrant, withConsumedExecutionGrant } from "../services/execution-grants.js";
import { executionGrantRoutes } from "../routes/execution-grants.js";
import { agentRoutes } from "../routes/agents.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("execution grants", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-grants-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(executionGrants);
    await db.delete(executionGrantPolicies);
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentConfigRevisions);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const proposerAgentId = randomUUID();
    const stewardAgentId = randomUUID();
    const executorAgentId = randomUUID();
    const targetAgentId = randomUUID();
    const sourceRunId = randomUUID();
    const executorRunId = randomUUID();
    const decisionId = randomUUID();
    const body = { name: "Chief of staff approved name" };
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await db.insert(companies).values({
      id: companyId, name: "Household", issuePrefix: "JOH", defaultResponsibleUserId: "board-user",
    });
    for (const [id, name] of [
      [proposerAgentId, "Proposer"], [stewardAgentId, "Decision Steward"],
      [executorAgentId, "Executor"], [targetAgentId, "Chief of staff"],
    ]) {
      await db.insert(agents).values({
        id, companyId, name, role: "general", adapterType: "codex_local",
        adapterConfig: {}, runtimeConfig: {}, permissions: {},
      });
    }
    const targetUpdatedAt = (await db.select({ updatedAt: agents.updatedAt }).from(agents)
      .where(eq(agents.id, targetAgentId)))[0].updatedAt.toISOString();
    const requestHash = executionGrantRequestHash("PATCH", `/api/agents/${targetAgentId}`,
      body, targetUpdatedAt);
    await db.insert(companyMemberships).values({
      companyId, principalType: "agent", principalId: executorAgentId,
    });
    await db.insert(principalPermissionGrants).values({
      companyId, principalType: "agent", principalId: executorAgentId,
      permissionKey: "agents:suggest-changes",
    });
    await db.insert(executionGrantPolicies).values({
      companyId, stewardAgentId, version: 1, updatedByUserId: "board-user",
    });
    await db.insert(heartbeatRuns).values([
      { id: sourceRunId, companyId, agentId: proposerAgentId, status: "succeeded" },
      { id: executorRunId, companyId, agentId: executorAgentId, status: "running" },
    ]);
    await db.insert(issues).values({
      id: issueId, companyId, title: "Chief config proposal", status: "in_review",
      priority: "medium", identifier: "JOH-1", issueNumber: 1, createdByAgentId: proposerAgentId,
    });
    const executionGrant = {
      version: 1 as const, executorAgentId, targetAgentId,
      operation: "agent_config:update" as const, targetRevisionId: null,
      targetUpdatedAt, requestBody: body, requestHash, expiresAt, policyVersion: 1,
    };
    const payload = {
      version: 1 as const,
      prompt: "Approve this exact Chief config change?",
      detailsMarkdown: executionGrantApprovalDetails(executionGrant),
      executionGrant,
    };
    await db.insert(issueThreadInteractions).values({
      id: decisionId, companyId, issueId, kind: "request_confirmation", status: "accepted",
      createdByAgentId: proposerAgentId, addresseeAgentId: stewardAgentId,
      resolvedByAgentId: stewardAgentId, sourceRunId,
      payload, result: { version: 1, outcome: "accepted" },
    });
    return {
      companyId, issueId, proposerAgentId, stewardAgentId, executorAgentId,
      targetAgentId, sourceRunId, executorRunId, decisionId, requestHash, body, payload,
    };
  }

  function attempt(fixture: Awaited<ReturnType<typeof seed>>, overrides: Record<string, unknown> = {}) {
    return {
      db, grantId: "", runId: fixture.executorRunId,
      attempt: {
        companyId: fixture.companyId, executorAgentId: fixture.executorAgentId,
        targetAgentId: fixture.targetAgentId, operation: "agent_config:update" as const,
        requestHash: fixture.requestHash, ...overrides,
      },
      apply: async (txDb: typeof db) => {
        await txDb.update(agents).set({ name: fixture.body.name }).where(eq(agents.id, fixture.targetAgentId));
        return true;
      },
    };
  }

  function appAs(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", executionGrantRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use((err: { status?: number; message: string; details?: unknown }, _req: express.Request,
      res: express.Response, _next: express.NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message, details: err.details });
    });
    return app;
  }

  it("applies a steward-approved Chief config change once and rejects replay, changed request and executor", async () => {
    const fixture = await seed();
    const grant = await issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId,
      executorAgentId: fixture.executorAgentId,
    });
    expect(grant).toBeTruthy();
    const input = { ...attempt(fixture), grantId: grant!.id };
    await expect(withConsumedExecutionGrant({ ...input, attempt: { ...input.attempt, requestHash: "changed" } }))
      .rejects.toMatchObject({ status: 403, details: { code: "execution_grant_request_changed" } });
    await expect(withConsumedExecutionGrant({ ...input, attempt: { ...input.attempt, executorAgentId: randomUUID() } }))
      .rejects.toMatchObject({ status: 403, details: { code: "execution_grant_unauthorized_executor" } });
    await expect(withConsumedExecutionGrant(input)).resolves.toBe(true);
    expect((await db.select().from(agents).where(eq(agents.id, fixture.targetAgentId)))[0].name)
      .toBe(fixture.body.name);
    await expect(withConsumedExecutionGrant(input))
      .rejects.toMatchObject({ status: 403, details: { code: "execution_grant_already_consumed" } });
  });

  it("rejects self approval and any grant targeting the Steward", async () => {
    const fixture = await seed();
    await db.update(issueThreadInteractions).set({
      addresseeAgentId: fixture.proposerAgentId, resolvedByAgentId: fixture.proposerAgentId,
    }).where(eq(issueThreadInteractions.id, fixture.decisionId));
    await expect(issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId, executorAgentId: fixture.executorAgentId,
    })).rejects.toMatchObject({ status: 403 });
    await db.update(issueThreadInteractions).set({
      addresseeAgentId: fixture.stewardAgentId, resolvedByAgentId: fixture.stewardAgentId,
      payload: { ...fixture.payload, executionGrant: { ...fixture.payload.executionGrant, targetAgentId: fixture.stewardAgentId } },
    }).where(eq(issueThreadInteractions.id, fixture.decisionId));
    await expect(issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId, executorAgentId: fixture.executorAgentId,
    })).rejects.toMatchObject({ status: 403 });
  });

  it("rejects proposer execution after either a Steward or board decision", async () => {
    const fixture = await seed();
    const executionGrant = { ...fixture.payload.executionGrant,
      executorAgentId: fixture.proposerAgentId };
    const payload = { ...fixture.payload, executionGrant,
      detailsMarkdown: executionGrantApprovalDetails(executionGrant) };
    await db.update(issueThreadInteractions).set({ payload })
      .where(eq(issueThreadInteractions.id, fixture.decisionId));
    await expect(issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId,
      executorAgentId: fixture.proposerAgentId,
    })).rejects.toMatchObject({ status: 403, details: { code: "execution_grant_invalid_decision" } });

    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId: fixture.companyId, type: "request_board_approval",
      requestedByAgentId: fixture.proposerAgentId, status: "approved",
      decidedByUserId: "board-user", decidedAt: new Date(),
      payload: { executionGrant, detailsMarkdown: payload.detailsMarkdown },
    });
    await db.insert(issueApprovals).values({
      companyId: fixture.companyId, issueId: fixture.issueId, approvalId,
    });
    await expect(issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "board", decisionId: approvalId,
      executorAgentId: fixture.proposerAgentId,
    })).rejects.toMatchObject({ status: 403, details: { code: "execution_grant_invalid_decision" } });
  });

  it("rejects an approval display that describes a different request", async () => {
    const fixture = await seed();
    await db.update(issueThreadInteractions).set({
      payload: { ...fixture.payload, detailsMarkdown: `\`\`\`diff\n+ a harmless change\n\`\`\`\nRequest SHA-256: ${fixture.requestHash}` },
    }).where(eq(issueThreadInteractions.id, fixture.decisionId));
    await expect(issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId,
      executorAgentId: fixture.executorAgentId,
    })).rejects.toMatchObject({ status: 403, details: { code: "execution_grant_invalid_decision" } });
  });

  it("rejects a stale revision, expired grant, and changed policy version", async () => {
    const fixture = await seed();
    const grant = await issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId, executorAgentId: fixture.executorAgentId,
    });
    const input = { ...attempt(fixture), grantId: grant!.id };
    await db.insert(agentConfigRevisions).values({
      companyId: fixture.companyId, agentId: fixture.targetAgentId,
      beforeConfig: {}, afterConfig: { name: "changed" },
    });
    await expect(withConsumedExecutionGrant(input))
      .rejects.toMatchObject({ status: 403, details: { code: "execution_grant_stale_target" } });
    await db.delete(agentConfigRevisions);
    await db.update(executionGrants).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(executionGrants.id, grant!.id));
    await expect(withConsumedExecutionGrant(input))
      .rejects.toMatchObject({ status: 403, details: { code: "execution_grant_expired" } });
    await db.update(executionGrants).set({ expiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(executionGrants.id, grant!.id));
    await db.update(executionGrantPolicies).set({ version: 2 })
      .where(eq(executionGrantPolicies.companyId, fixture.companyId));
    await expect(withConsumedExecutionGrant(input))
      .rejects.toMatchObject({ status: 403, details: { code: "execution_grant_policy_version_changed" } });
  });

  it("materializes a board decision into the same grant type", async () => {
    const fixture = await seed();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId: fixture.companyId, type: "request_board_approval",
      requestedByAgentId: fixture.proposerAgentId, status: "approved",
      decidedByUserId: "board-user", decidedAt: new Date(),
      payload: { detailsMarkdown: fixture.payload.detailsMarkdown, executionGrant: fixture.payload.executionGrant },
    });
    await db.insert(issueApprovals).values({ companyId: fixture.companyId, issueId: fixture.issueId, approvalId });
    const grant = await issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "board", decisionId: approvalId, executorAgentId: fixture.executorAgentId,
    });
    expect(grant).toMatchObject({ decisionKind: "board", approverUserId: "board-user" });
  });

  it("rolls back consumption when the protected write fails", async () => {
    const fixture = await seed();
    const grant = await issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId,
      executorAgentId: fixture.executorAgentId,
    });
    const input = { ...attempt(fixture), grantId: grant!.id };
    await expect(withConsumedExecutionGrant({
      ...input,
      apply: async () => { throw new Error("write failed"); },
    })).rejects.toThrow("write failed");
    expect((await db.select().from(executionGrants).where(eq(executionGrants.id, grant!.id)))[0].consumedAt)
      .toBeNull();
    await expect(withConsumedExecutionGrant(input)).resolves.toBe(true);
  });

  it("requires a board actor to appoint the Steward and a named executor run to issue", async () => {
    const fixture = await seed();
    const agentActor: Express.Request["actor"] = {
      type: "agent", companyId: fixture.companyId, agentId: fixture.executorAgentId,
      runId: fixture.executorRunId, source: "agent_jwt",
    };
    await request(appAs(agentActor))
      .put(`/api/companies/${fixture.companyId}/execution-grant-policy`)
      .send({ stewardAgentId: fixture.executorAgentId })
      .expect(403);
    const boardActor: Express.Request["actor"] = {
      type: "board", source: "local_implicit", userId: "board-user",
    };
    const policyResponse = await request(appAs(boardActor))
      .put(`/api/companies/${fixture.companyId}/execution-grant-policy`)
      .send({ stewardAgentId: fixture.stewardAgentId })
      .expect(200);
    expect(policyResponse.body.version).toBe(2);
    await db.update(executionGrantPolicies).set({ version: 1 })
      .where(eq(executionGrantPolicies.companyId, fixture.companyId));

    const issued = await request(appAs(agentActor))
      .post(`/api/issues/${fixture.issueId}/execution-grants`)
      .send({ decisionKind: "agent", decisionId: fixture.decisionId })
      .expect(201);
    expect(issued.body).toMatchObject({
      decisionId: fixture.decisionId, executorAgentId: fixture.executorAgentId,
      targetAgentId: fixture.targetAgentId,
    });
    await request(appAs(agentActor))
      .post(`/api/issues/${fixture.issueId}/execution-grants`)
      .send({ decisionKind: "agent", decisionId: fixture.decisionId })
      .expect(200);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "execution_grant.issued")))
      .toHaveLength(1);
    await request(appAs({ ...agentActor, agentId: fixture.proposerAgentId }))
      .post(`/api/issues/${fixture.issueId}/execution-grants`)
      .send({ decisionKind: "agent", decisionId: fixture.decisionId })
      .expect(403);
  });

  it("applies the approved PATCH once through the agent API", async () => {
    const fixture = await seed();
    const actor: Express.Request["actor"] = {
      type: "agent", companyId: fixture.companyId, agentId: fixture.executorAgentId,
      runId: fixture.executorRunId, source: "agent_jwt",
    };
    const grant = await issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId,
      executorAgentId: fixture.executorAgentId,
    });
    const path = `/api/agents/${fixture.targetAgentId}`;
    const app = appAs(actor);
    await request(app).patch(path)
      .set("X-Paperclip-Execution-Grant", grant!.id)
      .send({ name: "unapproved change" }).expect(403);
    const approvedResponse = await request(app).patch(path)
      .set("X-Paperclip-Execution-Grant", grant!.id)
      .send(fixture.body);
    expect(approvedResponse.status, JSON.stringify(approvedResponse.body)).toBe(200);
    await request(app).patch(path)
      .set("X-Paperclip-Execution-Grant", grant!.id)
      .send(fixture.body).expect(403);
    await request(app)
      .post(`/api/issues/${fixture.issueId}/execution-grants`)
      .send({ decisionKind: "agent", decisionId: fixture.decisionId })
      .expect(409);
    expect((await db.select().from(agents).where(eq(agents.id, fixture.targetAgentId)))[0].name)
      .toBe(fixture.body.name);
  });

  it("applies a safe adapter configuration change once through the agent API", async () => {
    const fixture = await seed();
    const body = { adapterConfig: { engine: "cli" } };
    const executionGrant = { ...fixture.payload.executionGrant, requestBody: body,
      requestHash: executionGrantRequestHash("PATCH", `/api/agents/${fixture.targetAgentId}`,
        body, fixture.payload.executionGrant.targetUpdatedAt),
    };
    await db.update(issueThreadInteractions).set({ payload: {
      ...fixture.payload, executionGrant,
      detailsMarkdown: executionGrantApprovalDetails(executionGrant),
    } }).where(eq(issueThreadInteractions.id, fixture.decisionId));
    const grant = await issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId,
      executorAgentId: fixture.executorAgentId,
    });
    const actor: Express.Request["actor"] = {
      type: "agent", companyId: fixture.companyId, agentId: fixture.executorAgentId,
      runId: fixture.executorRunId, source: "agent_jwt",
    };
    const app = appAs(actor);
    const path = `/api/agents/${fixture.targetAgentId}`;
    const response = await request(app).patch(path)
      .set("X-Paperclip-Execution-Grant", grant!.id).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await db.select().from(agents).where(eq(agents.id, fixture.targetAgentId)))[0]
      .adapterConfig).toMatchObject({ engine: "cli" });
    await request(app).patch(path)
      .set("X-Paperclip-Execution-Grant", grant!.id).send(body).expect(403);
  });

  it("rejects issuance and consumption after the executor run completes", async () => {
    const fixture = await seed();
    const actor: Express.Request["actor"] = {
      type: "agent", companyId: fixture.companyId, agentId: fixture.executorAgentId,
      runId: fixture.executorRunId, source: "agent_jwt",
    };
    const grant = await issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId,
      executorAgentId: fixture.executorAgentId,
    });
    await db.update(heartbeatRuns).set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, fixture.executorRunId));
    await request(appAs(actor))
      .post(`/api/issues/${fixture.issueId}/execution-grants`)
      .send({ decisionKind: "agent", decisionId: fixture.decisionId })
      .expect(403);
    const response = await request(appAs(actor))
      .patch(`/api/agents/${fixture.targetAgentId}`)
      .set("X-Paperclip-Execution-Grant", grant!.id)
      .send(fixture.body);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.details?.code).toBe("execution_grant_active_run_required");
    expect((await db.select().from(executionGrants).where(eq(executionGrants.id, grant!.id)))[0].consumedAt)
      .toBeNull();
  });

  it("rejects a changed agent row even if no config revision was recorded", async () => {
    const fixture = await seed();
    const grant = await issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId,
      executorAgentId: fixture.executorAgentId,
    });
    await db.update(agents).set({ name: "intervening change", updatedAt: new Date(Date.now() + 1_000) })
      .where(eq(agents.id, fixture.targetAgentId));
    const actor: Express.Request["actor"] = {
      type: "agent", companyId: fixture.companyId, agentId: fixture.executorAgentId,
      runId: fixture.executorRunId, source: "agent_jwt",
    };
    const response = await request(appAs(actor))
      .patch(`/api/agents/${fixture.targetAgentId}`)
      .set("X-Paperclip-Execution-Grant", grant!.id)
      .send(fixture.body);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.details?.code).toBe("execution_grant_request_changed");
    expect((await db.select().from(executionGrants).where(eq(executionGrants.id, grant!.id)))[0].consumedAt)
      .toBeNull();
  });

  it("does not persist adapter secrets for a rejected grant-backed PATCH", async () => {
    const fixture = await seed();
    const grant = await issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId,
      executorAgentId: fixture.executorAgentId,
    });
    const actor: Express.Request["actor"] = {
      type: "agent", companyId: fixture.companyId, agentId: fixture.executorAgentId,
      runId: fixture.executorRunId, source: "agent_jwt",
    };
    await request(appAs(actor))
      .patch(`/api/agents/${fixture.targetAgentId}`)
      .set("X-Paperclip-Execution-Grant", grant!.id)
      .send({ adapterConfig: { env: { OPENAI_API_KEY: "test-secret" } } })
      .expect(403);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, fixture.companyId)))
      .toHaveLength(0);
  });
});
