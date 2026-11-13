import { randomUUID } from "node:crypto";
import { and, sql, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentCommentary, agentCommentaryVotes, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueAccessGrants, issues, principalPermissionGrants } from "@paperclipai/db";
import { agentCommentaryQuerySchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentCommentaryReader } from "../services/agent-commentary-reader.js";
import { agentCommentaryRoutes } from "../routes/agent-commentary.js";
import { errorHandler } from "../middleware/error-handler.js";
import { accessService } from "../services/access.js";
import { activityService } from "../services/activity.js";
import { issueReadSqlCondition } from "../services/authorization.js";
import { grantsForHumanRole } from "../services/company-member-roles.js";

describe("agent commentary browsing", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let reader: ReturnType<typeof agentCommentaryReader>;
  const companyId = randomUUID(), foreignCompanyId = randomUUID();
  const firstAgentId = randomUUID(), secondAgentId = randomUUID();
  const visibleTaskId = randomUUID(), privateTaskId = randomUUID();
  const firstId = randomUUID(), secondId = randomUUID(), privateId = randomUUID(), foreignId = randomUUID();
  const longBody = "Preserve evidence history. " + "A useful observation. ".repeat(100);
  const query = (values: object = {}) => agentCommentaryQuerySchema.parse(values);

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-commentary-reader-");
    db = createDb(temporary.connectionString);
    reader = agentCommentaryReader(db);
    await db.insert(companies).values([
      { id: companyId, name: "Feedback fixtures", issuePrefix: "FDB" },
      { id: foreignCompanyId, name: "Other company", issuePrefix: "OTH" },
    ]);
    await db.insert(agents).values([
      { id: firstAgentId, companyId, name: "Writer", role: "engineer", adapterType: "codex_local" },
      { id: secondAgentId, companyId, name: "Reviewer", role: "engineer", adapterType: "claude_local" },
      { id: foreignCompanyId, companyId: foreignCompanyId, name: "Other writer", role: "engineer", adapterType: "codex_local" },
    ]);
    await db.insert(issues).values([
      { id: visibleTaskId, companyId, title: "Visible task", identifier: "FDB-1" },
      { id: privateTaskId, companyId, title: "Private task", identifier: "FDB-2" },
    ]);
    const runId = randomUUID(), foreignRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId: firstAgentId, status: "succeeded" },
      { id: foreignRunId, companyId: foreignCompanyId, agentId: foreignCompanyId, status: "succeeded" },
    ]);
    await db.insert(agentCommentary).values([
      { id: firstId, companyId, agentId: firstAgentId, runId, issueId: visibleTaskId, kind: "suggestion", body: longBody, idempotencyKey: "first", payloadHash: "hash", createdAt: new Date("2026-01-03T12:00:00Z") },
      { id: secondId, companyId, agentId: secondAgentId, runId, issueId: visibleTaskId, kind: "complaint", body: "Installer failed at 100% completion with literal_under_score.", idempotencyKey: "second", payloadHash: "hash", createdAt: new Date("2026-01-02T12:00:00Z") },
      { id: privateId, companyId, agentId: firstAgentId, runId, issueId: privateTaskId, kind: "suggestion", body: "Private task feedback", idempotencyKey: "private", payloadHash: "hash", createdAt: new Date("2026-01-01T12:00:00Z") },
      { id: foreignId, companyId: foreignCompanyId, agentId: foreignCompanyId, runId: foreignRunId, kind: "complaint", body: "Other company feedback", idempotencyKey: "foreign", payloadHash: "hash" },
    ]);
  }, 90_000);
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(() => vi.unstubAllEnvs());

  it("bounds previews and pagination while details retain the full message", async () => {
    const page = await reader.list(companyId, query({ limit: 1 }), sql`true`);
    expect(page).toMatchObject({ total: 3, limit: 1, offset: 0 });
    expect(page.items[0]).toMatchObject({ id: firstId, agent: { name: "Writer" }, task: { identifier: "FDB-1" } });
    expect(page.items[0].preview).toHaveLength(280);
    expect(page.items[0]).not.toHaveProperty("body");
    expect((await reader.get(companyId, firstId, sql`true`))?.body).toBe(longBody);
    expect((await reader.list(companyId, query({ limit: 1, offset: 1 }), sql`true`)).items[0].kind).toBe("complaint");
  });

  it("loads 50 messages by default and retrieves the remaining page without duplicates", async () => {
    const pagedCompanyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: pagedCompanyId, name: "Pagination fixtures", issuePrefix: "PAG" });
    await db.insert(agents).values({ id: agentId, companyId: pagedCompanyId, name: "Writer", role: "engineer", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: pagedCompanyId, agentId, status: "succeeded" });
    await db.insert(agentCommentary).values(Array.from({ length: 58 }, (_, index) => ({
      companyId: pagedCompanyId, agentId, runId, kind: "suggestion" as const, body: `Message ${index}`,
      idempotencyKey: String(index), payloadHash: "hash",
    })));
    const first = await reader.list(pagedCompanyId, query(), sql`true`);
    const second = await reader.list(pagedCompanyId, query({ offset: 50 }), sql`true`);
    expect(first).toMatchObject({ total: 58, limit: 50, offset: 0 });
    expect(first.items).toHaveLength(50);
    expect(second).toMatchObject({ total: 58, limit: 50, offset: 50 });
    expect(second.items).toHaveLength(8);
    expect(new Set([...first.items, ...second.items].map((entry) => entry.id)).size).toBe(58);
  });

  it("combines filters and searches literal SQL wildcard characters", async () => {
    expect((await reader.list(companyId, query({ agentId: firstAgentId, kind: "complaint" }), sql`true`)).total).toBe(0);
    expect((await reader.list(companyId, query({ kind: "complaint", q: "100%" }), sql`true`)).total).toBe(1);
    expect((await reader.list(companyId, query({ q: "literal_under_score" }), sql`true`)).total).toBe(1);
    expect((await reader.list(companyId, query({ q: "nothing_here" }), sql`true`)).total).toBe(0);
  });

  it("applies source-task visibility to counts, previews and details and isolates companies", async () => {
    const page = await reader.list(companyId, query(), eq(issues.id, visibleTaskId));
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.id)).not.toContain(privateId);
    expect(await reader.get(companyId, privateId, eq(issues.id, visibleTaskId))).toBeNull();
    expect(await reader.get(companyId, foreignId, sql`true`)).toBeNull();
    expect((await reader.list(companyId, query(), sql`true`)).items.map((item) => item.id)).not.toContain(foreignId);
  });

  it.each(["legacy", "native"])("keeps %s feedback hidden after its source task is deleted", async (transport) => {
    const taskId = randomUUID(), runId = randomUUID(), id = randomUUID();
    await db.insert(issues).values({ id: taskId, companyId, title: "Deleted private task" });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: firstAgentId, status: "succeeded",
      ...(transport === "native" ? { nativeIssueId: taskId } : { contextSnapshot: { issueId: taskId } }),
    });
    await db.insert(agentCommentary).values({
      id, companyId, agentId: firstAgentId, runId, issueId: taskId, kind: "complaint",
      body: "Deleted private task feedback", idempotencyKey: "deleted", payloadHash: "hash",
    });
    await db.delete(issues).where(eq(issues.id, taskId));
    expect(await reader.get(companyId, id, eq(issues.id, visibleTaskId))).toBeNull();
    expect((await reader.list(companyId, query({ q: "Deleted private task feedback" }), eq(issues.id, visibleTaskId))).total).toBe(0);
  });

  it("enforces board membership, commentary permission and filter bounds at the HTTP boundary", async () => {
    let actor: Record<string, unknown> = { type: "board", source: "local_implicit", userId: "operator" };
    const app = express();
    app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
    app.use("/api", agentCommentaryRoutes(db));
    app.use(errorHandler);
    const url = `/api/companies/${companyId}/agent-commentary`;
    expect((await request(app).get(url)).body.total).toBe(3);
    expect((await request(app).get(`${url}/${firstId}`)).body.body).toBe(longBody);
    expect((await request(app).get(`${url}/${foreignId}`)).status).toBe(404);
    for (const filters of ["limit=101", "offset=-1", "kind=other", "agentId=bad-id"]) {
      expect((await request(app).get(`${url}?${filters}`)).status).toBe(400);
    }
    // Agents read only their own commentary unless granted commentary:view.
    actor = { type: "agent", companyId, agentId: firstAgentId };
    expect((await request(app).get(url)).status).toBe(403);
    expect((await request(app).get(`${url}/${firstId}`)).status).toBe(200);
    actor = { type: "agent", companyId, agentId: secondAgentId };
    expect((await request(app).get(`${url}/${firstId}`)).status).toBe(403);
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: secondAgentId, status: "active", membershipRole: "member" }).onConflictDoNothing();
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: secondAgentId, permissionKey: "commentary:view" });
    try {
      expect((await request(app).get(`${url}/${firstId}`)).status).toBe(200);
      expect((await request(app).get(url)).status).toBe(200);
    } finally {
      await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, secondAgentId));
      await db.delete(companyMemberships).where(eq(companyMemberships.principalId, secondAgentId));
    }
    actor = { type: "board", source: "session", userId: "viewer", companyIds: [companyId] };
    const denied = await request(app).get(url).expect(403);
    expect(denied.body.error).toContain("commentary:view");
    await request(app).get(`${url}/${firstId}`).expect(403);
    actor = { type: "board", source: "session", userId: "operator", isInstanceAdmin: true, companyIds: [foreignCompanyId] };
    expect((await request(app).get(url)).status).toBe(403);
  });
  it.each(["owner", "admin", "operator", "viewer"] as const)("lets a default %s read commentary independently of audit access", async (role) => {
    const userId = randomUUID();
    const access = accessService(db);
    await access.ensureMembership(companyId, "user", userId, role);
    await access.setPrincipalGrants(companyId, "user", userId, grantsForHumanRole(role), null);
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId, companyIds: [companyId] };
      next();
    });
    app.use("/api", agentCommentaryRoutes(db));
    app.use(errorHandler);
    const url = `/api/companies/${companyId}/agent-commentary`;
    expect((await request(app).get(url).expect(200)).body.total).toBe(3);
    expect((await request(app).get(`${url}/${firstId}`).expect(200)).body.body).toBe(longBody);
    await expect(access.canUser(companyId, userId, "audit:view_agent_actions")).resolves.toBe(role === "operator");
    await request(app).get(`/api/companies/${foreignCompanyId}/agent-commentary`).expect(403);
    await request(app).get(`${url}/${foreignId}`).expect(404);

    await access.setPrincipalGrants(companyId, "user", userId, [
      { permissionKey: "audit:view_agent_actions", scope: null },
    ], null);
    expect((await request(app).get(url).expect(403)).body.error).toContain("commentary:view");
    await request(app).get(`${url}/${firstId}`).expect(403);
  });

  it("applies actual task privacy to HTTP previews, counts, searches and details for commentary-authorized board users", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    const userId = randomUUID(), ownerId = randomUUID();
    await db.insert(authUsers).values([userId, ownerId].map((id) => ({
      id, name: "Board user", email: `${id}@example.test`, emailVerified: true,
      createdAt: new Date(), updatedAt: new Date(),
    })));
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "viewer",
    });
    await db.insert(principalPermissionGrants).values({
      companyId, principalType: "user", principalId: userId, permissionKey: "commentary:view",
    });
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: privateTaskId, responsibleUserId: ownerId }).where(eq(issues.id, privateTaskId));
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId, companyIds: [companyId] };
      next();
    });
    app.use("/api", agentCommentaryRoutes(db));
    app.use(errorHandler);
    const url = `/api/companies/${companyId}/agent-commentary`;
    const deniedPage = await request(app).get(url).expect(200);
    expect(deniedPage.body.total).toBe(2);
    expect(deniedPage.body.items.map((entry: { id: string }) => entry.id)).not.toContain(privateId);
    expect((await request(app).get(url).query({ q: "Private task feedback" }).expect(200)).body).toMatchObject({ total: 0, items: [] });
    await request(app).get(`${url}/${privateId}`).expect(404);
    await request(app).put(`${url}/${privateId}/vote`).expect(404);
    await request(app).delete(`${url}/${privateId}/vote`).expect(404);

    const [grant] = await db.insert(issueAccessGrants).values({
      issueId: privateTaskId, subjectType: "user", subjectId: userId, source: "explicit", grantedByUserId: ownerId,
    }).returning();
    const grantedPage = await request(app).get(url).expect(200);
    expect(grantedPage.body.total).toBe(3);
    expect(grantedPage.body.items.map((entry: { id: string }) => entry.id)).toContain(privateId);
    expect((await request(app).get(`${url}/${privateId}`).expect(200)).body.body).toBe("Private task feedback");
    expect((await request(app).put(`${url}/${privateId}/vote`).expect(200)).body).toEqual({ id: privateId, voteCount: 1, votedByMe: true });

    const voteHistory = async () => (await activityService(db).list({
      companyId, entityType: "agent_commentary", entityId: privateId,
      readCondition: await issueReadSqlCondition(db, { type: "board", source: "session", userId, companyIds: [companyId] }),
    })).map((row) => row.action);
    expect(await voteHistory()).toContain("agent.commentary_upvoted");

    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
    expect(await voteHistory()).toEqual([]);
    expect((await request(app).get(url).expect(200)).body.total).toBe(2);
    await request(app).get(`${url}/${privateId}`).expect(404);
    await request(app).delete(`${url}/${privateId}/vote`).expect(404);
    await db.delete(agentCommentaryVotes).where(eq(agentCommentaryVotes.commentaryId, privateId));
    await db.update(agentCommentary).set({ voteCount: 0 }).where(eq(agentCommentary.id, privateId));
  });

  it("counts one upvote per person, removes it, repeats safely and sorts by votes", async () => {
    let actor: Record<string, unknown> = { type: "board", source: "local_implicit", userId: "operator" };
    const app = express();
    app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
    app.use("/api", agentCommentaryRoutes(db));
    app.use(errorHandler);
    const url = `/api/companies/${companyId}/agent-commentary`;
    const ids = async (path: string) => (await request(app).get(path).expect(200)).body.items.map((entry: { id: string }) => entry.id);
    const newest = await ids(url);
    expect(newest[0]).toBe(firstId);
    expect((await request(app).get(url).expect(200)).body.items.every((entry: { voteCount: number; votedByMe: boolean }) => entry.voteCount === 0 && !entry.votedByMe)).toBe(true);

    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await request(app).put(`${url}/${secondId}/vote`).expect(200)).body).toEqual({ id: secondId, voteCount: 1, votedByMe: true });
    }
    actor = { type: "board", source: "local_implicit", userId: "second-person" };
    expect((await request(app).put(`${url}/${secondId}/vote`).expect(200)).body).toEqual({ id: secondId, voteCount: 2, votedByMe: true });
    expect((await request(app).put(`${url}/${privateId}/vote`).expect(200)).body).toEqual({ id: privateId, voteCount: 1, votedByMe: true });
    expect(await ids(`${url}?sort=votes`)).toEqual([secondId, privateId, firstId]);
    expect(await ids(url)).toEqual(newest);
    expect((await request(app).get(`${url}?sort=other`)).status).toBe(400);

    actor = { type: "board", source: "local_implicit", userId: "operator" };
    expect((await request(app).get(`${url}/${secondId}`).expect(200)).body).toMatchObject({ voteCount: 2, votedByMe: true });
    expect((await request(app).get(`${url}/${privateId}`).expect(200)).body).toMatchObject({ voteCount: 1, votedByMe: false });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await request(app).delete(`${url}/${secondId}/vote`).expect(200)).body).toEqual({ id: secondId, voteCount: 1, votedByMe: false });
    }
    expect((await request(app).get(url).expect(200)).body.items.find((entry: { id: string }) => entry.id === secondId)).toMatchObject({ voteCount: 1, votedByMe: false });

    await request(app).put(`${url}/${foreignId}/vote`).expect(404);
    await request(app).put(`${url}/not-a-uuid/vote`).expect(404);
    actor = { type: "agent", companyId, agentId: secondAgentId };
    expect((await request(app).get(`${url}?agentId=${secondAgentId}`).expect(200)).body.items[0]).toMatchObject({ id: secondId, voteCount: 1, votedByMe: false });
    expect((await request(app).get(`${url}/${secondId}`).expect(200)).body).toMatchObject({ voteCount: 1, votedByMe: false });
    await request(app).put(`${url}/${secondId}/vote`).expect(403);
    actor = { type: "agent", companyId, agentId: firstAgentId };
    await request(app).put(`${url}/${secondId}/vote`).expect(403);
    actor = { type: "board", source: "session", userId: "viewer", companyIds: [companyId] };
    expect((await request(app).put(`${url}/${secondId}/vote`).expect(403)).body.error).toContain("commentary:view");
    await request(app).delete(`${url}/${secondId}/vote`).expect(403);
    actor = {
      type: "board", source: "session", userId: "company-viewer", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "viewer", status: "active" }],
    };
    expect((await request(app).put(`${url}/${secondId}/vote`).expect(403)).body.error).toBe("Viewer access is read-only");
    await request(app).delete(`${url}/${secondId}/vote`).expect(403);
    actor = { type: "board", source: "session", userId: "operator", isInstanceAdmin: true, companyIds: [foreignCompanyId] };
    await request(app).put(`${url}/${secondId}/vote`).expect(403);
    expect(await db.select().from(agentCommentaryVotes).where(eq(agentCommentaryVotes.commentaryId, secondId))).toHaveLength(1);
    const voteActivity = async (action: string) => (await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, secondId), eq(activityLog.action, action))));
    expect((await voteActivity("agent.commentary_upvoted")).map((row) => row.actorId).sort()).toEqual(["operator", "second-person"]);
    expect((await voteActivity("agent.commentary_upvote_removed")).map((row) => row.details)).toEqual([{ userId: "operator" }]);

    await db.delete(agentCommentaryVotes);
    await db.update(agentCommentary).set({ voteCount: 0 });
  });

  it("deletes votes with their message", async () => {
    const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).limit(1);
    const id = randomUUID();
    await db.insert(agentCommentary).values({ id, companyId, agentId: firstAgentId, runId: run.id, kind: "suggestion", body: "Short-lived", idempotencyKey: "short-lived", payloadHash: "hash" });
    await reader.setVote(companyId, id, sql`true`, "operator", true, { actorType: "user", actorId: "operator" });
    expect(await db.select().from(agentCommentaryVotes).where(eq(agentCommentaryVotes.commentaryId, id))).toHaveLength(1);
    await db.delete(agentCommentary).where(eq(agentCommentary.id, id));
    expect(await db.select().from(agentCommentaryVotes).where(eq(agentCommentaryVotes.commentaryId, id))).toHaveLength(0);
  });
});
