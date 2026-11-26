import { randomUUID } from "node:crypto";
import { agentConfigRevisions, agents, approvals, authUsers, companies, companyMemberships, environments, heartbeatRuns, issues, principalPermissionGrants, createDb, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { accessRoutes } from "../routes/access.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { companyRoutes } from "../routes/companies.js";
import { authorizationService } from "../services/authorization.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { uniqueIssuePrefix } from "./helpers/issue-prefix.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const limits = { enabled: true, maxDepth: 3, maxDirectReports: 2 };

describePostgres("reporting-line staffing", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let worker: ReturnType<typeof configureAgentLifecycle>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-reporting-line-staffing-");
    db = createDb(database.connectionString);
    worker = configureAgentLifecycle(db, {
      requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete",
    });
  }, 90_000);

  afterAll(async () => {
    await worker?.stop();
    await database?.cleanup();
  });

  async function fixture(policy: typeof limits | null = limits) {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const ownerId = randomUUID();
    const manager = randomUUID();
    const peer = randomUUID();
    const memberId = randomUUID();
    const owner: Express.Request["actor"] = { type: "board", source: "local_implicit", userId: ownerId, isInstanceAdmin: true };
    const adapterConfig = { provider: "codex", model: "gpt-5.4" };
    await db.insert(companies).values({ id: companyId, name: "Staffing", issuePrefix: uniqueIssuePrefix("ST"), staffingPolicy: policy });
    await db.insert(environments).values({ id: environmentId, name: companyId, driver: "sandbox", config: { provider: "daytona" } });
    const runtime = { adapterType: "paperclip_runner", defaultEnvironmentId: environmentId, adapterConfig };
    await db.insert(agents).values([
      { ...runtime, id: manager, companyId, name: "Manager", permissions: { canCreateAgents: true } },
      { ...runtime, id: peer, companyId, name: "Peer", permissions: { canCreateAgents: true } },
    ]);
    await db.insert(authUsers).values({ id: ownerId, name: "Owner", email: `${ownerId}@fixture.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values([
      { id: memberId, companyId, principalType: "agent", principalId: manager, membershipRole: "member", status: "active" },
      { companyId, principalType: "agent", principalId: peer, membershipRole: "member", status: "active" },
      { companyId, principalType: "user", principalId: ownerId, membershipRole: "owner", status: "active" },
    ]);

    await db.insert(principalPermissionGrants).values(["agents:create", "agents:read"].map(permissionKey => ({
      companyId, principalType: "user", principalId: ownerId, permissionKey,
    })));

    function session(actor: Express.Request["actor"]) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = actor; next(); });
      app.use("/api/companies", companyRoutes(db));
      app.use("/api", accessRoutes(db, {
        deploymentMode: "local_trusted", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [],
      }));
      app.use("/api", agentRoutes(db));
      app.use("/api", issueRoutes(db, {} as never));
      app.use(errorHandler);
      return request(app);
    }

    const agentActor = (id: string): Express.Request["actor"] => ({ type: "agent", agentId: id, companyId, source: "agent_key" });
    const agentSession = (id: string, runId?: string) => session({ ...agentActor(id), runId });
    const board = session(owner);
    const grant = (includeDescendants: boolean) => board.patch(`/api/companies/${companyId}/members/${memberId}/permissions`).send({
      grants: [{
        permissionKey: "agents:delegate_resources",
        scope: { choices: [{ environmentId, adapterType: runtime.adapterType, ...adapterConfig, includeDescendants }] },
      }],
    });
    const hire = (actor: string, name: string, reportsTo?: string, direct = false) => agentSession(actor)
      .post(`/api/companies/${companyId}/${direct ? "agents" : "agent-hires"}`).send({
        ...runtime, name, reportsTo, instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": "Check the assigned issue and report the result." } },
      });
    const ready = async (response: Awaited<ReturnType<typeof hire>>) => {
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const id = (response.body.agent ?? response.body).id as string;
      await worker.process(id);
      const [row] = await db.select().from(agents).where(eq(agents.id, id));
      expect(row).toMatchObject({ lifecycleState: "ready", hiredThroughStaffing: true });
      return id;
    };
    return { companyId, environmentId, manager, peer, memberId, ownerId, board, agentActor, agentSession, grant, hire, ready };
  }

  it("requires explicit resource delegation and lets an approved branch hire recursively", async () => {
    const f = await fixture();
    const [manager] = await db.select().from(agents).where(eq(agents.id, f.manager));
    expect(manager?.defaultEnvironmentId).toBe(f.environmentId);
    expect((await f.hire(f.manager, "Denied")).status).toBe(403);
    expect((await f.grant(false)).status).toBe(200);
    const child = await f.ready(await f.hire(f.manager, "Child"));
    expect((await f.hire(child, "Denied grandchild")).status).toBe(403);
    await f.board.patch(`/api/companies/${f.companyId}/members/${f.memberId}/permissions`).send({ grants: [] }).expect(200);
    await f.agentSession(f.manager).patch(`/api/agents/${child}`).send({ defaultEnvironmentId: f.environmentId }).expect(403);
    expect((await f.grant(true)).status).toBe(200);
    const briefPath = `/api/agents/${child}/instructions-bundle/file`;
    const [instructionRun] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.manager, responsibleUserId: f.ownerId, status: "running", invocationSource: "on_demand",
    }).returning();
    const instructionSession = f.agentSession(f.manager, instructionRun!.id);
    const brief = await instructionSession.get(briefPath).query({ path: "AGENTS.md" });
    expect(brief.status, JSON.stringify(brief.body)).toBe(200);
    await instructionSession.put(briefPath).send({
      path: "AGENTS.md", content: "Review the assigned task and record the result.",
      baseRevisionId: brief.body.revision?.id ?? null,
    }).expect(200);
    const grandchild = await f.ready(await f.hire(child, "Grandchild", undefined, true));
    const cousin = await f.ready(await f.hire(f.manager, "Under my manager", child));
    const renamed = await f.agentSession(f.manager).patch(`/api/agents/${grandchild}`).send({ title: "Reviewer" });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect((await f.agentSession(f.manager).patch(`/api/agents/${cousin}`).send({ reportsTo: f.manager })).status).toBe(200);
    expect(await db.select().from(approvals).where(eq(approvals.companyId, f.companyId))).toHaveLength(0);
  });

  it("denies staffing outside the branch and refuses a move to an unrelated manager", async () => {
    const f = await fixture();
    expect((await f.grant(true)).status).toBe(200);
    const child = await f.ready(await f.hire(f.manager, "Own report"));
    for (const target of [f.peer, f.manager]) {
      expect((await f.agentSession(child).patch(`/api/agents/${target}`).send({ title: "Denied" })).status).toBe(403);
    }
    expect((await f.hire(f.manager, "Unrelated hire", f.peer)).status).toBe(403);
    expect((await f.agentSession(f.manager).patch(`/api/agents/${child}`).send({ reportsTo: f.peer })).status).toBe(403);
    expect((await f.agentSession(f.manager).patch(`/api/agents/${f.peer}`).send({ reportsTo: child })).status).toBe(403);
    expect((await f.agentSession(f.peer).patch(`/api/agents/${child}`).send({ status: "terminated" })).status).toBe(403);
    await f.board.patch(`/api/agents/${child}`).send({ title: "Revision for rollback" }).expect(200);
    const [revision] = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, child));
    const rollback = await f.agentSession(f.peer).post(`/api/agents/${child}/config-revisions/${revision!.id}/rollback`);
    expect(rollback.status, JSON.stringify(rollback.body)).toBe(403);
    expect((await f.agentSession(f.manager).delete(`/api/agents/${child}`)).status).toBe(403);
  });

  it("serializes hire and move capacity and checks the deepest moved report", async () => {
    const f = await fixture({ ...limits, maxDepth: 2 });
    expect((await f.grant(true)).status).toBe(200);
    const branch = await f.ready(await f.hire(f.manager, "Branch"));
    const leaf = await f.ready(await f.hire(branch, "Leaf"));
    expect((await f.hire(leaf, "Too deep")).status).toBe(409);
    const results = await Promise.all([
      f.hire(f.manager, "Racing hire"),
      f.agentSession(f.manager).patch(`/api/agents/${leaf}`).send({ reportsTo: f.manager }),
    ]);
    expect(results.map(result => result.status === 409).sort()).toEqual([false, true]);
    const [leafRow] = await db.select().from(agents).where(eq(agents.id, leaf));
    if (leafRow?.reportsTo === f.manager) {
      await f.board.patch(`/api/agents/${leaf}`).send({ reportsTo: branch }).expect(200);
      await f.ready(await f.hire(f.manager, "Other branch"));
    }
    const direct = await db.select().from(agents).where(and(eq(agents.companyId, f.companyId), eq(agents.reportsTo, f.manager)));
    const other = direct.find(row => row.id !== branch)!;
    expect((await f.agentSession(f.manager).patch(`/api/agents/${branch}`).send({ reportsTo: other.id })).status).toBe(409);
    expect((await f.agentSession(f.manager).post(`/api/agents/${branch}/terminate`)).status).toBe(409);
  });

  it("counts pending hires, releases settled slots, and retains unfinished work", async () => {
    const f = await fixture();
    await f.grant(true).expect(200);
    const [pending] = await db.insert(agents).values({
      companyId: f.companyId, name: "Pending hire", reportsTo: f.manager,
      lifecycleState: "pending_approval", status: "pending_approval",
    }).returning();
    const outcomes = await Promise.all([f.hire(f.manager, "Capacity one"), f.hire(f.manager, "Capacity two")]);
    expect(outcomes.map(result => result.status).sort()).toEqual([201, 409]);
    const child = await f.ready(outcomes.find(result => result.status === 201)!);
    const [issue] = await db.insert(issues).values({
      companyId: f.companyId, title: "Keep this task", assigneeAgentId: child, status: "todo",
    }).returning();
    await f.agentSession(f.manager).post(`/api/agents/${child}/pause`).expect(200);
    await worker.process(child);
    await f.agentSession(f.manager).post(`/api/agents/${child}/resume`).expect(200);
    await worker.process(child);
    await f.agentSession(f.manager).post(`/api/agents/${child}/terminate`).expect(200);
    await worker.process(child);
    const [retired] = await db.select().from(agents).where(eq(agents.id, child));
    expect(retired?.lifecycleState).toBe("terminated");
    const [retained] = await db.select().from(issues).where(eq(issues.id, issue!.id));
    expect(retained).toMatchObject({ assigneeAgentId: child, status: "todo" });
    await f.ready(await f.hire(f.manager, "Replacement"));
    const [stillPending] = await db.select().from(agents).where(eq(agents.id, pending!.id));
    expect(stillPending?.lifecycleState).toBe("pending_approval");
  });

  it("keeps work access and denies both legacy hiring paths after disabling staffing", async () => {
    const f = await fixture();
    expect((await f.grant(true)).status).toBe(200);
    const child = await f.ready(await f.hire(f.manager, "Bounded report"));
    const [issue] = await db.insert(issues).values({
      companyId: f.companyId, title: "In-scope work", assigneeAgentId: child, status: "todo",
    }).returning();
    const actor = f.agentActor(child);
    const resource = { type: "issue" as const, companyId: f.companyId, issueId: issue!.id, assigneeAgentId: child };
    const workAccess = () => authorizationService(db).decide({ actor, action: "issue:mutate", resource });
    expect((await workAccess()).allowed).toBe(true);
    expect((await f.board.patch(`/api/companies/${f.companyId}`).send({ staffingPolicy: { ...limits, enabled: false } })).status).toBe(200);
    expect((await workAccess()).allowed).toBe(true);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: child, status: "running", invocationSource: "assignment",
      contextSnapshot: { issueId: issue!.id }, startedAt: new Date(),
    }).returning();
    const completed = await f.agentSession(child, run!.id).patch(`/api/issues/${issue!.id}`).send({ status: "done" });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    const [bound] = await db.select().from(agents).where(eq(agents.id, child));
    expect(bound).toMatchObject({ hiredThroughStaffing: true, defaultEnvironmentId: f.environmentId });
    await db.update(agents).set({ permissions: { canCreateAgents: true } }).where(eq(agents.id, child));
    expect((await f.hire(child, "Legacy fallback")).status).toBe(403);
    await db.insert(principalPermissionGrants).values({
      companyId: f.companyId, principalType: "agent", principalId: child, permissionKey: "agents:create",
    });
    expect((await f.hire(child, "Explicit legacy grant", undefined, true)).status).toBe(403);

    const stock = await fixture(null);
    const response = await stock.agentSession(stock.manager).post(`/api/companies/${stock.companyId}/agent-hires`).send({
      name: "Stock report", adapterType: "process", reportsTo: stock.peer,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.agent.hiredThroughStaffing).toBe(false);
  });
});
