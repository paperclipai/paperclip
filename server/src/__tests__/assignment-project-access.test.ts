import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues, projectAccessMembers, projects, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { ensureAssignmentIssueAccessGrant } from "../services/issues.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("assignment grants private-project access", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("assign-project-access-"); db = createDb(database.connectionString); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  const isMember = async (projectId: string, agentId: string) => (await db.select().from(projectAccessMembers).where(and(
    eq(projectAccessMembers.projectId, projectId), eq(projectAccessMembers.subjectType, "agent"), eq(projectAccessMembers.subjectId, agentId)))).length === 1;

  it("adds a newly assigned agent (and a replacement) to a private project, not an open one", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Assign access", issuePrefix: `A${companyId.slice(0, 7)}` });
    const [oldAgent, newAgent] = await db.insert(agents).values([1, 2].map(n => ({ companyId, name: `Agent ${n}`, adapterType: "process" }))).returning();
    const [priv, open] = await db.insert(projects).values([
      { companyId, name: "Private", status: "in_progress", visibility: "private" },
      { companyId, name: "Open", status: "in_progress", visibility: "open" },
    ]).returning();
    const [privIssue] = await db.insert(issues).values({ companyId, title: "p", projectId: priv!.id, assigneeAgentId: oldAgent!.id }).returning();
    await ensureAssignmentIssueAccessGrant(db, privIssue!, null, {});
    expect(await isMember(priv!.id, oldAgent!.id)).toBe(true);

    const reassigned = { ...privIssue!, assigneeAgentId: newAgent!.id };
    await ensureAssignmentIssueAccessGrant(db, reassigned, privIssue!, {});
    expect(await isMember(priv!.id, newAgent!.id)).toBe(true);
    await ensureAssignmentIssueAccessGrant(db, reassigned, null, {}); // idempotent
    expect(await isMember(priv!.id, newAgent!.id)).toBe(true);

    const [openIssue] = await db.insert(issues).values({ companyId, title: "o", projectId: open!.id, assigneeAgentId: newAgent!.id }).returning();
    await ensureAssignmentIssueAccessGrant(db, openIssue!, null, {});
    expect(await isMember(open!.id, newAgent!.id)).toBe(false);
  });
});
