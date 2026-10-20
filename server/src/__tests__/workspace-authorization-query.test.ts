import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { agents, authUsers, companies, companyMemberships, createDb, executionWorkspaces, executionWorkspaceRepositoryAccess, heartbeatRuns, issueAccessGrants,
  issues, projects, projectAccessMembers, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { authorizationService, executionWorkspaceReadSqlCondition, type AuthorizationActor } from "../services/authorization.js";
import { executionWorkspaceRepositoryService } from "../services/execution-workspace-repositories.js";
import { assertExecutionWorkspaceRecordAccess } from "../services/task-workspace-access.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("workspace authorization query", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), workspaceId = randomUUID(), runId = randomUUID();
  const sourceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId, agentId, runId, onBehalfOfUserId: userId };

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    database = await startEmbeddedPostgresTestDatabase("workspace-authorization-query-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Workspace authorization", issuePrefix: "WAQ" });
    await db.insert(authUsers).values({ id: userId, name: "Sponsor", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, name: "Retained files", mode: "shared_workspace", strategyType: "operator_directory" });
    await db.$client.unsafe(`insert into issues (company_id, title) select $1, 'Unrelated history ' || n from generate_series(1, 1200) n`, [companyId]);
    await db.insert(issues).values({ id: sourceId, companyId, title: "Retained source" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", contextSnapshot: { issueId: sourceId } });
    await db.$client.unsafe("ANALYZE");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function query() {
    return db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, workspaceId),
      eq(executionWorkspaces.companyId, companyId), await executionWorkspaceReadSqlCondition(db, actor))).toSQL();
  }
  async function read() {
    const q = await query();
    return db.$client.unsafe(q.sql, q.params as never[]);
  }
  async function retain(id: string) {
    // Seed historical/corrupt provenance in this disposable database. Normal
    // writes have a trigger that deliberately preserves the previous keys.
    await db.transaction(async tx => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.update(executionWorkspaces).set({ metadata: { _issuePrivacySources: { [id]: true } } })
        .where(eq(executionWorkspaces.id, workspaceId));
    });
  }

  it("checks retained task IDs without evaluating privacy for unrelated company history", async () => {
    await retain(sourceId);
    expect(await read()).toHaveLength(1);
    const q = await query();
    const [result] = await db.$client.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${q.sql}`, q.params as never[]);
    type Plan = { "Node Type": string; "Actual Loops": number; Plans?: Plan[] };
    function privacyTraversals(plan: Plan): number {
      return (plan["Node Type"] === "Recursive Union" ? plan["Actual Loops"] : 0)
        + (plan.Plans ?? []).reduce((sum, child) => sum + privacyTraversals(child), 0);
    }
    // A single source should not make admission authorize 1,200 unrelated tasks
    // for both the agent and its responsible user under the company-wide lock.
    expect(privacyTraversals(result["QUERY PLAN"][0].Plan)).toBeLessThan(100);
  });

  it("enumerates attached and retained source tasks without scanning unrelated history", async () => {
    await retain(sourceId);
    const [attached] = await db.insert(issues).values({ companyId, title: "Attached source", executionWorkspaceId: workspaceId })
      .returning({ id: issues.id });
    try {
      const statements: Array<{ sql: string; params: unknown[] }> = [];
      const recorded = drizzle(db.$client, {
        schema: db._.fullSchema,
        logger: { logQuery: (query, params) => statements.push({ sql: query, params }) },
      }) as unknown as typeof db;
      await assertExecutionWorkspaceRecordAccess(recorded, { type: "board", source: "local_implicit", userId: "local-board" }, companyId, workspaceId);
      const query = statements.find(statement => statement.sql.startsWith('select "id" from "issues"')
        && statement.sql.includes('"execution_workspace_id"'));
      expect(query).toBeDefined();
      const rows = await db.$client.unsafe(query!.sql, query!.params as never[]);
      expect(rows.map(row => row.id).sort()).toEqual([attached.id, sourceId].sort());
      for (const invalidId of [sourceId.toUpperCase(), "not-a-uuid"]) {
        const params = query!.params.map(value => value === sourceId ? invalidId : value);
        const noncanonical = await db.$client.unsafe(query!.sql, params as never[]);
        expect(noncanonical.map(row => row.id)).toEqual([attached.id]);
      }
      const [result] = await db.$client.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${query!.sql}`, query!.params as never[]);
      type Plan = { "Relation Name"?: string; "Actual Rows": number; "Actual Loops": number; "Rows Removed by Filter"?: number; Plans?: Plan[] };
      function issueRowsExamined(plan: Plan): number {
        return (plan["Relation Name"] === "issues"
          ? (plan["Actual Rows"] + (plan["Rows Removed by Filter"] ?? 0)) * plan["Actual Loops"] : 0)
          + (plan.Plans ?? []).reduce((sum, child) => sum + issueRowsExamined(child), 0);
      }
      expect(issueRowsExamined(result["QUERY PLAN"][0].Plan)).toBeLessThan(100);
    } finally {
      await db.delete(issues).where(eq(issues.id, attached.id));
    }
  });

  it("ignores retained readers during actual repository admission", async () => {
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "multi-reader-admission-")));
    const rootKey = createHash("sha256").update(cwd).digest("hex");
    const workspaceIds = Array.from({ length: 40 }, () => randomUUID());
    const taskIds = workspaceIds.map(() => randomUUID()), runIds = taskIds.slice(0, 10).map(() => randomUUID());
    await db.insert(executionWorkspaces).values(workspaceIds.map(id => ({ id, companyId, cwd,
      name: "Historical root", mode: "shared_workspace", strategyType: "operator_directory" })));
    await db.insert(issues).values(taskIds.map((id, i) => ({ id, companyId, title: "Source", assigneeAgentId: agentId, executionWorkspaceId: workspaceIds[i] })));
    await db.insert(heartbeatRuns).values(runIds.map((id, i) => ({ id, companyId, agentId, responsibleUserId: userId,
      status: "succeeded", contextSnapshot: { issueId: taskIds[i] } })));
    await db.insert(executionWorkspaceRepositoryAccess).values(runIds.map((scopeId, i) => ({ companyId, rootKey,
      canonicalCwd: cwd, kind: "reader", scopeId, issueId: taskIds[i], agentId, responsibleUserId: userId })));
    try {
      const statements: string[] = [];
      const recorded = drizzle(db.$client, { schema: db._.fullSchema,
        logger: { logQuery: query => statements.push(query) } }) as unknown as typeof db;
      await executionWorkspaceRepositoryService(recorded).prepareForAdmission({ companyId, cwd,
        issueId: taskIds[0], workspaceId: workspaceIds[0], agentId, runId: runIds[0], responsibleUserId: userId });
      expect(statements.filter(query => query.includes('from "execution_workspaces"')
        || query.includes('from "issues"')).length).toBeLessThan(50);
    } finally {
      await db.delete(executionWorkspaceRepositoryAccess).where(and(eq(executionWorkspaceRepositoryAccess.companyId, companyId), eq(executionWorkspaceRepositoryAccess.rootKey, rootKey)));
      await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.id, runIds));
      await db.delete(issues).where(inArray(issues.id, taskIds));
      await db.delete(executionWorkspaces).where(inArray(executionWorkspaces.id, workspaceIds));
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each(["missing", "malformed", "uppercase", "foreign"])("denies a %s retained source without throwing a UUID parse error", async kind => {
    const id = kind === "malformed" ? "not-a-uuid" : kind === "uppercase" ? sourceId.toUpperCase() : randomUUID();
    if (kind === "foreign") {
      const [foreign] = await db.insert(companies).values({ name: "Foreign", issuePrefix: "OTHER" }).returning();
      await db.insert(issues).values({ id, companyId: foreign.id, title: "Foreign source" });
    }
    await retain(id);
    expect(await read()).toHaveLength(0);
  });

  it("requires both principals and rechecks revoked grants for retained private files", async () => {
    await retain(sourceId);
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: sourceId }).where(eq(issues.id, sourceId));
    expect(await read()).toHaveLength(0);
    await db.insert(issueAccessGrants).values({ issueId: sourceId, subjectType: "agent", subjectId: agentId, source: "explicit" });
    expect(await read()).toHaveLength(0);
    const [grant] = await db.insert(issueAccessGrants).values({ issueId: sourceId, subjectType: "user", subjectId: userId, source: "explicit" }).returning();
    expect(await read()).toHaveLength(1);
    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
    expect(await read()).toHaveLength(0);
  });
  it.each(["enforce", "shadow", "off"])("matches individual read decisions for a fresh batch in %s mode", async mode => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", mode);
    try {
      const resources = [{ type: "issue" as const, companyId, issueId: sourceId }, { type: "company" as const, companyId }];
      const actors: AuthorizationActor[] = [actor, { ...actor, onBehalfOfUserId: undefined },
        { ...actor, companyId: randomUUID() }, { type: "none" },
        { type: "board", source: "session", userId }, { type: "board", source: "local_implicit", userId: "local-board" }];
      const service = authorizationService(db);
      for (const candidate of actors) {
        const individual = [];
        for (const resource of resources) individual.push(await service.decide({ actor: { ...candidate }, resource,
          action: resource.type === "issue" ? "issue:read" : "company_scope:read" }));
        expect(await service.decideReads(candidate, resources)).toEqual(individual);
      }
    } finally { vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce"); }
  });

  it("matches private project decisions as each principal gains and loses access", async () => {
    const [project] = await db.insert(projects).values({ companyId, name: "Private batch source", visibility: "private" }).returning();
    const resource = { type: "project" as const, companyId, projectId: project.id };
    const service = authorizationService(db);
    const candidates: AuthorizationActor[] = [actor, { ...actor, onBehalfOfUserId: undefined }, { type: "board", source: "session", userId }];
    async function check(expected: boolean[]) {
      const batched = await service.decideReadsForActors(candidates, [resource]);
      for (let i = 0; i < candidates.length; i++) {
        expect(batched[i][0]).toEqual(await service.decide({ actor: { ...candidates[i] }, action: "project:read", resource }));
        expect(batched[i][0].allowed).toBe(expected[i]);
      }
    }
    try {
      await check([false, false, false]);
      await db.insert(projectAccessMembers).values({ companyId, projectId: project.id, subjectType: "agent", subjectId: agentId });
      await check([false, true, false]);
      const [grant] = await db.insert(projectAccessMembers).values({ companyId, projectId: project.id, subjectType: "user", subjectId: userId }).returning();
      await check([true, true, true]);
      await db.delete(projectAccessMembers).where(eq(projectAccessMembers.id, grant.id));
      await check([false, true, false]);
    } finally { await db.delete(projects).where(eq(projects.id, project.id)); }
  });

  it("supports more than 100 distinct reader principals for issue and project batches", async () => {
    const [project] = await db.insert(projects).values({ companyId, name: "Many readers" }).returning();
    const candidates: AuthorizationActor[] = Array.from({ length: 101 }, () => ({ type: "board", source: "session", userId: randomUUID() }));
    const service = authorizationService(db);
    try {
      for (const resource of [{ type: "issue" as const, companyId, issueId: sourceId }, { type: "project" as const, companyId, projectId: project.id }]) {
        const decisions = await service.decideReadsForActors(candidates, [resource]);
        expect(decisions).toHaveLength(101);
        expect(decisions.every(batch => batch.length === 1 && !batch[0].allowed)).toBe(true);
      }
    } finally { await db.delete(projects).where(eq(projects.id, project.id)); }
  });

  it("reloads run trust and responsible-user membership between read batches", async () => {
    const service = authorizationService(db);
    const resources = [{ type: "company" as const, companyId }];
    expect((await service.decideReads(actor, resources))[0].allowed).toBe(true);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: sourceId, executionPolicy: {
      trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review",
        trustBoundary: { mode: "low_trust_review", companyId, rootIssueId: sourceId } },
    } } }).where(eq(heartbeatRuns.id, runId));
    expect((await service.decideReads(actor, resources))[0]).toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: sourceId } }).where(eq(heartbeatRuns.id, runId));
    expect((await service.decideReads(actor, resources))[0].allowed).toBe(true);
    await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
    expect((await service.decideReads(actor, resources))[0]).toMatchObject({ allowed: false, code: "RESPONSIBLE_USER_UNAVAILABLE" });
  });

});
