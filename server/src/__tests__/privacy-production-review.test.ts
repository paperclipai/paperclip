import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import WebSocket from "ws";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceOperations, agents, approvals, assets, chatEndpoints, chatExternalPrincipals, chatConversations, chatIdentityLinks, chatDeliveries, toolApplications, toolConnections, executionWorkspaces, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueAccessGrants, issues, projectAccessMembers, projects, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { authorizationService, canPublishIssueToChatAudience, canActorReadIssuePrivacy, issueReadSqlCondition, canActorReadProjectPrivacy, projectReadSqlCondition, canActorReadApproval, approvalReadSqlCondition, canActorReadExecutionWorkspace, type AuthorizationActor } from "../services/authorization.js";

import { canActorReadWorkspaceOperation } from "../services/heartbeat-run-privacy.js";

// Production regressions and the approved downward-only sharing contract.
describe("private task production review", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-private-review-");
    db = createDb(tempDb.connectionString);
    // Load the current route dependency graph during setup, outside assertion timeouts.
    await Promise.all([import("../routes/issues.js"), import("../routes/projects.js")]);
  }, 120_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: randomUUID(), issuePrefix: `T${randomUUID().slice(0, 5)}` }).returning();
    const owner = randomUUID(), outsider = randomUUID();
    await db.insert(authUsers).values([owner, outsider].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() })));
    await db.insert(companyMemberships).values([owner, outsider].map(principalId => ({ companyId: company.id, principalType: "user", principalId, status: "active", membershipRole: "operator" })));
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Shared agent", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    const actor = (userId: string): AuthorizationActor => ({ type: "board", userId, source: "session", companyIds: [company.id] });
    return { company, owner, outsider, agent, actor };
  }

  it("lets only the project privacy owner or an admin change its audience", async () => {
    const f = await fixture();
    const { projectRoutes } = await import("../routes/projects.js");
    const { errorHandler } = await import("../middleware/index.js");
    let actor = f.actor(f.owner);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);
    const created = await request(app).post(`/api/companies/${f.company.id}/projects`).send({ name: "Private project", visibility: "private", privacyOwnerUserId: f.outsider });
    expect(created.status).toBe(201);
    expect(created.body.privacyOwnerUserId).toBe(f.owner);
    const projectId = created.body.id;
    const member = await request(app).post(`/api/projects/${projectId}/access-members`).send({ subjectType: "user", subjectId: f.outsider });
    expect(member.status).toBe(201);
    actor = f.actor(f.outsider);
    expect((await request(app).get(`/api/projects/${projectId}`)).status).toBe(200);
    expect((await request(app).patch(`/api/projects/${projectId}`).send({ visibility: "open" })).status).toBe(403);
    expect((await request(app).post(`/api/projects/${projectId}/access-members`).send({ subjectType: "agent", subjectId: f.agent.id })).status).toBe(403);
    expect((await request(app).delete(`/api/projects/${projectId}/access-members/${member.body.id}`)).status).toBe(403);
    actor = f.actor(f.owner);
    expect((await request(app).delete(`/api/projects/${projectId}/access-members/${member.body.id}`)).status).toBe(200);
    expect((await request(app).patch(`/api/projects/${projectId}`).send({ visibility: "open" })).status).toBe(200);
    await db.update(companyMemberships).set({ membershipRole: "admin" }).where(and(eq(companyMemberships.companyId, f.company.id), eq(companyMemberships.principalId, f.outsider)));
    actor = f.actor(f.outsider);
    expect((await request(app).patch(`/api/projects/${projectId}`).send({ visibility: "private" })).status).toBe(200);
  });

  it("publishes private chat content only to a currently authorized linked DM recipient", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Private chat", visibility: "private", responsibleUserId: f.owner }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: f.company.id, name: "Test chat", type: "native" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: application.id, name: "Test chat", uid: "test-chat", connectionPurpose: "channel", transport: "chat_sdk" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.company.id, connectionId: connection.id, provider: "slack", publicId: randomUUID(), assignedAgentId: f.agent.id }).returning();
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: f.company.id, provider: "slack", providerAccountId: "test", externalId: "person", kind: "user" }).returning();
    const [conversation] = await db.insert(chatConversations).values({ companyId: f.company.id, endpointId: endpoint.id, issueId: task.id, externalConversationId: "dm", externalLabel: "Test DM", isDirectMessage: true }).returning();
    const publication = { companyId: f.company.id, issueId: task.id, endpointId: endpoint.id, conversationId: conversation.id };
    expect(await canPublishIssueToChatAudience(db, publication)).toBe(false);
    await db.insert(chatDeliveries).values({ companyId: f.company.id, endpointId: endpoint.id, conversationId: conversation.id, principalId: principal.id, providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "message", normalizedEvent: {} as any });
    const [link] = await db.insert(chatIdentityLinks).values({ companyId: f.company.id, endpointId: endpoint.id, principalId: principal.id, paperclipUserId: f.outsider, status: "linked" }).returning();
    expect(await canPublishIssueToChatAudience(db, publication)).toBe(false);
    const [grant] = await db.insert(issueAccessGrants).values({ issueId: task.id, subjectType: "user", subjectId: f.outsider, source: "explicit" }).returning();
    expect(await canPublishIssueToChatAudience(db, publication)).toBe(true);
    await db.update(chatConversations).set({ isDirectMessage: false }).where(eq(chatConversations.id, conversation.id));
    expect(await canPublishIssueToChatAudience(db, publication)).toBe(false);
    await db.update(chatConversations).set({ isDirectMessage: true }).where(eq(chatConversations.id, conversation.id));
    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
    expect(await canPublishIssueToChatAudience(db, publication)).toBe(false);
    await db.update(chatIdentityLinks).set({ paperclipUserId: f.owner }).where(eq(chatIdentityLinks.id, link.id));
    expect(await canPublishIssueToChatAudience(db, publication)).toBe(true);
    await db.update(chatIdentityLinks).set({ revokedAt: new Date() }).where(eq(chatIdentityLinks.id, link.id));
    expect(await canPublishIssueToChatAudience(db, publication)).toBe(false);
  });

  it("a shared agent cannot read an owner's private task on behalf of an unauthorized coworker", async () => {
    const f = await fixture();
    const id = randomUUID();
    const [issue] = await db.insert(issues).values({ id, companyId: f.company.id, title: "Private email", visibility: "private", privacyRootIssueId: id, responsibleUserId: f.owner, assigneeAgentId: f.agent.id }).returning();
    const authz = authorizationService(db);
    const resource = { type: "issue" as const, companyId: f.company.id, issueId: id };
    expect((await authz.decide({ actor: f.actor(f.outsider), action: "issue:read", resource })).allowed).toBe(false);
    expect((await authz.decide({ actor: { type: "agent", agentId: f.agent.id, companyId: f.company.id, source: "agent_jwt", onBehalfOfUserId: f.outsider }, action: "issue:read", resource })).allowed).toBe(false);
  });

  it("list SQL and direct checks agree after a project becomes open", async () => {
    const f = await fixture();
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Previously private", visibility: "open" }).returning();
    await db.insert(projectAccessMembers).values({ companyId: f.company.id, projectId: project.id, subjectType: "user", subjectId: f.outsider });
    const id = randomUUID();
    const [issue] = await db.insert(issues).values({ id, companyId: f.company.id, title: "Still individually private", visibility: "private", privacyRootIssueId: id, responsibleUserId: f.owner, projectId: project.id }).returning();
    expect(await canActorReadIssuePrivacy(db, f.actor(f.outsider), issue)).toBe(false);
    const found = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, id), await issueReadSqlCondition(db, f.actor(f.outsider))));
    expect(found).toEqual([]);
  });

  it("making a parent private also protects existing descendants", async () => {
    const f = await fixture();
    const { issueService } = await import("../services/issues.js");
    const svc = issueService(db);
    const parent = await svc.create(f.company.id, { title: "Parent", createdByUserId: f.owner });
    const child = await svc.create(f.company.id, { title: "Existing child", parentId: parent.id, createdByUserId: f.owner });
    await svc.update(parent.id, { visibility: "private" });
    const updated = await svc.getById(child.id);
    expect(updated?.visibility).toBe("private");
  });

  it("restricting a project protects descendants outside it and preserves privacy when reopened", async () => {
    const f = await fixture();
    const { issueService } = await import("../services/issues.js");
    const { projectService } = await import("../services/projects.js");
    const svc = issueService(db);
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Project", visibility: "open" }).returning();
    const root = await svc.create(f.company.id, { title: "Root", projectId: project.id, createdByUserId: f.owner });
    const child = await svc.create(f.company.id, { title: "Child", parentId: root.id, createdByUserId: f.owner });
    const grandchild = await svc.create(f.company.id, { title: "Grandchild", parentId: child.id, createdByUserId: f.owner });
    await projectService(db).update(project.id, { visibility: "private" });
    expect(await canActorReadIssuePrivacy(db, f.actor(f.outsider), grandchild)).toBe(false);
    await projectService(db).update(project.id, { visibility: "open" });
    expect(await canActorReadIssuePrivacy(db, f.actor(f.outsider), grandchild)).toBe(false);
    expect((await svc.getById(child.id))?.visibility).toBe("private");
  });

  it("publishing a personal task leaves its private project while keeping its children private", async () => {
    const f = await fixture();
    const { issueService } = await import("../services/issues.js");
    const svc = issueService(db);
    const root = await svc.create(f.company.id, { title: "Personal", visibility: "private", createdByUserId: f.owner });
    const child = await svc.create(f.company.id, { title: "Child", parentId: root.id, createdByUserId: f.owner });
    const published = await svc.update(root.id, { visibility: "open" });
    expect(published?.projectId).toBeNull();
    expect(await canActorReadIssuePrivacy(db, f.actor(f.outsider), published!)).toBe(true);
    expect(await canActorReadIssuePrivacy(db, f.actor(f.outsider), child)).toBe(false);
  });

  it("reparenting an open issue under a private task inherits privacy", async () => {
    const f = await fixture();
    const { issueService } = await import("../services/issues.js");
    const svc = issueService(db);
    const parent = await svc.create(f.company.id, { title: "Parent", createdByUserId: f.owner, visibility: "private" });
    const child = await svc.create(f.company.id, { title: "Moved child", createdByUserId: f.owner });
    const updated = await svc.update(child.id, { parentId: parent.id });
    expect(updated?.visibility).toBe("private");
  });

  it("allows task management hints in an unreadable personal project without disclosing its identity", async () => {
    const f = await fixture();
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Protected personal context", visibility: "private", personalOwnerUserId: f.outsider, privacyOwnerUserId: f.outsider }).returning();
    const id = randomUUID();
    const [task] = await db.insert(issues).values({ id, companyId: f.company.id, title: "Owned task", visibility: "private", privacyRootIssueId: id, responsibleUserId: f.owner, projectId: project.id }).returning();
    const { issueRoutes } = await import("../routes/issues.js");
    const { projectRoutes } = await import("../routes/projects.js");
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = f.actor(f.owner) as Express.Request["actor"]; next(); });
    app.use("/api", issueRoutes(db, {} as any)); app.use("/api", projectRoutes(db));
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.status ?? 500).json({ error: err.message }); });
    await request(app).get(`/api/projects/${project.id}`).expect(404);
    const response = await request(app).get(`/api/issues/${task.id}/privacy-constraints`).expect(200);
    expect(response.body).toEqual({ publicBlockedBy: null, leavesPersonalProject: true });
    const { issueService } = await import("../services/issues.js");
    expect(await issueService(db).update(task.id, { visibility: "open" })).toMatchObject({ visibility: "open", projectId: null });
  });

  it("reports an inaccessible private parent as a move-first constraint without leaking it", async () => {
    const f = await fixture();
    const parentId = randomUUID(), childId = randomUUID();
    await db.insert(issues).values({ id: parentId, companyId: f.company.id, title: "Hidden parent content", visibility: "private", privacyRootIssueId: parentId, responsibleUserId: f.outsider });
    await db.insert(issues).values({ id: childId, companyId: f.company.id, title: "Owned child", visibility: "private", privacyRootIssueId: parentId, privacyParentIssueId: parentId, responsibleUserId: f.owner });
    const { issueRoutes } = await import("../routes/issues.js");
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = f.actor(f.owner) as Express.Request["actor"]; next(); });
    app.use("/api", issueRoutes(db, {} as any));
    await request(app).get(`/api/issues/${parentId}`).expect(404);
    const response = await request(app).get(`/api/issues/${childId}/privacy-constraints`).expect(200);
    expect(response.body).toEqual({ publicBlockedBy: "parent", leavesPersonalProject: false });
  });

  it("does not expose task management hints to a shared reader or unrelated company", async () => {
    const f = await fixture(); const id = randomUUID();
    await db.insert(issues).values({ id, companyId: f.company.id, title: "Private", visibility: "private", privacyRootIssueId: id, responsibleUserId: f.owner });
    const { issueRoutes } = await import("../routes/issues.js");
    let actor = f.actor(f.outsider);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor as Express.Request["actor"]; next(); });
    app.use("/api", issueRoutes(db, {} as any));
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.status ?? 500).json({ error: err.message }); });
    await request(app).get(`/api/issues/${id}/privacy-constraints`).expect(404);
    await db.insert(issueAccessGrants).values({ issueId: id, subjectType: "user", subjectId: f.outsider, source: "explicit" });
    await request(app).get(`/api/issues/${id}/privacy-constraints`).expect(403);
    actor = { ...f.actor(f.owner), companyIds: [] };
    await db.update(companyMemberships).set({ status: "archived" }).where(and(eq(companyMemberships.companyId, f.company.id), eq(companyMemberships.principalId, f.owner)));
    const denied = await request(app).get(`/api/issues/${id}/privacy-constraints`).expect(404);
    expect(denied.body.publicBlockedBy).toBeUndefined();
  });

  it("an unauthorized board user cannot fetch a private issue through PATCH", async () => {
    const f = await fixture();
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId: f.company.id, title: "Confidential acquisition", description: "Private email content", status: "backlog", visibility: "private", privacyRootIssueId: id, responsibleUserId: f.owner, createdByUserId: f.owner });
    const { issueRoutes } = await import("../routes/issues.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = f.actor(f.outsider) as Express.Request["actor"]; next(); });
    app.use("/api", issueRoutes(db, {} as any));
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.status ?? 500).json({ error: err.message }); });
    await request(app).get(`/api/issues/${id}`).expect(404);
    const response = await request(app).patch(`/api/issues/${id}`).send({ priority: "low" });
    expect({ status: response.status, title: response.body.title }).toEqual({ status: 404, title: undefined });
  });

  it("sharing a child grants its descendants, never its parent or sibling, and revokes immediately", async () => {
    const f = await fixture();
    const { issueService } = await import("../services/issues.js");
    const svc = issueService(db);
    const root = await svc.create(f.company.id, { title: "Root", visibility: "private", createdByUserId: f.owner });
    const child = await svc.create(f.company.id, { title: "Shared child", parentId: root.id, createdByUserId: f.owner });
    const grandchild = await svc.create(f.company.id, { title: "Grandchild", parentId: child.id, createdByUserId: f.owner });
    const sibling = await svc.create(f.company.id, { title: "Sibling", parentId: root.id, createdByUserId: f.owner });
    const [grant] = await db.insert(issueAccessGrants).values({ issueId: child.id, subjectType: "user", subjectId: f.outsider, source: "explicit" }).returning();
    for (const [task, expected] of [[root, false], [child, true], [grandchild, true], [sibling, false]] as const) {
      expect(await canActorReadIssuePrivacy(db, f.actor(f.outsider), task)).toBe(expected);
      const rows = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, task.id), await issueReadSqlCondition(db, f.actor(f.outsider))));
      expect(rows.length > 0).toBe(expected);
    }
    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
    expect(await canActorReadIssuePrivacy(db, f.actor(f.outsider), child)).toBe(false);
    expect(await canActorReadIssuePrivacy(db, f.actor(f.outsider), grandchild)).toBe(false);
  });

  it("binds child-manager grant writes to the child and rejects ancestor or sibling grants", async () => {
    const f = await fixture();
    const { issueService } = await import("../services/issues.js");
    const { issueRoutes } = await import("../routes/issues.js");
    const { errorHandler } = await import("../middleware/index.js");
    const svc = issueService(db);
    const root = await svc.create(f.company.id, { title: "Ancestor", visibility: "private", createdByUserId: f.outsider });
    const child = await svc.create(f.company.id, { title: "Managed child", parentId: root.id, createdByUserId: f.owner });
    const grandchild = await svc.create(f.company.id, { title: "Descendant", parentId: child.id, createdByUserId: f.outsider });
    const sibling = await svc.create(f.company.id, { title: "Sibling", parentId: root.id, createdByUserId: f.outsider });
    const [rootGrant] = await db.insert(issueAccessGrants).values({ issueId: root.id, subjectType: "user", subjectId: f.owner, source: "explicit" }).returning();
    const [siblingGrant] = await db.insert(issueAccessGrants).values({ issueId: sibling.id, subjectType: "user", subjectId: f.owner, source: "explicit" }).returning();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = f.actor(f.owner); next(); });
    app.use("/api", issueRoutes(db, {} as any)); app.use(errorHandler);
    const audience = await request(app).get(`/api/issues/${child.id}/access-grants`).expect(200);
    expect(audience.body).toContainEqual(expect.objectContaining({ id: rootGrant.id, inherited: true }));
    for (const grant of [rootGrant, siblingGrant]) {
      await request(app).post(`/api/issues/${child.id}/access-grants/${grant.id}/revoke`).send({}).expect(404);
      const [unchanged] = await db.select().from(issueAccessGrants).where(eq(issueAccessGrants.id, grant.id));
      expect(unchanged.revokedAt).toBeNull();
    }
    for (const task of [root, sibling]) {
      await request(app).post(`/api/issues/${task.id}/access-grants`).send({ subjectType: "agent", subjectId: f.agent.id }).expect(403);
    }
    const added = await request(app).post(`/api/issues/${child.id}/access-grants`).send({ subjectType: "agent", subjectId: f.agent.id }).expect(201);
    expect(added.body.issueId).toBe(child.id);
    const agent: AuthorizationActor = { type: "agent", companyId: f.company.id, agentId: f.agent.id };
    for (const [task, expected] of [[root, false], [child, true], [grandchild, true], [sibling, false]] as const) {
      expect(await canActorReadIssuePrivacy(db, agent, task)).toBe(expected);
    }
    await request(app).post(`/api/issues/${child.id}/access-grants/${added.body.id}/revoke`).send({}).expect(200);
    expect(await canActorReadIssuePrivacy(db, agent, child)).toBe(false);
    expect(await canActorReadIssuePrivacy(db, agent, grandchild)).toBe(false);
  });

  it("retains a child assignment grant after unassignment without granting the root", async () => {
    const f = await fixture();
    const { issueService } = await import("../services/issues.js");
    const svc = issueService(db);
    const root = await svc.create(f.company.id, { title: "Root", visibility: "private", createdByUserId: f.owner });
    const child = await svc.create(f.company.id, { title: "Assigned child", parentId: root.id, createdByUserId: f.owner, assigneeAgentId: f.agent.id });
    await svc.update(child.id, { assigneeAgentId: null });
    const actor: AuthorizationActor = { type: "agent", agentId: f.agent.id, companyId: f.company.id };
    expect(await canActorReadIssuePrivacy(db, actor, child)).toBe(true);
    expect(await canActorReadIssuePrivacy(db, actor, root)).toBe(false);
    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.issueId, child.id));
    expect(await canActorReadIssuePrivacy(db, actor, child)).toBe(false);
  });

  it("protects standalone tasks created from a private run", async () => {
    const f = await fixture();
    const { issueService } = await import("../services/issues.js");
    const svc = issueService(db);
    const source = await svc.create(f.company.id, { title: "Private conversation", visibility: "private", createdByUserId: f.owner });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, invocationSource: "on_demand", status: "succeeded", nativeIssueId: source.id }).returning();
    const handoff = await svc.create(f.company.id, { title: "Standalone handoff", createdByUserId: f.owner, originRunId: run.id });
    expect(handoff).toMatchObject({ parentId: null, privacyParentIssueId: source.id, visibility: "private" });
    expect(await canActorReadIssuePrivacy(db, f.actor(f.outsider), handoff)).toBe(false);
  });

  it("intersects agent and responsible-user access to private projects in direct and list reads", async () => {
    const f = await fixture();
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Private project", visibility: "private" }).returning();
    await db.insert(projectAccessMembers).values({ companyId: f.company.id, projectId: project.id, subjectType: "agent", subjectId: f.agent.id });
    const actor: AuthorizationActor = { type: "agent", agentId: f.agent.id, companyId: f.company.id, onBehalfOfUserId: f.outsider };
    expect(await canActorReadProjectPrivacy(db, actor, project)).toBe(false);
    expect(await db.select().from(projects).where(and(eq(projects.id, project.id), await projectReadSqlCondition(db, actor)))).toEqual([]);
    await db.insert(projectAccessMembers).values({ companyId: f.company.id, projectId: project.id, subjectType: "user", subjectId: f.outsider });
    expect(await canActorReadProjectPrivacy(db, actor, project)).toBe(true);
  });

  it("binds native runs and keeps missing-task history fail closed", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Private", visibility: "private", responsibleUserId: f.owner }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, invocationSource: "on_demand", status: "succeeded", nativeIssueId: task.id }).returning();
    expect(run).toMatchObject({ scopeKind: "issue", issueId: task.id });
    await db.update(heartbeatRuns).set({ contextSnapshot: {}, scopeKind: "company" }).where(eq(heartbeatRuns.id, run.id));
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id))).toMatchObject([{ scopeKind: "issue", issueId: task.id }]);
    const [orphan] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, invocationSource: "on_demand", status: "succeeded", contextSnapshot: { issueId: randomUUID() } }).returning();
    expect(orphan).toMatchObject({ scopeKind: "issue", issueId: null });
  });

  it("filters private and orphaned operation excerpts from a shared workspace listing", async () => {
    const f = await fixture();
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Shared" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.company.id, projectId: project.id, mode: "isolated_workspace", strategyType: "git_worktree", name: "Shared workspace" }).returning();
    const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Private", visibility: "private", responsibleUserId: f.owner }).returning();
    await db.insert(workspaceOperations).values({ companyId: f.company.id, executionWorkspaceId: workspace.id, issueId: task.id, phase: "prepare", stdoutExcerpt: "PRIVATE_OPERATION" });
    const [publicOperation] = await db.insert(workspaceOperations).values({ companyId: f.company.id, executionWorkspaceId: workspace.id, phase: "prepare", stdoutExcerpt: "PUBLIC_OPERATION" }).returning();
    const { executionWorkspaceRoutes } = await import("../routes/execution-workspaces.js");
    const { errorHandler } = await import("../middleware/index.js");
    let actor = f.actor(f.outsider);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", executionWorkspaceRoutes(db)); app.use(errorHandler);
    const path = `/api/execution-workspaces/${workspace.id}/workspace-operations`;
    const outside = await request(app).get(path);
    expect(outside.status).toBe(200);
    expect(outside.body.map((row: { id: string }) => row.id)).toEqual([publicOperation.id]);
    actor = f.actor(f.owner);
    expect((await request(app).get(path)).body).toHaveLength(2);
    await db.delete(issues).where(eq(issues.id, task.id));
    expect((await request(app).get(path)).body.map((row: { id: string }) => row.id)).toEqual([publicOperation.id]);
  });

  it("keeps operation history private even with a company run and after task or run deletion", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Private", visibility: "private", responsibleUserId: f.owner }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, invocationSource: "on_demand", status: "succeeded" }).returning();
    expect(run.scopeKind).toBe("company");
    const [operation] = await db.insert(workspaceOperations).values({ companyId: f.company.id, issueId: task.id, heartbeatRunId: run.id, phase: "prepare", stdoutExcerpt: "PRIVATE_LOG" }).returning();
    const access = authorizationService(db);
    expect(await canActorReadWorkspaceOperation(db, access, f.actor(f.owner), operation)).toBe(true);
    expect(await canActorReadWorkspaceOperation(db, access, f.actor(f.outsider), operation)).toBe(false);
    await db.delete(issues).where(eq(issues.id, task.id));
    const [orphan] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, operation.id));
    expect(orphan).toMatchObject({ issueId: null, stdoutExcerpt: "PRIVATE_LOG", metadata: { _issuePrivacySources: { [task.id]: true } } });
    expect(await canActorReadWorkspaceOperation(db, access, f.actor(f.owner), orphan)).toBe(false);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [history] = await db.update(workspaceOperations).set({ metadata: {} }).where(eq(workspaceOperations.id, operation.id)).returning();
    expect(history).toMatchObject({ heartbeatRunId: null, metadata: { _runPrivacySources: { [run.id]: true }, _issuePrivacySources: { [task.id]: true } } });
    expect(await canActorReadWorkspaceOperation(db, access, f.actor(f.owner), history)).toBe(false);
  });

  it("delivers authorized live output, then stops delivery after revocation on the same socket", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Private", visibility: "private", responsibleUserId: f.owner }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, invocationSource: "on_demand", status: "succeeded", nativeIssueId: task.id }).returning();
    const [grant] = await db.insert(issueAccessGrants).values({ issueId: task.id, subjectType: "user", subjectId: f.outsider, source: "explicit" }).returning();
    const { setupLiveEventsWebSocketServer } = await import("../realtime/live-events-ws.js");
    const { publishLiveEvent } = await import("../services/live-events.js");
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, db, { deploymentMode: "authenticated", resolveCloudActor: async () => ({ userId: f.outsider, companyIds: [f.company.id] }) });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/companies/${f.company.id}/events/ws`);
    const messages: string[] = [];
    socket.on("message", data => messages.push(data.toString()));
    try {
      await once(socket, "open");
      const publish = (chunk: string) => publishLiveEvent({ companyId: f.company.id, type: "heartbeat.run.log", payload: { issueId: task.id, runId: run.id, agentId: f.agent.id, chunk } });
      publish("AUTHORIZED_CANARY");
      await expect.poll(() => messages.some(message => message.includes("AUTHORIZED_CANARY"))).toBe(true);
      publishLiveEvent({ companyId: f.company.id, type: "activity.logged", payload: { action: "authorized_activity", entityType: "issue", entityId: task.id } });
      await expect.poll(() => messages.some(message => message.includes("authorized_activity"))).toBe(true);
      await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
      publish("REVOKED_CANARY");
      publishLiveEvent({ companyId: f.company.id, type: "activity.logged", payload: { action: "revoked_activity", entityType: "issue", entityId: task.id } });
      publishLiveEvent({ companyId: f.company.id, type: "activity.logged", payload: { action: "queue_drained", entityType: "company", entityId: f.company.id } });
      await expect.poll(() => messages.some(message => message.includes("queue_drained"))).toBe(true);
      expect(messages.join(" ")).not.toContain("REVOKED_CANARY");
      expect(messages.join(" ")).not.toContain("revoked_activity");
    } finally {
      socket.terminate();
      await new Promise<void>(resolve => (wss as any).close(resolve));
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("protects linked approval payloads and execution workspace details", async () => {
    const f = await fixture();
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Public project" }).returning();
    const [task] = await db.insert(issues).values({ companyId: f.company.id, projectId: project.id, title: "Private", visibility: "private", responsibleUserId: f.owner }).returning();
    const [approval] = await db.insert(approvals).values({ companyId: f.company.id, type: "hire_agent", payload: { sourceIssueId: task.id, instructions: "PRIVATE_PAYLOAD" } }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.company.id, projectId: project.id, sourceIssueId: task.id, mode: "isolated_workspace", strategyType: "git_worktree", name: "Private workspace" }).returning();
    expect(await canActorReadApproval(db, f.actor(f.owner), approval.id)).toBe(true);
    expect(await canActorReadApproval(db, f.actor(f.outsider), approval.id)).toBe(false);
    expect(await db.select().from(approvals).where(and(eq(approvals.id, approval.id), await approvalReadSqlCondition(db, f.actor(f.outsider))))).toEqual([]);
    expect(await canActorReadExecutionWorkspace(db, f.actor(f.owner), workspace.id)).toBe(true);
    expect(await canActorReadExecutionWorkspace(db, f.actor(f.outsider), workspace.id)).toBe(false);
    await db.update(executionWorkspaces).set({ sourceIssueId: null, metadata: {} }).where(eq(executionWorkspaces.id, workspace.id));
    expect(await canActorReadExecutionWorkspace(db, f.actor(f.outsider), workspace.id)).toBe(false);
    await db.delete(issues).where(eq(issues.id, task.id));
    expect(await canActorReadExecutionWorkspace(db, f.actor(f.outsider), workspace.id)).toBe(false);
  });

  it("keeps inline draft images owner-only until publication then follows the task grant", async () => {
    const f = await fixture();
    const [asset] = await db.insert(assets).values({ companyId: f.company.id, provider: "local_disk", objectKey: `${f.company.id}/assets/issues/drafts/image.png`, contentType: "image/png", byteSize: 6, sha256: "test", createdByUserId: f.owner }).returning();
    const { assetRoutes } = await import("../routes/assets.js");
    const { issueService } = await import("../services/issues.js");
    function appFor(userId: string) {
      const app = express();
      app.use((req, _res, next) => { req.actor = f.actor(userId) as any; next(); });
      app.use("/api", assetRoutes(db, { getObject: async () => ({ stream: Readable.from("SECRET"), contentLength: 6 }) } as any));
      return app;
    }
    const url = `/api/assets/${asset.id}/content`;
    await request(appFor(f.owner)).get(url).expect(200);
    await request(appFor(f.outsider)).get(url).expect(404);
    const task = await issueService(db).create(f.company.id, { title: "Private draft", visibility: "private", createdByUserId: f.owner, description: `![image](${url})` });
    const [grant] = await db.insert(issueAccessGrants).values({ issueId: task.id, subjectType: "user", subjectId: f.outsider, source: "explicit" }).returning();
    await request(appFor(f.outsider)).get(url).expect(200);
    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
    await request(appFor(f.outsider)).get(url).expect(404);
    await db.delete(issues).where(eq(issues.id, task.id));
    await request(appFor(f.outsider)).get(url).expect(404);
  });

  it("protects attachment assets even after their attachment or task is deleted", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Private", visibility: "private", responsibleUserId: f.owner }).returning();
    const [asset] = await db.insert(assets).values({ companyId: f.company.id, provider: "local_disk", objectKey: `${f.company.id}/issues/${task.id}/file.txt`, contentType: "text/plain", byteSize: 6, sha256: "test" }).returning();
    const { assetRoutes } = await import("../routes/assets.js");
    const appFor = (userId: string) => {
      const app = express();
      app.use((req, _res, next) => { req.actor = f.actor(userId) as Express.Request["actor"]; next(); });
      app.use("/api", assetRoutes(db, { getObject: async () => ({ stream: Readable.from("SECRET"), contentLength: 6 }) } as any));
      return app;
    };
    await request(appFor(f.owner)).get(`/api/assets/${asset.id}/content`).expect(200, "SECRET");
    await request(appFor(f.outsider)).get(`/api/assets/${asset.id}/content`).expect(404);
    await db.delete(issues).where(eq(issues.id, task.id));
    await request(appFor(f.owner)).get(`/api/assets/${asset.id}/content`).expect(404);
  });

  it("live WebSocket delivery does not disclose a private run to an unauthorized member", async () => {
    const f = await fixture();
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId: f.company.id, title: "Private email", visibility: "private", privacyRootIssueId: id, responsibleUserId: f.owner });
    expect((await authorizationService(db).decide({ actor: f.actor(f.outsider), action: "issue:read", resource: { type: "issue", companyId: f.company.id, issueId: id } })).allowed).toBe(false);
    const { setupLiveEventsWebSocketServer } = await import("../realtime/live-events-ws.js");
    const { publishLiveEvent } = await import("../services/live-events.js");
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, db, { deploymentMode: "authenticated", resolveCloudActor: async () => ({ userId: f.outsider, companyIds: [f.company.id] }) });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/companies/${f.company.id}/events/ws`);
    try {
      await once(socket, "open");
      const message = once(socket, "message");
      publishLiveEvent({ companyId: f.company.id, type: "heartbeat.run.log", payload: { issueId: id, runId: randomUUID(), agentId: f.agent.id, chunk: "PRIVATE_EMAIL_CANARY" } });
      const result = await Promise.race([message.then(([data]) => data.toString()), new Promise<string>(resolve => setTimeout(() => resolve(""), 150))]);
      expect(result).not.toContain("PRIVATE_EMAIL_CANARY");
    } finally {
      socket.terminate();
      await new Promise<void>(resolve => (wss as any).close(resolve));
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
