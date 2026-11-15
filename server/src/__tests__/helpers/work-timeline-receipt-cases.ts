import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, documents, documentRevisions, heartbeatRuns, issueComments, issueDocuments, issueThreadInteractions, issues } from "@paperclipai/db";

import { childCreatedByRequest } from "../../services/issue-creation-source.js";
import { issueService } from "../../services/issues.js";
import { createAcceptedPlanDecompositionSchema, createChildIssueSchema } from "@paperclipai/shared";

type Seed = { companyId: string; userId: string; agentAId: string; agentBId: string };
type Fixture = {
  getDb: () => ReturnType<typeof createDb>;
  seedBase: () => Promise<Seed>;
  createApp: (userId?: string, includeIssues?: boolean, actor?: { companyId: string; agentId: string }) => Express;
};

/** Shares the owning suite's real PostgreSQL lifecycle and route actors. */
export function registerTimelineReceiptBoundaryCases(f: Fixture) {
  async function acceptedPlanContext(watchdog = false) {
    const db = f.getDb(); const base = await f.seedBase();
    const sourceId = randomUUID(), documentId = randomUUID(), revisionId = randomUUID();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.companyId, base.companyId));
    await db.insert(issues).values({ id: sourceId, companyId: base.companyId, title: "Approved plan", workMode: "planning",
      status: "in_progress", assigneeAgentId: base.agentAId, createdByUserId: base.userId,
      ...(watchdog ? { originKind: "task_watchdog" } : {}) });
    await db.insert(documents).values({ id: documentId, companyId: base.companyId, title: "Plan", format: "markdown", latestBody: "Plan body", latestRevisionId: revisionId, latestRevisionNumber: 1 });
    await db.insert(documentRevisions).values({ id: revisionId, companyId: base.companyId, documentId, revisionNumber: 1, title: "Plan", format: "markdown", body: "Plan body" });
    await db.insert(issueDocuments).values({ companyId: base.companyId, issueId: sourceId, documentId, key: "plan" });
    await db.insert(issueThreadInteractions).values({ companyId: base.companyId, issueId: sourceId, kind: "request_confirmation", status: "accepted", continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Approve plan?", target: { type: "issue_document", issueId: sourceId, documentId, key: "plan", revisionId, revisionNumber: 1 } },
      result: { version: 1, outcome: "accepted" }, resolvedAt: new Date(), createdByUserId: base.userId, resolvedByUserId: base.userId });
    return { ...base, sourceId, revisionId };
  }

  it("keeps accepted-plan child identities while excluding proven keyed reuse from fresh receipts", async () => {
    const db = f.getDb(); const ctx = await acceptedPlanContext(); const svc = issueService(db);
    const keyed = { title: "Reused plan task", status: "backlog" as const, assigneeAgentId: ctx.agentBId, idempotencyKey: randomUUID() };
    const existing = await svc.createChild(ctx.sourceId, { ...keyed, createdByUserId: ctx.userId });
    const result = await svc.decomposeAcceptedPlan(ctx.sourceId, { acceptedPlanRevisionId: ctx.revisionId,
      children: [keyed, { title: "Fresh plan task", status: "backlog", assigneeAgentId: ctx.agentBId }], actorUserId: ctx.userId });
    expect(result.decomposition.status).toBe("completed");
    expect(result.childIssueIds).toHaveLength(2); expect(result.childIssueIds).toContain(existing.issue.id);
    expect(result.childIssues.map(issue => issue.id)).toEqual(result.childIssueIds);
    expect(result.newlyCreatedIssues).toHaveLength(1);
    expect(result.newlyCreatedIssues[0]!.id).not.toBe(existing.issue.id);
    const publicInput = createAcceptedPlanDecompositionSchema.parse({ acceptedPlanRevisionId: ctx.revisionId,
      children: [{ ...keyed, conversationAgentId: ctx.agentAId, conversationUserId: ctx.userId }] });
    for (const unsupported of ["idempotencyKey", "conversationAgentId", "conversationUserId"]) expect(publicInput.children[0]).not.toHaveProperty(unsupported);
  });

  it("keeps the existing serialized watchdog blocker while supported public plan inputs create a fresh child", async () => {
    const db = f.getDb(); const ctx = await acceptedPlanContext(true); const svc = issueService(db);
    const keyed = { title: "Existing serialized child", status: "todo" as const, assigneeAgentId: ctx.agentBId, idempotencyKey: randomUUID() };
    const existing = await svc.createChild(ctx.sourceId, { ...keyed, createdByUserId: ctx.userId });
    const response = await request(f.createApp(ctx.userId, true)).post(`/api/issues/${ctx.sourceId}/accepted-plan-decompositions`)
      .send({ acceptedPlanRevisionId: ctx.revisionId, children: [keyed] });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.childIssueIds).toHaveLength(1);
    const freshId = response.body.childIssueIds[0];
    expect(freshId).not.toBe(existing.issue.id);
    expect(response.body.newlyCreatedChildIssueIds).toEqual([freshId]);
    expect((await svc.getRelationSummaries(freshId)).blockedBy).toContainEqual(expect.objectContaining({ id: existing.issue.id }));
    const parent = await svc.getById(ctx.sourceId);
    expect(parent!.status).toBe("blocked");
    expect((await svc.getRelationSummaries(ctx.sourceId)).blockedBy).toContainEqual(expect.objectContaining({ id: existing.issue.id }));
    const logs = await db.select().from(activityLog);
    expect(logs.filter(row => row.entityId === existing.issue.id && row.action === "issue.child_created")).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ entityId: freshId, action: "issue.child_created", details: expect.objectContaining({ createdByRequest: true }) }));
    expect(logs).toContainEqual(expect.objectContaining({ action: "issue.accepted_plan_decomposition_updated", details: expect.objectContaining({
      childIssueIds: [freshId], newlyCreatedChildIssueIds: [freshId], currentSerializedChildIssueId: existing.issue.id,
    }) }));
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
  });

  it("projects actual public child creation receipts without admitting unsupported replay keys", async () => {
    const db = f.getDb(); const { companyId, userId, agentAId, agentBId } = await f.seedBase();
    const parentId = randomUUID(), from = new Date(Date.now() - 1000);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.companyId, companyId));
    await db.insert(issues).values({ id: parentId, companyId, title: "Parent", status: "backlog", assigneeAgentId: agentAId, createdByUserId: userId, createdAt: from });
    const body = { title: "Canonical child", status: "backlog", assigneeAgentId: agentBId, idempotencyKey: randomUUID() };
    expect(createChildIssueSchema.parse(body)).not.toHaveProperty("idempotencyKey");
    const created = await request(f.createApp(userId, true, { companyId, agentId: agentAId })).post(`/api/issues/${parentId}/children`).send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id;
    const receipt = (await db.select().from(activityLog).where(eq(activityLog.entityId, id))).find(row => row.action === "issue.child_created")!;
    expect(receipt).toMatchObject({ actorType: "agent", actorId: agentAId, details: { parentId, assigneeAgentId: agentBId, assigneeUserId: null, createdByRequest: true } });
    const response = await request(f.createApp(userId)).get(`/api/companies/${companyId}/timeline`).query({ from: from.toISOString(), to: new Date().toISOString() });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.edges.filter((edge: any) => edge.issueId === id)).toEqual([
      { fromActorId: `agent:${agentAId}`, toActorId: `agent:${agentBId}`, issueId: id, at: receipt.createdAt.toISOString(), kind: "assignment" },
      { fromActorId: `agent:${agentAId}`, toActorId: `agent:${agentBId}`, issueId: id, at: receipt.createdAt.toISOString(), kind: "delegation" },
    ]);
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
  });

  it("keeps private-service replay facts separate from original child ownership, including missing originals", async () => {
    const db = f.getDb(); const { companyId, userId, agentAId, agentBId } = await f.seedBase(); const svc = issueService(db);
    const parentId = randomUUID(), laterAgentId = randomUUID(), from = new Date(Date.now() - 1000);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.companyId, companyId));
    await db.insert(agents).values({ id: laterAgentId, companyId, name: "Later worker", adapterType: "codex_local", status: "paused" });
    await db.insert(issues).values({ id: parentId, companyId, title: "Private service parent", status: "backlog", createdByUserId: userId, createdAt: from });
    const body = { title: "Keyed private child", status: "backlog" as const, assigneeAgentId: agentBId, createdByAgentId: agentAId, idempotencyKey: randomUUID() };
    const proposed = randomUUID(); const created = await svc.createChild(parentId, { ...body, id: proposed });
    expect(created.issue.id).toBe(proposed);
    const firstAt = new Date();
    const [first] = await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentAId, action: "issue.child_created", entityType: "issue", entityId: created.issue.id, createdAt: firstAt,
      details: { parentId, assigneeAgentId: created.issue.assigneeAgentId, assigneeUserId: created.issue.assigneeUserId, createdByRequest: childCreatedByRequest(proposed, created.issue.id) } }).returning();
    const boardApp = f.createApp(userId, true);
    const changed = await request(boardApp).patch(`/api/issues/${created.issue.id}`).send({ assigneeAgentId: laterAgentId });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const replayProposal = randomUUID(); const replayed = await svc.createChild(parentId, { ...body, id: replayProposal });
    expect(replayed.issue.id).toBe(created.issue.id); expect(replayed.issue.id).not.toBe(replayProposal);
    expect(replayed.issue.assigneeAgentId).toBe(laterAgentId);
    const replayAt = new Date();
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentAId, action: "issue.child_created", entityType: "issue", entityId: replayed.issue.id, createdAt: replayAt,
      details: { parentId, assigneeAgentId: replayed.issue.assigneeAgentId, assigneeUserId: replayed.issue.assigneeUserId, createdByRequest: childCreatedByRequest(replayProposal, replayed.issue.id) } });
    const timeline = async (start: Date) => {
      const response = await request(boardApp).get(`/api/companies/${companyId}/timeline`).query({ from: start.toISOString(), to: new Date().toISOString() });
      expect(response.status, JSON.stringify(response.body)).toBe(200); return response.body;
    };
    const full = await timeline(from);
    expect(full.edges.filter((edge: any) => edge.issueId === created.issue.id && edge.kind === "delegation")).toEqual([
      { fromActorId: `agent:${agentAId}`, toActorId: `agent:${agentBId}`, issueId: created.issue.id, at: firstAt.toISOString(), kind: "delegation" },
    ]);
    expect(full.edges.filter((edge: any) => edge.issueId === created.issue.id && edge.kind === "assignment")).toHaveLength(2);
    expect(first!.details).toMatchObject({ createdByRequest: true });
    expect(childCreatedByRequest(replayProposal, replayed.issue.id)).toBe(false);
    await db.delete(activityLog).where(eq(activityLog.id, first!.id));
    for (const start of [from, replayAt]) {
      const view = await timeline(start);
      expect(view.edges.some((edge: any) => edge.issueId === created.issue.id && edge.fromActorId === `agent:${agentAId}`)).toBe(false);
      expect(view.events.some((event: any) => event.issueId === created.issue.id && event.kind === "delegated")).toBe(false);
    }
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
  });

  it.each(["missing", "malformed"])("does not rescue an unknown earliest bounded child receipt (%s) with a later receipt", async kind => {
    const db = f.getDb(); const { companyId, userId, agentAId, agentBId } = await f.seedBase();
    const parentId = randomUUID(), childId = randomUUID();
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Parent", status: "done", createdByUserId: userId, createdAt: new Date("2026-03-01T10:00:00Z") },
      { id: childId, companyId, parentId, title: "Child", status: "done", createdAt: new Date("2026-03-01T11:00:00Z") },
    ]);
    const details = { parentId, createdByRequest: true, assigneeAgentId: agentBId, assigneeUserId: null };
    await db.insert(activityLog).values([
      { companyId, actorType: "agent", actorId: agentAId, action: "issue.child_created", entityType: "issue", entityId: childId, createdAt: new Date("2026-03-01T11:00:00Z"), details: kind === "missing" ? { parentId, createdByRequest: true } : { ...details, assigneeAgentId: 42 } },
      { companyId, actorType: "agent", actorId: agentAId, action: "issue.child_created", entityType: "issue", entityId: childId, createdAt: new Date("2026-03-01T12:00:00Z"), details },
    ]);
    const response = await request(f.createApp()).get(`/api/companies/${companyId}/timeline`).query({ from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" });
    expect(response.status).toBe(200); expect(response.body.edges).toEqual([]);
  });

  it.each([undefined, false, "true"])("does not treat an unproven child receipt as creation: %j", async flag => {
    const db = f.getDb(); const { companyId, userId, agentAId, agentBId } = await f.seedBase();
    const parentId = randomUUID(), childId = randomUUID(), at = new Date("2026-03-01T11:00:00Z");
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Parent", status: "done", createdByUserId: userId, createdAt: new Date("2026-03-01T10:00:00Z") },
      { id: childId, parentId, companyId, title: "Child", status: "done", createdByAgentId: agentAId, createdAt: at },
    ]);
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentAId, action: "issue.child_created", entityType: "issue", entityId: childId, createdAt: at,
      details: { parentId, assigneeAgentId: agentBId, assigneeUserId: null, ...(flag === undefined ? {} : { createdByRequest: flag }) } });
    const response = await request(f.createApp()).get(`/api/companies/${companyId}/timeline`).query({ from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" });
    expect(response.status).toBe(200); expect(response.body.edges).toEqual([]);
  });

  it.each(["actor", "target"] as const)("keeps valid active same-company user %s facts", async role => {
    const db = f.getDb(); const { companyId, userId, agentAId, agentBId } = await f.seedBase();
    const id = randomUUID(), at = new Date("2026-03-01T11:00:00Z");
    await db.insert(issues).values({ id, companyId, title: "Valid user facts", status: "done", createdByUserId: userId, createdAt: at });
    await db.insert(activityLog).values({ companyId, actorType: role === "actor" ? "user" : "agent", actorId: role === "actor" ? userId : agentAId,
      action: "issue.created", entityType: "issue", entityId: id, createdAt: at, details: { parentId: null,
        assigneeAgentId: role === "target" ? null : agentBId, assigneeUserId: role === "target" ? userId : null } });
    const response = await request(f.createApp()).get(`/api/companies/${companyId}/timeline`).query({ from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" });
    expect(response.status).toBe(200); expect(response.body.edges).toHaveLength(1);
    expect(response.body.actors).toContainEqual(expect.objectContaining({ id: `user:${userId}`, name: "User One" }));
  });

  it.each(["foreign-actor", "foreign-target", "inactive-actor", "inactive-target", "resolver"] as const)("does not expose out-of-bound user identity through %s", async kind => {
    const db = f.getDb(); const { companyId, userId, agentAId, agentBId } = await f.seedBase();
    const foreignCompanyId = randomUUID(), privateUserId = randomUUID(), id = randomUUID(), at = new Date("2026-03-01T11:00:00Z");
    await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign user company", issuePrefix: "FU" });
    await db.insert(authUsers).values({ id: privateUserId, name: "Foreign private name", image: "https://private.example/avatar", email: `${privateUserId}@example.test`, emailVerified: true, createdAt: at, updatedAt: at });
    await db.insert(companyMemberships).values({ companyId: kind.startsWith("inactive") ? companyId : foreignCompanyId,
      principalType: "user", principalId: privateUserId, status: kind.startsWith("inactive") ? "inactive" : "active", membershipRole: "operator" });
    await db.insert(issues).values({ id, companyId, title: "Scoped user facts", status: "done", createdByUserId: kind === "resolver" ? privateUserId : userId, createdAt: at });
    const actor = kind.endsWith("actor"); const target = kind.endsWith("target");
    if (kind === "resolver") {
      await db.insert(issueComments).values({ companyId, issueId: id, authorUserId: privateUserId, body: "Recorded comment", createdAt: at });
    } else {
      await db.insert(activityLog).values({ companyId, actorType: actor ? "user" : "agent", actorId: actor ? privateUserId : agentAId,
        action: "issue.created", entityType: "issue", entityId: id, createdAt: at,
        details: { parentId: null, assigneeAgentId: target ? null : agentBId, assigneeUserId: target ? privateUserId : null } });
    }
    const response = await request(f.createApp()).get(`/api/companies/${companyId}/timeline`).query({ from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const json = JSON.stringify(response.body);
    for (const secret of [privateUserId, "Foreign private name", "https://private.example/avatar"]) expect(json).not.toContain(secret);
    const actorIds = new Set(response.body.actors.map((row: any) => row.id));
    expect(response.body.events.every((row: any) => actorIds.has(row.actorId))).toBe(true);
    expect(response.body.edges.every((row: any) => actorIds.has(row.fromActorId) && actorIds.has(row.toActorId))).toBe(true);
  });

  it.each(["foreign-actor", "missing-actor", "foreign-target", "missing-target", "resolver"] as const)("does not expose out-of-bound agent identity through %s", async kind => {
    const db = f.getDb(); const { companyId, userId, agentAId, agentBId } = await f.seedBase();
    const foreignCompanyId = randomUUID(), privateAgentId = randomUUID(), id = randomUUID(), at = new Date("2026-03-01T11:00:00Z");
    await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign agent company", issuePrefix: "FA" });
    if (!kind.startsWith("missing")) await db.insert(agents).values({ id: privateAgentId, companyId: foreignCompanyId, name: "Foreign private agent", adapterType: "codex_local", status: "paused" });
    await db.insert(issues).values({ id, companyId, title: "Scoped agent facts", status: "done", createdByAgentId: kind === "resolver" ? privateAgentId : agentAId, createdAt: at });
    if (kind === "resolver") {
      await db.insert(issueComments).values({ companyId, issueId: id, authorAgentId: privateAgentId, body: "Recorded comment", createdAt: at });
      await db.insert(heartbeatRuns).values({ companyId, agentId: privateAgentId, status: "succeeded", invocationSource: "assignment", contextSnapshot: { issueId: id }, createdAt: at, startedAt: at, finishedAt: at });
    } else {
      await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: kind.endsWith("actor") ? privateAgentId : agentAId,
        action: "issue.updated", entityType: "issue", entityId: id, createdAt: at,
        details: { assigneeAgentId: kind.endsWith("target") ? privateAgentId : agentBId } });
    }
    // Valid company-local assignment/run remains visible beside rejected facts.
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentAId, action: "issue.updated", entityType: "issue", entityId: id, createdAt: at, details: { assigneeAgentId: agentBId } });
    const [validRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: agentBId, status: "succeeded", invocationSource: "assignment", contextSnapshot: { issueId: id }, createdAt: at, startedAt: at, finishedAt: at }).returning();
    const response = await request(f.createApp(userId)).get(`/api/companies/${companyId}/timeline`).query({ from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const json = JSON.stringify(response.body);
    for (const secret of [privateAgentId, "Foreign private agent"]) expect(json).not.toContain(secret);
    expect(response.body.edges).toContainEqual(expect.objectContaining({ fromActorId: `agent:${agentAId}`, toActorId: `agent:${agentBId}`, kind: "assignment" }));
    expect(response.body.spans).toContainEqual(expect.objectContaining({ runId: validRun!.id, actorId: `agent:${agentBId}` }));
    const actorIds = new Set(response.body.actors.map((row: any) => row.id));
    expect(response.body.events.every((row: any) => actorIds.has(row.actorId))).toBe(true);
    expect(response.body.spans.every((row: any) => actorIds.has(row.actorId))).toBe(true);
    expect(response.body.edges.every((row: any) => actorIds.has(row.fromActorId) && actorIds.has(row.toActorId))).toBe(true);
  });

}
