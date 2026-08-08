import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  feedbackVotes,
  financeEvents,
  folders,
  goals,
  heartbeatRuns,
  inboxDismissals,
  issueInboxArchives,
  issues,
  issueThreadInteractions,
  projects,
  secretAccessEvents,
  toolMcpGateways,
  toolProfiles,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company removal tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService.remove", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-remove-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Seeds every FK constellation that used to break the delete cascade:
  // cost/finance events pointing at heartbeat runs, projects pointing at
  // goals, budget incidents pointing at approvals and policies, votes /
  // archives / thread interactions pointing at issues and agents, nested
  // folders (self-FK RESTRICT), an MCP gateway pointing at a tool profile
  // (RESTRICT), and company-scoped rows the cascade previously never touched.
  async function seedCompany(name: string, prefix: string) {
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: prefix })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company.id, name: `${name} Agent` })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: company.id, agentId: agent.id })
      .returning();
    const [goal] = await db
      .insert(goals)
      .values({ companyId: company.id, title: `${name} Goal` })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ companyId: company.id, name: `${name} Project`, goalId: goal.id })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({ companyId: company.id, title: `${name} Issue`, projectId: project.id, goalId: goal.id })
      .returning();
    const [costEvent] = await db
      .insert(costEvents)
      .values({
        companyId: company.id,
        agentId: agent.id,
        heartbeatRunId: run.id,
        issueId: issue.id,
        projectId: project.id,
        goalId: goal.id,
        provider: "test",
        model: "test-model",
        costCents: 42,
        occurredAt: new Date(),
      })
      .returning();
    await db.insert(financeEvents).values({
      companyId: company.id,
      agentId: agent.id,
      heartbeatRunId: run.id,
      costEventId: costEvent.id,
      issueId: issue.id,
      projectId: project.id,
      goalId: goal.id,
      eventKind: "cost",
      biller: "test",
      amountCents: 42,
      occurredAt: new Date(),
    });
    const [approval] = await db
      .insert(approvals)
      .values({ companyId: company.id, type: "budget", payload: {} })
      .returning();
    const [policy] = await db
      .insert(budgetPolicies)
      .values({ companyId: company.id, scopeType: "company", scopeId: company.id, windowKind: "monthly" })
      .returning();
    await db.insert(budgetIncidents).values({
      companyId: company.id,
      policyId: policy.id,
      approvalId: approval.id,
      scopeType: "company",
      scopeId: company.id,
      metric: "cost",
      windowKind: "monthly",
      windowStart: new Date(),
      windowEnd: new Date(),
      thresholdType: "hard",
      amountLimit: 100,
      amountObserved: 200,
    });
    await db.insert(feedbackVotes).values({
      companyId: company.id,
      issueId: issue.id,
      targetType: "issue",
      targetId: issue.id,
      authorUserId: "user-1",
      vote: "up",
    });
    await db.insert(issueInboxArchives).values({
      companyId: company.id,
      issueId: issue.id,
      userId: "user-1",
    });
    await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: issue.id,
      kind: "ask_user_questions",
      payload: { version: 1, questions: [] },
      createdByAgentId: agent.id,
    });
    const [parentFolder] = await db
      .insert(folders)
      .values({ companyId: company.id, kind: "skill", name: "Parent", slug: `parent-${prefix.toLowerCase()}` })
      .returning();
    await db.insert(folders).values({
      companyId: company.id,
      kind: "skill",
      name: "Child",
      slug: `child-${prefix.toLowerCase()}`,
      parentId: parentFolder.id,
    });
    const [profile] = await db
      .insert(toolProfiles)
      .values({ companyId: company.id, profileKey: `profile-${prefix.toLowerCase()}`, name: `${name} Profile` })
      .returning();
    await db.insert(toolMcpGateways).values({
      companyId: company.id,
      name: `${name} Gateway`,
      slug: `gateway-${prefix.toLowerCase()}`,
      profileId: profile.id,
    });
    await db.insert(secretAccessEvents).values({
      companyId: company.id,
      provider: "env",
      actorType: "agent",
      consumerType: "adapter",
      consumerId: "test-consumer",
      outcome: "granted",
    });
    await db.insert(inboxDismissals).values({
      companyId: company.id,
      userId: "user-1",
      itemKey: "item-1",
    });
    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(),
      companyId: company.id,
      scopeType: "project",
      serviceName: "web",
      status: "stopped",
      lifecycle: "managed",
      provider: "process",
    });
    return company;
  }

  it("removes a company whose data spans all FK-constrained child tables", async () => {
    const company = await seedCompany("Cascade Target", "CAS");
    const survivor = await seedCompany("Survivor", "SUR");

    const removed = await companyService(db).remove(company.id);
    expect(removed?.id).toBe(company.id);

    const remainingCompanies = await db.select({ id: companies.id }).from(companies);
    expect(remainingCompanies.map((row) => row.id)).toEqual([survivor.id]);

    // no orphans for the removed company in tables the cascade used to miss
    expect(await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, company.id))).toHaveLength(0);
    expect(await db.select().from(feedbackVotes).where(eq(feedbackVotes.companyId, company.id))).toHaveLength(0);
    expect(await db.select().from(inboxDismissals).where(eq(inboxDismissals.companyId, company.id))).toHaveLength(0);
    expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, company.id))).toHaveLength(0);
    expect(
      await db.select().from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.companyId, company.id)),
    ).toHaveLength(0);
    expect(await db.select().from(folders).where(eq(folders.companyId, company.id))).toHaveLength(0);
    expect(await db.select().from(toolMcpGateways).where(eq(toolMcpGateways.companyId, company.id))).toHaveLength(0);

    // the surviving company keeps its data
    expect(await db.select().from(agents).where(eq(agents.companyId, survivor.id))).toHaveLength(1);
    expect(await db.select().from(folders).where(eq(folders.companyId, survivor.id))).toHaveLength(2);
  });
});
