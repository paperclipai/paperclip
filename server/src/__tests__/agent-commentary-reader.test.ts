import { randomUUID } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentCommentary, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueAccessGrants, issues, principalPermissionGrants } from "@paperclipai/db";
import { agentCommentaryQuerySchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentCommentaryReader } from "../services/agent-commentary-reader.js";
import { agentCommentaryRoutes } from "../routes/agent-commentary.js";
import { errorHandler } from "../middleware/error-handler.js";
import { accessService } from "../services/access.js";
import { grantsForHumanRole } from "../services/company-member-roles.js";

describe("agent commentary browsing", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let reader: ReturnType<typeof agentCommentaryReader>;
  const companyId = randomUUID(), foreignCompanyId = randomUUID();
  const firstAgentId = randomUUID(), secondAgentId = randomUUID();
  const visibleTaskId = randomUUID(), privateTaskId = randomUUID();
  const firstId = randomUUID(), privateId = randomUUID(), foreignId = randomUUID();
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
      { id: randomUUID(), companyId, agentId: secondAgentId, runId, issueId: visibleTaskId, kind: "complaint", body: "Installer failed at 100% completion with literal_under_score.", idempotencyKey: "second", payloadHash: "hash", createdAt: new Date("2026-01-02T12:00:00Z") },
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
      companyId: pagedCompanyId, agentId, runId, kind: "suggestion", body: `Message ${index}`,
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
    actor = { type: "agent", companyId, agentId: firstAgentId };
    expect((await request(app).get(url)).status).toBe(403);
    expect((await request(app).get(`${url}/${firstId}`)).status).toBe(403);
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

    const [grant] = await db.insert(issueAccessGrants).values({
      issueId: privateTaskId, subjectType: "user", subjectId: userId, source: "explicit", grantedByUserId: ownerId,
    }).returning();
    const grantedPage = await request(app).get(url).expect(200);
    expect(grantedPage.body.total).toBe(3);
    expect(grantedPage.body.items.map((entry: { id: string }) => entry.id)).toContain(privateId);
    expect((await request(app).get(`${url}/${privateId}`).expect(200)).body.body).toBe("Private task feedback");

    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
    expect((await request(app).get(url).expect(200)).body.total).toBe(2);
    await request(app).get(`${url}/${privateId}`).expect(404);
  });

});
