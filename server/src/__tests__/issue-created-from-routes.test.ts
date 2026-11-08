import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("tasks created from an issue", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const sourceId = randomUUID();
  const otherSourceId = randomUUID();
  const agentId = randomUUID();
  const legacyRunId = randomUUID();
  const nativeRunId = randomUUID();
  const taskIdRunId = randomUUID();
  const taskKeyRunId = randomUUID();
  const unrelatedRunId = randomUUID();
  const foreignRunId = randomUUID();
  const missingContextRunId = randomUUID();
  const foreignSourceId = randomUUID();
  const expected = new Set<string>();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-created-from-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Origin", issuePrefix: "ORG", defaultResponsibleUserId: "board-user" },
      { id: otherCompanyId, name: "Other", issuePrefix: "OTH", defaultResponsibleUserId: "board-user" },
    ]);
    const foreignAgentId = randomUUID();
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Coder", role: "engineer", adapterType: "codex_local" },
      { id: foreignAgentId, companyId: otherCompanyId, name: "Other coder", role: "engineer", adapterType: "codex_local" },
    ]);
    await db.insert(issues).values([
      { id: sourceId, companyId, title: "Source", identifier: "ORG-1", issueNumber: 1 },
      { id: otherSourceId, companyId, title: "Other source", identifier: "ORG-2", issueNumber: 2 },
      { id: foreignSourceId, companyId: otherCompanyId, title: "Foreign source", identifier: "OTH-1" },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: legacyRunId, companyId, agentId, contextSnapshot: { issueId: sourceId }, responsibleUserId: "board-user" },
      { id: nativeRunId, companyId, agentId, runtimeMode: "native", nativeIssueId: sourceId, contextSnapshot: { issueId: otherSourceId } },
      { id: taskIdRunId, companyId, agentId, contextSnapshot: { taskId: sourceId } },
      { id: taskKeyRunId, companyId, agentId, contextSnapshot: { taskKey: "ORG-1" } },
      { id: unrelatedRunId, companyId, agentId, contextSnapshot: { issueId: otherSourceId, taskKey: "ORG-1" } },
      { id: foreignRunId, companyId: otherCompanyId, agentId: foreignAgentId, contextSnapshot: { issueId: sourceId } },
      { id: missingContextRunId, companyId, agentId, contextSnapshot: {} },
    ]);
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Cross-project" });
    const rows = [
      { title: "Legacy top-level", originRunId: legacyRunId, projectId },
      { title: "Native child", originRunId: nativeRunId, parentId: sourceId },
      { title: "Different parent", originRunId: taskIdRunId, parentId: otherSourceId },
      { title: "No project, completed", originRunId: taskKeyRunId, status: "done" },
    ].map((row) => ({ id: randomUUID(), companyId, createdByAgentId: agentId, ...row }));
    rows.forEach((row) => expected.add(row.id));
    const historicalId = randomUUID();
    const commentedId = randomUUID();
    expected.add(historicalId);
    await db.insert(issues).values([
      ...rows,
      { id: historicalId, companyId, title: "Historical child helper", parentId: otherSourceId },
      { id: commentedId, companyId, title: "Only commented on by source" },
      { companyId, title: "Manual child", parentId: sourceId },
      { companyId, title: "Same agent, unrelated run", createdByAgentId: agentId, originRunId: unrelatedRunId },
      { companyId, title: "Hidden", originRunId: legacyRunId, hiddenAt: new Date() },
      { companyId, title: "No context", originRunId: missingContextRunId },
      { companyId, title: "Wrong run company", originRunId: foreignRunId },
      { companyId: otherCompanyId, title: "Wrong issue company", originRunId: legacyRunId },
    ]);
    await db.insert(activityLog).values([
      { companyId, actorType: "agent", actorId: agentId, runId: legacyRunId, action: "issue.child_created", entityType: "issue", entityId: historicalId },
      { companyId, actorType: "agent", actorId: agentId, runId: legacyRunId, action: "issue.comment_added", entityType: "issue", entityId: commentedId },
    ]);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  function app() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  it("returns both runners' created tasks, regardless of parent, project or completion", async () => {
    for (const view of [undefined, "compact"]) {
      const result = await request(app()).get(`/api/companies/${companyId}/issues`).query({ createdFromIssueId: sourceId, ...(view ? { view } : {}) });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(new Set(result.body.map((row: { id: string }) => row.id))).toEqual(expected);
    }
  });

  it("keeps cursor pages complete when activity changes or an earlier task disappears", async () => {
    const first = await request(app()).get(`/api/companies/${companyId}/issues`).query({ createdFromIssueId: sourceId, sortField: "id", sortDir: "asc", limit: 2 });
    expect(first.status).toBe(200);
    const sortedIds = [...expected].sort();
    expect(first.body.map((row: { id: string }) => row.id)).toEqual(sortedIds.slice(0, 2));
    await db.update(issues).set({ updatedAt: new Date("2099-01-01"), priority: "critical" }).where(eq(issues.id, sortedIds.at(-1)!));
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, sortedIds[0]!));
    try {
      const remaining = await request(app()).get(`/api/companies/${companyId}/issues`).query({ createdFromIssueId: sourceId, sortField: "id", sortDir: "asc", afterId: first.body.at(-1).id, limit: 500 });
      expect(remaining.status).toBe(200);
      expect(remaining.body.map((row: { id: string }) => row.id)).toEqual(sortedIds.slice(2));
    } finally {
      await db.update(issues).set({ hiddenAt: null }).where(eq(issues.id, sortedIds[0]!));
    }
  });

  it("rejects cursors without matching ID order", async () => {
    for (const query of [{ afterId: sourceId }, { afterId: "bad", sortField: "id", sortDir: "asc" }, { afterId: sourceId, sortField: "id", sortDir: "desc" }, { afterId: sourceId, sortField: "id", sortDir: "asc", offset: 2 }]) {
      const result = await request(app()).get(`/api/companies/${companyId}/issues`).query(query);
      expect(result.status).toBe(422);
    }
  });

  it("does not include manual children in creation provenance", async () => {
    const children = await issueService(db).list(companyId, { parentId: sourceId });
    expect(children.map((row) => row.title)).toContain("Manual child");
    expect(children.map((row) => row.title)).toContain("Native child");
  });

  it("rejects malformed filters and never matches a source from another company", async () => {
    const invalid = await request(app()).get(`/api/companies/${companyId}/issues`).query({ createdFromIssueId: "not-an-id" });
    expect(invalid.status).toBe(422);
    const foreign = await request(app()).get(`/api/companies/${companyId}/issues`).query({ createdFromIssueId: foreignSourceId });
    expect(foreign.status).toBe(200);
    expect(foreign.body).toEqual([]);
  });

  it("saves legacy child-helper creation provenance from the actor run", async () => {
    const created = await issueService(db).createChild(otherSourceId, {
      title: "Created while working on source, under another parent",
      actorRunId: legacyRunId,
      createdByAgentId: agentId,
    });
    expect(created.issue.originRunId).toBe(legacyRunId);
    const matches = await issueService(db).list(companyId, { createdFromIssueId: sourceId });
    expect(matches.map((row) => row.id)).toContain(created.issue.id);
  });
});
