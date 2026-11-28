import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog, agentApiKeys, agents, authUsers, boardApiKeys, companyMemberships, heartbeatRuns } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { assertCompanyAccess } from "../routes/authz.js";

// This is the token the http adapter now forwards as `authToken` in its POST
// body when config.forwardAuthToken is true (server/src/adapters/http/execute.ts).
// It is the exact same run JWT already minted for local adapters
// (createLocalAgentJwt, runtime-execution.ts). These tests confirm that once
// forwarded, task routes (comment, update) accept it for the agent and run it
// was minted for, and reject it for a different agent or a different run,
// without reimplementing auth.

function createSelectChain(rowsForTable: (table: unknown) => unknown[]) {
  return {
    from(table: unknown) {
      return { where: () => Promise.resolve(rowsForTable(table)) };
    },
  };
}

function createDbState(agentsRows: Array<{ id: string; companyId: string }>, runsRows: Array<{ id: string; companyId: string; agentId: string; responsibleUserId?: string | null }>) {
  const activity: Array<Record<string, unknown>> = [];
  const db = {
    select: () =>
      createSelectChain((table) => {
        if (table === boardApiKeys) return [];
        if (table === agentApiKeys) return [];
        if (table === agents) return agentsRows.map((a) => ({ id: a.id, companyId: a.companyId, status: "active" }));
        if (table === heartbeatRuns) return runsRows.map((r) => ({
          id: r.id, companyId: r.companyId, agentId: r.agentId,
          responsibleUserId: r.responsibleUserId ?? null, status: "running",
          contextSnapshot: {}, resultJson: {},
        }));
        if (table === authUsers) return [{ id: "user-1" }];
        if (table === companyMemberships) {
          // "user-1" is an active, non-viewer member of every company used in
          // these tests, so assertCompanyAccess's responsible-user intersection
          // check passes and the test isolates the agent-jwt boundary itself.
          return [{ companyId: runsRows[0]?.companyId, membershipRole: "member", status: "active" }];
        }
        return [];
      }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    insert: (table: unknown) => ({
      values(values: Record<string, unknown>) {
        if (table === activityLog) activity.push(values);
        return Promise.resolve([]);
      },
    }),
  } as any;
  return { db, activity };
}

function createTaskApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  // Mirrors the two task-route shapes the ticket calls out: commenting and
  // updating an issue, both gated by assertCompanyAccess like the real routes.
  app.post("/companies/:companyId/issues/:issueId/comments", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.status(201).json({ ok: true, commentedBy: req.actor.agentId });
  });
  app.patch("/companies/:companyId/issues/:issueId", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ ok: true, updatedBy: req.actor.agentId });
  });
  app.use(errorHandler);
  return app;
}

describe("task routes with a run JWT forwarded by the http adapter", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const original = process.env[secretEnv];

  beforeEach(() => {
    process.env[secretEnv] = "http-adapter-forwarded-token-secret";
  });

  afterEach(() => {
    if (original === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = original;
  });

  it("accepts the forwarded token to comment and update, for this agent and this run only", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const { db } = createDbState(
      [{ id: agentId, companyId }],
      [{ id: runId, companyId, agentId, responsibleUserId: "user-1" }],
    );
    const authToken = createLocalAgentJwt(agentId, companyId, "http", runId, "user-1");
    expect(authToken).not.toBeNull();

    const app = createTaskApp(db);
    const comment = await request(app)
      .post(`/companies/${companyId}/issues/${issueId}/comments`)
      .set("Authorization", `Bearer ${authToken}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ body: "done" });
    expect(comment.status).toBe(201);
    expect(comment.body).toMatchObject({ ok: true, commentedBy: agentId });

    const update = await request(app)
      .patch(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${authToken}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ status: "done" });
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({ ok: true, updatedBy: agentId });
  });

  it("rejects the same-shaped token when its agent claim does not match this agent's own record", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    // agentId's real record lives in a different company than the one the
    // token claims — the same boundary another agent's forwarded token would
    // hit, since it can never present a company_id claim matching this
    // agent's actual row.
    const { db } = createDbState(
      [{ id: agentId, companyId: randomUUID() }],
      [{ id: runId, companyId, agentId, responsibleUserId: "user-1" }],
    );
    const mismatchedToken = createLocalAgentJwt(agentId, companyId, "http", runId, "user-1");

    const app = createTaskApp(db);
    const comment = await request(app)
      .post(`/companies/${companyId}/issues/${issueId}/comments`)
      .set("Authorization", `Bearer ${mismatchedToken}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ body: "done" });
    expect(comment.status).toBe(401);

    const update = await request(app)
      .patch(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${mismatchedToken}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ status: "done" });
    expect(update.status).toBe(401);
  });

  it("rejects the token for a run other than the one it was minted for", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    const issueId = randomUUID();
    const { db } = createDbState(
      [{ id: agentId, companyId }],
      [{ id: runId, companyId, agentId, responsibleUserId: "user-1" }],
    );
    const authToken = createLocalAgentJwt(agentId, companyId, "http", runId, "user-1");

    const app = createTaskApp(db);
    const comment = await request(app)
      .post(`/companies/${companyId}/issues/${issueId}/comments`)
      .set("Authorization", `Bearer ${authToken}`)
      .set("X-Paperclip-Run-Id", otherRunId)
      .send({ body: "done" });
    // The signed run_id claim stays authoritative; a mismatched run header is
    // a spoof attempt, rejected (not silently rebound to the header's run).
    expect(comment.status).toBe(422);
    expect(comment.body.code).toBe("agent_jwt_run_id_mismatch");
  });
});
