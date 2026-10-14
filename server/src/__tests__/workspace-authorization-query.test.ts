import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, executionWorkspaces, issueAccessGrants,
  issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { executionWorkspaceReadSqlCondition, type AuthorizationActor } from "../services/authorization.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("workspace authorization query", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), workspaceId = randomUUID();
  const sourceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId, agentId, onBehalfOfUserId: userId };

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
});
