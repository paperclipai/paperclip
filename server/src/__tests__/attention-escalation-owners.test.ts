import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  budgetIncidents,
  budgetPolicies,
  companies,
  companyMemberships,
  createDb,
  issueThreadInteractions,
  issues,
  projects,
} from "@paperclipai/db";
import type { AttentionFeedView } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";
import {
  attentionHandledDetails,
  attentionHandledFor,
  attentionReceiptService,
} from "../services/attention-receipts.js";
import { budgetService } from "../services/budgets.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention escalation owner tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// PAP-749 task 1d: project decision owners and the budget owner as escalation
// destinations. Placement only: these tests check where a card shows, never
// who may act.
describeEmbeddedPostgres("attention escalation owners (PAP-749 task 1d)", () => {
  const SCOTT = "scott";
  const DOTTA = "dotta";
  const RILEY = "riley";

  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-escalation-");
    db = createDb(externalUrl ?? tempDb!.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: workerId, companyId, name: "Worker", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(companyMemberships).values([SCOTT, DOTTA, RILEY].map((principalId) => ({
      companyId, principalType: "user", principalId, status: "active", membershipRole: "admin",
    })));
    return { companyId, workerId };
  }

  async function insertProject(companyId: string, decisionOwnerUserId: string | null) {
    const id = randomUUID();
    await db.insert(projects).values({ id, companyId, name: `Project ${id.slice(0, 4)}`, decisionOwnerUserId });
    return id;
  }

  let issueSeq = 0;
  /** An agent-created task with no human signal: an ownerless card's home. */
  async function insertAgentTask(companyId: string, workerId: string, projectId: string | null) {
    const id = randomUUID();
    issueSeq += 1;
    await db.insert(issues).values({
      id,
      companyId,
      projectId,
      identifier: `${issueSeq}`,
      title: `Issue ${issueSeq}`,
      status: "todo",
      priority: "medium",
      createdByAgentId: workerId,
      originKind: "routine_execution",
      originFingerprint: `fp-${issueSeq}`,
    });
    return id;
  }

  async function insertConfirmation(companyId: string, issueId: string, workerId: string) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      title: "Approve the plan",
      createdByAgentId: workerId,
      payload: { version: 1, prompt: "Approve this plan?" },
    });
    return id;
  }

  async function insertBudgetIncident(companyId: string, thresholdType: "hard" | "soft") {
    const policyId = randomUUID();
    await db.insert(budgetPolicies).values({
      id: policyId,
      companyId,
      scopeType: "company",
      scopeId: companyId,
      metric: "billed_cents",
      windowKind: thresholdType === "hard" ? "calendar_month_utc" : "lifetime",
      amount: 100,
    });
    const [incident] = await db.insert(budgetIncidents).values({
      companyId,
      policyId,
      scopeType: "company",
      scopeId: companyId,
      metric: "billed_cents",
      windowKind: thresholdType === "hard" ? "calendar_month_utc" : "lifetime",
      windowStart: new Date("2026-10-01T00:00:00.000Z"),
      windowEnd: new Date("2026-11-01T00:00:00.000Z"),
      thresholdType,
      amountLimit: 100,
      amountObserved: thresholdType === "hard" ? 100 : 90,
      status: "open",
    }).returning({ id: budgetIncidents.id });
    return incident!.id;
  }

  function list(companyId: string, userId: string, view?: AttentionFeedView) {
    return attentionService(db).list(companyId, { userId, view });
  }

  function find<T extends { subject: { id: string } }>(items: T[], sourceId: string) {
    return items.find((item) => item.subject.id === sourceId) ?? null;
  }

  it("routes an ownerless card to its project's decision owner before the company default", async () => {
    const { companyId, workerId } = await seedCompany("PRJ");
    await db.update(companies).set({ defaultDecisionOwnerUserId: DOTTA }).where(eq(companies.id, companyId));
    const ownedProject = await insertProject(companyId, RILEY);
    const plainProject = await insertProject(companyId, null);
    const ownedCard = await insertConfirmation(companyId, await insertAgentTask(companyId, workerId, ownedProject), workerId);
    const plainCard = await insertConfirmation(companyId, await insertAgentTask(companyId, workerId, plainProject), workerId);

    const rileyMine = await list(companyId, RILEY, "mine");
    expect(find(rileyMine.items, ownedCard)?.audience).toEqual({ kind: "user", userId: RILEY, reason: "project_owner" });
    expect(find(rileyMine.items, plainCard)).toBeNull();

    const dottaMine = await list(companyId, DOTTA, "mine");
    expect(find(dottaMine.items, plainCard)?.audience).toEqual({ kind: "user", userId: DOTTA, reason: "escalation_owner" });
    expect(find(dottaMine.items, ownedCard)).toBeNull();

    // Nothing ownerless is left in the pool.
    const unassigned = await list(companyId, SCOTT, "unassigned");
    expect(unassigned.items.filter((item) => [ownedCard, plainCard].includes(item.subject.id))).toEqual([]);
  });

  it("skips a project decision owner who is no longer an active member", async () => {
    const { companyId, workerId } = await seedCompany("PRS");
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, RILEY));
    const project = await insertProject(companyId, RILEY);
    const card = await insertConfirmation(companyId, await insertAgentTask(companyId, workerId, project), workerId);

    const unassigned = await list(companyId, SCOTT, "unassigned");
    expect(find(unassigned.items, card)?.audience).toEqual({ kind: "pool", userId: null, reason: "none" });
    const rileyMine = await list(companyId, RILEY, "mine");
    expect(find(rileyMine.items, card)).toBeNull();
  });

  it("gives a budget hard stop to the budget owner while Company still shows it", async () => {
    const { companyId } = await seedCompany("BGT");
    await db.update(companies).set({ budgetOwnerUserId: SCOTT }).where(eq(companies.id, companyId));
    const hardStop = await insertBudgetIncident(companyId, "hard");
    const warning = await insertBudgetIncident(companyId, "soft");

    const scottMine = await list(companyId, SCOTT, "mine");
    const scottCard = find(scottMine.items, hardStop);
    expect(scottCard?.audience).toEqual({ kind: "user", userId: SCOTT, reason: "budget_owner", alsoInCompany: true });
    expect(scottCard?.decisionVerbs.map((verb) => verb.label)).toEqual(["Raise limit", "Keep paused"]);
    expect(find(scottMine.items, warning)).toBeNull();
    // The personal card is in the badge; it is one card, not two.
    expect(scottMine.viewCounts.mine).toBe(1);
    expect(scottMine.deskBadgeCount).toBe(1);

    for (const userId of [SCOTT, DOTTA]) {
      const company = await list(companyId, userId, "company");
      expect(find(company.items, hardStop)).not.toBeNull();
      expect(find(company.items, warning)?.audience).toEqual({ kind: "company", userId: null, reason: "none" });
      expect(company.viewCounts.company).toBe(2);
    }
    const dottaMine = await list(companyId, DOTTA, "mine");
    expect(find(dottaMine.items, hardStop)).toBeNull();
    expect(dottaMine.viewCounts.mine).toBe(0);
  });

  it("keeps a budget hard stop in Company only when no budget owner is set", async () => {
    const { companyId } = await seedCompany("BGN");
    const hardStop = await insertBudgetIncident(companyId, "hard");

    const company = await list(companyId, SCOTT, "company");
    expect(find(company.items, hardStop)?.audience).toEqual({ kind: "company", userId: null, reason: "none" });
    const scottMine = await list(companyId, SCOTT, "mine");
    expect(find(scottMine.items, hardStop)).toBeNull();
  });

  it("gives the budget owner a receipt when someone else keeps their hard stop paused", async () => {
    const { companyId } = await seedCompany("BGR");
    await db.update(companies).set({ budgetOwnerUserId: SCOTT }).where(eq(companies.id, companyId));
    const hardStop = await insertBudgetIncident(companyId, "hard");
    const warning = await insertBudgetIncident(companyId, "soft");

    // The owner acting on their own card, or anyone on a warning, is no receipt.
    expect(await attentionHandledFor(db, companyId, { sourceKind: "budget_alert", sourceId: hardStop }, SCOTT)).toBeNull();
    expect(await attentionHandledFor(db, companyId, { sourceKind: "budget_alert", sourceId: warning }, DOTTA)).toBeNull();

    const handledFor = await attentionHandledFor(db, companyId, { sourceKind: "budget_alert", sourceId: hardStop }, DOTTA);
    expect(handledFor).toMatchObject({ userId: SCOTT, actorUserId: DOTTA, title: "BGR Co budget hard stop" });
    await budgetService(db).resolveIncident(companyId, hardStop, { action: "keep_paused" }, DOTTA, {
      activityDetails: attentionHandledDetails(handledFor, "answered", { reason: "Kept paused" }),
    });

    const [entry] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "budget.incident_resolved"));
    expect(entry?.details).toMatchObject({ action: "keep_paused", handledForUserId: SCOTT });

    const receipts = await attentionReceiptService(db).list(companyId, {
      userId: SCOTT,
      actor: { type: "board", userId: SCOTT, isInstanceAdmin: true, companyIds: [companyId] },
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      outcome: "answered",
      sourceKind: "budget_alert",
      sourceId: hardStop,
      actorUserId: DOTTA,
      reason: "Kept paused",
      href: "/BGR/costs",
    });

    // The card is gone for everyone once the incident closes.
    const company = await list(companyId, DOTTA, "company");
    expect(find(company.items, hardStop)).toBeNull();
  });
});
