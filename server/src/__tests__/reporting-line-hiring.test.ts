import { randomUUID } from "node:crypto";
import { agents, approvals, companies, companyMemberships, createDb, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { agentService } from "../services/agents.js";
import { approvalService } from "../services/approvals.js";
import { withPluginInteractionOrigin } from "../services/plugin-interaction-context.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { uniqueIssuePrefix } from "./helpers/issue-prefix.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const limits = { enabled: true, maxDepth: 2, maxDirectReports: 2 };

describePostgres("reporting-line hiring restrictions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let worker: ReturnType<typeof configureAgentLifecycle>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-reporting-line-");
    db = createDb(database.connectionString);
    worker = configureAgentLifecycle(db, {
      requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete",
    });
  }, 90_000);

  afterAll(async () => {
    await worker?.stop();
    await database?.cleanup();
  });

  async function fixture(policy: typeof limits | null = limits, requiresApproval = false) {
    const companyId = randomUUID();
    const manager = randomUUID();
    const peer = randomUUID();
    const noHiring = randomUUID();
    const lead = randomUUID();
    const workerAgent = randomUUID();
    const people = [
      { id: manager, name: "Manager", canHire: true },
      { id: peer, name: "Peer", canHire: true },
      { id: noHiring, name: "Individual contributor", canHire: false },
      { id: lead, name: "Lead", canHire: true, reportsTo: manager },
      { id: workerAgent, name: "Worker", canHire: true, reportsTo: lead },
    ];
    await db.insert(companies).values({
      id: companyId, name: "Reporting lines", issuePrefix: uniqueIssuePrefix("RL"),
      reportingLineHiringPolicy: policy, requireBoardApprovalForNewAgents: requiresApproval,
    });
    for (const person of people) {
      await db.insert(agents).values({
        id: person.id, companyId, name: person.name, reportsTo: person.reportsTo,
        permissions: { canCreateAgents: person.canHire },
      });
    }
    await db.insert(companyMemberships).values(people.map(person => ({
      companyId, principalId: person.id, principalType: "agent" as const,
      membershipRole: "member" as const, status: "active" as const,
    })));

    function agentRequest(actorId: string) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = { type: "agent", agentId: actorId, companyId, source: "agent_key" };
        next();
      });
      app.use("/api", agentRoutes(db));
      app.use("/api", approvalRoutes(db));
      app.use(errorHandler);
      return request(app);
    }

    function hire(actorId: string, name: string, reportsTo?: string | null, route = "agent-hires") {
      return agentRequest(actorId).post(`/api/companies/${companyId}/${route}`)
        .send({ name, reportsTo, adapterType: "process", adapterConfig: {} });
    }

    return { companyId, manager, peer, noHiring, lead, workerAgent, hire, agentRequest };
  }

  it("preserves company-wide hiring when the policy is off", async () => {
    const f = await fixture(null);
    const result = await f.hire(f.manager, "Cross-branch hire", f.peer).expect(201);
    expect(result.body.agent.reportsTo).toBe(f.peer);
  });

  it("restricts both stock routes and never grants permission to hire", async () => {
    const f = await fixture();
    await f.hire(f.noHiring, "Unauthorized").expect(403);
    for (const route of ["agents", "agent-hires"]) {
      const denied = await f.hire(f.manager, "Cross-branch hire", f.peer, route).expect(403);
      expect(denied.body.error).toBe("Choose a manager within your reporting line");
      await f.hire(f.manager, "Root hire", null, route).expect(403);
    }
    const own = await f.hire(f.manager, "New direct report", undefined, "agents").expect(201);
    expect(own.body.reportsTo).toBe(f.manager);
    const below = await f.hire(f.manager, "New report of lead", f.lead).expect(201);
    expect(below.body.agent.reportsTo).toBe(f.lead);
  });

  it("keeps the native approval request and its selected reporting line", async () => {
    const f = await fixture(limits, true);
    await f.hire(f.manager, "Unauthorized manager", f.peer).expect(403);
    await f.hire(f.manager, "No direct activation", undefined, "agents").expect(409);
    const result = await f.hire(f.manager, "Pending report").expect(201);
    expect(result.body.agent).toMatchObject({ status: "pending_approval", reportsTo: f.manager });
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, result.body.approval.id));
    expect(approval?.payload).toMatchObject({ reportsTo: f.manager });
  });

  it("places a board-approved hire under the requesting agent when no manager was specified", async () => {
    const f = await fixture(limits, true);
    const created = await f.agentRequest(f.manager).post(`/api/companies/${f.companyId}/approvals`)
      .send({ type: "hire_agent", payload: { name: "Approved report", adapterType: "process" } }).expect(201);
    expect(created.body.requestedByAgentId).toBe(f.manager);
    await approvalService(db).approve(created.body.id, "board");

    const [report] = await db.select().from(agents)
      .where(eq(agents.companyId, f.companyId)).then(rows => rows.filter(row => row.name === "Approved report"));
    expect(report?.reportsTo).toBe(f.manager);
  });

  it("preserves the requesting agent's reporting line when activating a pending hire", async () => {
    const f = await fixture(limits, true);
    const pending = await f.hire(f.manager, "Pending report").expect(201);
    await approvalService(db).approve(pending.body.approval.id, "board");
    const [report] = await db.select().from(agents).where(eq(agents.id, pending.body.agent.id));
    expect(report).toMatchObject({ reportsTo: f.manager });
    expect(report?.lifecycleState).not.toBe("pending_approval");
  });

  it("applies the hiring agent's reporting line in a plugin interaction", async () => {
    const { companyId, lead } = await fixture();
    const lifecycle = createAgentLifecycle(db);
    const hire = await withPluginInteractionOrigin({ companyId, agentId: lead }, () =>
      lifecycle.requestHire(companyId, { name: "New report", adapterType: "process" }),
    );
    expect(hire.reportsTo).toBe(lead);
  });

  it("checks depth and serializes hires for the last direct-report slot", async () => {
    const f = await fixture();
    const tooDeep = await f.hire(f.workerAgent, "Beyond the limit").expect(409);
    expect(tooDeep.body.error).toBe("Maximum reporting depth exceeded");
    const responses = await Promise.all([
      f.hire(f.manager, "Candidate one"), f.hire(f.manager, "Candidate two"),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect(responses.find(response => response.status === 409)?.body.error).toBe("Maximum direct reports exceeded");
  });

  it("keeps both ends of a reporting-line move within the caller's branch", async () => {
    const f = await fixture();
    const service = agentService(db);
    const actor = { recordRevision: { createdByAgentId: f.manager, source: "patch" as const } };
    await expect(service.update(f.peer, { reportsTo: f.manager }, actor))
      .rejects.toThrow("You can only move agents in your reporting line");
    await expect(service.update(f.workerAgent, { reportsTo: f.peer }, actor))
      .rejects.toThrow("Choose a manager within your reporting line");
    await expect(service.update(f.workerAgent, { reportsTo: f.manager }, actor))
      .resolves.toMatchObject({ reportsTo: f.manager });
  });
});
