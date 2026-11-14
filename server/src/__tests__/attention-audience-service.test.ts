import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  inboxDismissals,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type { AttentionAudience, AttentionFeedView } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { attentionRoutes } from "../routes/attention.js";
import { attentionService } from "../services/attention.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention audience tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// PAP-749 task 1a: two-user service tests for resolveAttentionAudience and the
// view= partition. The audience controls where a card shows; it never changes
// who may act, and it is never derived from responsibleUserId.
describeEmbeddedPostgres("attention audience service (PAP-749 task 1a)", () => {
  const SCOTT = "scott";
  const DOTTA = "dotta";

  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-audience-");
    db = createDb(externalUrl ?? tempDb!.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix = "AUD", seedWriters = false) {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const errorAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: workerId, companyId, name: "Worker", role: "engineer", status: "idle",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      },
      {
        id: errorAgentId, companyId, name: "Broken Agent", role: "engineer", status: "error",
        errorReason: "adapter config missing",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      },
    ]);
    if (seedWriters) {
      for (const userId of [SCOTT, DOTTA]) {
        await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@audience.example.test`, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
        await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
      }
    }
    return { companyId, workerId, errorAgentId, prefix };
  }

  let issueSeq = 0;
  async function insertIssue(input: {
    companyId: string;
    id?: string;
    status?: string;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    createdByAgentId?: string | null;
    createdByUserId?: string | null;
    responsibleUserId?: string | null;
    originKind?: string;
    conversationAgentId?: string | null;
    conversationUserId?: string | null;
    conversationState?: typeof issues.$inferInsert.conversationState;
    executionState?: Record<string, unknown> | null;
  }) {
    const id = input.id ?? randomUUID();
    issueSeq += 1;
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: `${issueSeq}`,
      title: `Issue ${issueSeq}`,
      status: input.status ?? "in_progress",
      priority: "medium",
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      responsibleUserId: input.responsibleUserId ?? null,
      originKind: input.originKind ?? "manual",
      originFingerprint: `fp-${issueSeq}`,
      conversationAgentId: input.conversationAgentId ?? null,
      conversationUserId: input.conversationUserId ?? null,
      conversationState: input.conversationState ?? null,
      executionState: input.executionState ?? null,
    });
    return id;
  }

  async function insertConfirmation(input: {
    companyId: string;
    issueId: string;
    workerId: string;
    addresseeUserId?: string | null;
    addresseeAgentId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      kind: "request_confirmation",
      status: "pending",
      title: "Approve the plan",
      createdByAgentId: input.workerId,
      addresseeUserId: input.addresseeUserId ?? null,
      addresseeAgentId: input.addresseeAgentId ?? null,
      payload: { version: 1, prompt: "Approve this plan?" },
    });
    return id;
  }

  function list(companyId: string, userId: string, view?: AttentionFeedView) {
    return attentionService(db).list(companyId, { userId, view });
  }

  function audienceOf(items: Array<{ subject: { id: string }; audience: AttentionAudience }>, sourceId: string) {
    return items.find((item) => item.subject.id === sourceId)?.audience ?? null;
  }

  it("resolves the audience for each source kind and step without a user-visible change in view=all", async () => {
    const { companyId, workerId } = await seedCompany();

    // Step 4 (instigator): a human-created task by Scott, with a no-addressee confirmation.
    const scottTask = await insertIssue({ companyId, createdByUserId: SCOTT, originKind: "manual" });
    const scottInstigated = await insertConfirmation({ companyId, issueId: scottTask, workerId });

    // Step 4 for Dotta, to prove Scott still sees it in `all` (pre-PAP-749 behaviour).
    const dottaTask = await insertIssue({ companyId, createdByUserId: DOTTA, originKind: "manual" });
    const dottaInstigated = await insertConfirmation({ companyId, issueId: dottaTask, workerId });

    // Step 1 (addressee): confirmation explicitly addressed to Scott.
    const addressedTask = await insertIssue({ companyId, createdByAgentId: workerId, originKind: "task_watchdog" });
    const addressedToScott = await insertConfirmation({ companyId, issueId: addressedTask, workerId, addresseeUserId: SCOTT });

    // Step 2 (conversation): a chat container whose user is Scott.
    const chatTask = await insertIssue({
      companyId, status: "in_review", assigneeAgentId: workerId,
      conversationAgentId: workerId, conversationUserId: SCOTT, conversationState: "waiting",
    });
    const chatConfirmation = await insertConfirmation({ companyId, issueId: chatTask, workerId });

    // "requester": an approval requested by Scott.
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId, type: "request_board_approval", status: "pending",
      requestedByUserId: SCOTT, payload: { title: "Ship it" },
    });

    // Pool (step 6) + responsibleUserId guard: agent/routine-created work, no addressee,
    // responsibleUserId = Scott. It must NOT route to Scott.
    const routineTask = await insertIssue({
      companyId, createdByAgentId: workerId, originKind: "routine_execution", responsibleUserId: SCOTT,
    });
    const poolConfirmation = await insertConfirmation({ companyId, issueId: routineTask, workerId });

    const feed = await list(companyId, SCOTT, "all");
    const items = feed.items;

    // Each source kind / step resolves to the expected audience.
    expect(audienceOf(items, scottInstigated)).toEqual({ kind: "user", userId: SCOTT, reason: "instigator" });
    expect(audienceOf(items, addressedToScott)).toEqual({ kind: "user", userId: SCOTT, reason: "addressee" });
    expect(audienceOf(items, chatConfirmation)).toEqual({ kind: "user", userId: SCOTT, reason: "conversation" });
    expect(audienceOf(items, approvalId)).toEqual({ kind: "user", userId: SCOTT, reason: "requester" });

    // The routine/agent-created card is a pool card; responsibleUserId did NOT route it to Scott.
    expect(audienceOf(items, poolConfirmation)).toEqual({ kind: "pool", userId: null, reason: "none" });

    // The company operations alert (the errored agent) is a Company card.
    const errorCard = items.find((item) => item.sourceKind === "agent_error_alert");
    expect(errorCard?.audience).toEqual({ kind: "company", userId: null, reason: "none" });

    // No user-visible change in `all`: Scott still sees Dotta's instigated card (it has no addressee),
    // exactly as before PAP-749. Only an interaction addressed to another user stays hidden.
    expect(audienceOf(items, dottaInstigated)).toEqual({ kind: "user", userId: DOTTA, reason: "instigator" });
  });

  it("keeps an interaction addressed to another user hidden in every view (pre-PAP-749 behaviour)", async () => {
    const { companyId, workerId } = await seedCompany("ADX");
    const task = await insertIssue({ companyId, createdByAgentId: workerId, originKind: "task_watchdog" });
    const addressedToDotta = await insertConfirmation({ companyId, issueId: task, workerId, addresseeUserId: DOTTA });

    const scottAll = await list(companyId, SCOTT, "all");
    expect(scottAll.items.some((item) => item.subject.id === addressedToDotta)).toBe(false);

    const dottaAll = await list(companyId, DOTTA, "all");
    expect(audienceOf(dottaAll.items, addressedToDotta)).toEqual({ kind: "user", userId: DOTTA, reason: "addressee" });
  });

  it("partitions the feed by view: mine, unassigned, and company", async () => {
    const { companyId, workerId } = await seedCompany("PRT");

    const scottTask = await insertIssue({ companyId, createdByUserId: SCOTT, originKind: "manual" });
    const scottCard = await insertConfirmation({ companyId, issueId: scottTask, workerId });

    const dottaTask = await insertIssue({ companyId, createdByUserId: DOTTA, originKind: "manual" });
    const dottaCard = await insertConfirmation({ companyId, issueId: dottaTask, workerId });

    const routineTask = await insertIssue({
      companyId, createdByAgentId: workerId, originKind: "routine_execution", responsibleUserId: SCOTT,
    });
    const poolCard = await insertConfirmation({ companyId, issueId: routineTask, workerId });

    const scottMine = await list(companyId, SCOTT, "mine");
    const scottMineIds = scottMine.items.map((item) => item.subject.id);
    expect(scottMineIds).toContain(scottCard);
    expect(scottMineIds).not.toContain(dottaCard);
    expect(scottMineIds).not.toContain(poolCard);
    expect(scottMine.items.every((item) => item.audience.kind === "user" && item.audience.userId === SCOTT)).toBe(true);

    const dottaMine = await list(companyId, DOTTA, "mine");
    const dottaMineIds = dottaMine.items.map((item) => item.subject.id);
    expect(dottaMineIds).toContain(dottaCard);
    expect(dottaMineIds).not.toContain(scottCard);

    const unassigned = await list(companyId, SCOTT, "unassigned");
    const unassignedIds = unassigned.items.map((item) => item.subject.id);
    expect(unassignedIds).toContain(poolCard);
    expect(unassignedIds).not.toContain(scottCard);
    expect(unassigned.items.every((item) => item.audience.kind === "pool")).toBe(true);

    const company = await list(companyId, SCOTT, "company");
    expect(company.items.length).toBeGreaterThan(0);
    expect(company.items.every((item) => item.audience.kind === "company")).toBe(true);
    expect(company.items.some((item) => item.sourceKind === "agent_error_alert")).toBe(true);
  });

  it("routes ownerless cards to the company default decision owner, and to Unassigned once cleared (PAP-749 task 1d-lite)", async () => {
    const { companyId, workerId } = await seedCompany("DDO");

    // An agent/routine card with no human signal — a pool card by default.
    const routineTask = await insertIssue({
      companyId, createdByAgentId: workerId, originKind: "routine_execution", responsibleUserId: SCOTT,
    });
    const ownerlessCard = await insertConfirmation({ companyId, issueId: routineTask, workerId });

    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: DOTTA, status: "active", membershipRole: "admin",
    });

    // With the default decision owner set to Dotta, the ownerless card routes to
    // Dotta's "For you" list, with reason escalation_owner — not the pool.
    await db.update(companies).set({ defaultDecisionOwnerUserId: DOTTA }).where(eq(companies.id, companyId));

    const dottaMineSet = await list(companyId, DOTTA, "mine");
    expect(audienceOf(dottaMineSet.items, ownerlessCard)).toEqual({ kind: "user", userId: DOTTA, reason: "escalation_owner" });

    const unassignedSet = await list(companyId, SCOTT, "unassigned");
    expect(unassignedSet.items.some((item) => item.subject.id === ownerlessCard)).toBe(false);

    // responsibleUserId is still never a routing signal: Scott does not get it.
    const scottMineSet = await list(companyId, SCOTT, "mine");
    expect(scottMineSet.items.some((item) => item.subject.id === ownerlessCard)).toBe(false);

    // Clearing the owner sends the same card back to the claimable pool.
    await db.update(companies).set({ defaultDecisionOwnerUserId: null }).where(eq(companies.id, companyId));

    const unassignedCleared = await list(companyId, SCOTT, "unassigned");
    expect(audienceOf(unassignedCleared.items, ownerlessCard)).toEqual({ kind: "pool", userId: null, reason: "none" });

    const dottaMineCleared = await list(companyId, DOTTA, "mine");
    expect(dottaMineCleared.items.some((item) => item.subject.id === ownerlessCard)).toBe(false);
  });

  it("sends ownerless cards to Unassigned when the default decision owner is no longer an active member", async () => {
    const { companyId, workerId } = await seedCompany("DDI");
    const routineTask = await insertIssue({ companyId, createdByAgentId: workerId, originKind: "routine_execution" });
    const ownerlessCard = await insertConfirmation({ companyId, issueId: routineTask, workerId });

    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: DOTTA, status: "suspended", membershipRole: "admin",
    });
    await db.update(companies).set({ defaultDecisionOwnerUserId: DOTTA }).where(eq(companies.id, companyId));

    const unassigned = await list(companyId, SCOTT, "unassigned");
    expect(audienceOf(unassigned.items, ownerlessCard)).toEqual({ kind: "pool", userId: null, reason: "none" });
    const dottaMine = await list(companyId, DOTTA, "mine");
    expect(dottaMine.items.some((item) => item.subject.id === ownerlessCard)).toBe(false);
  });

  it("routes a delegated child card to the instigator of its parent", async () => {
    const { companyId, workerId } = await seedCompany("CHN");

    // Scott creates the parent human task; an agent spins up a child under it.
    const parentTask = await insertIssue({ companyId, createdByUserId: SCOTT, originKind: "manual" });
    const childTask = await insertIssue({
      companyId, parentId: parentTask, createdByAgentId: workerId, originKind: "manual",
    });
    const childCard = await insertConfirmation({ companyId, issueId: childTask, workerId });

    const scottMine = await list(companyId, SCOTT, "mine");
    expect(audienceOf(scottMine.items, childCard)).toEqual({ kind: "user", userId: SCOTT, reason: "instigator" });

    const dottaMine = await list(companyId, DOTTA, "mine");
    expect(dottaMine.items.some((item) => item.subject.id === childCard)).toBe(false);
  });

  // PAP-749 task 1b: one badge (For you only, no day boundary) and Claim.
  it("counts only current For you cards in the badge, with the same per-view counts in every view", async () => {
    const { companyId, workerId } = await seedCompany("BDG");
    const scottTask = await insertIssue({ companyId, createdByUserId: SCOTT, originKind: "manual" });
    const scottCard = await insertConfirmation({ companyId, issueId: scottTask, workerId });
    const olderScottTask = await insertIssue({ companyId, createdByUserId: SCOTT, originKind: "manual" });
    const olderScottCard = await insertConfirmation({ companyId, issueId: olderScottTask, workerId });
    // Three days old: the old "new today" badge left it out; an open card now stays counted.
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    await db.update(issueThreadInteractions)
      .set({ createdAt: threeDaysAgo, updatedAt: threeDaysAgo })
      .where(eq(issueThreadInteractions.id, olderScottCard));
    const dottaTask = await insertIssue({ companyId, createdByUserId: DOTTA, originKind: "manual" });
    await insertConfirmation({ companyId, issueId: dottaTask, workerId });
    const routineTask = await insertIssue({ companyId, createdByAgentId: workerId, originKind: "routine_execution" });
    await insertConfirmation({ companyId, issueId: routineTask, workerId });

    const all = await list(companyId, SCOTT, "all");
    expect(all.viewCounts.mine).toBe(2);
    expect(all.deskBadgeCount).toBe(2);
    expect(all.viewCounts.unassigned).toBe(1);
    expect(all.viewCounts.company).toBeGreaterThanOrEqual(1);
    // Everyone (PAP-768) counts every person's current cards; it is never the badge.
    expect(all.viewCounts.all).toBe(all.items.length);
    expect(all.viewCounts.all).toBeGreaterThan(all.viewCounts.mine);
    expect(all.items.some((item) => item.audience.userId === DOTTA)).toBe(true);
    // Counts ignore the requested view, so the tabs, banner and badge agree.
    for (const view of ["mine", "unassigned", "company"] as const) {
      expect((await list(companyId, SCOTT, view)).viewCounts).toEqual(all.viewCounts);
    }
    expect((await list(companyId, DOTTA, "all")).deskBadgeCount).toBe(1);

    // A personally hidden card leaves the badge; the other person's count is unchanged.
    const scottItem = (await list(companyId, SCOTT, "mine")).items.find((item) => item.subject.id === scottCard)!;
    await db.insert(inboxDismissals).values({
      companyId, userId: SCOTT, itemKey: scottItem.dismissalKey, kind: "dismiss", fingerprint: scottItem.changeFingerprint,
    });
    const afterDismiss = await attentionService(db).list(companyId, { userId: SCOTT, includeDismissed: true });
    expect(afterDismiss.deskBadgeCount).toBe(1);
    expect(afterDismiss.viewCounts.mine).toBe(1);
  });

  // PAP-749 task 2e: the Archived view reads the viewer's own inbox_dismissals.
  it("returns only your archived and snoozed cards in view=archived, counted on their tab and never in the badge", async () => {
    const { companyId, workerId } = await seedCompany("ARV");
    const scottCard = async () => insertConfirmation({ companyId, issueId: await insertIssue({ companyId, createdByUserId: SCOTT, originKind: "manual" }), workerId });
    const archivedCard = await scottCard();
    const snoozedCard = await scottCard();
    const currentCard = await scottCard();
    const expiredSnoozeCard = await scottCard();
    const changedCard = await scottCard();
    const routineTask = await insertIssue({ companyId, createdByAgentId: workerId, originKind: "routine_execution" });
    const archivedPoolCard = await insertConfirmation({ companyId, issueId: routineTask, workerId });

    const before = await list(companyId, SCOTT, "all");
    const itemOf = (sourceId: string) => before.items.find((item) => item.subject.id === sourceId)!;
    const tomorrow = new Date(Date.now() + 86_400_000);
    await db.insert(inboxDismissals).values([
      { companyId, userId: SCOTT, itemKey: itemOf(archivedCard).dismissalKey, kind: "dismiss", fingerprint: itemOf(archivedCard).changeFingerprint },
      { companyId, userId: SCOTT, itemKey: itemOf(snoozedCard).dismissalKey, kind: "snooze", snoozedUntil: tomorrow, fingerprint: itemOf(snoozedCard).changeFingerprint },
      // A card of any audience can be archived for yourself, also an Unassigned one.
      { companyId, userId: SCOTT, itemKey: itemOf(archivedPoolCard).dismissalKey, kind: "dismiss", fingerprint: itemOf(archivedPoolCard).changeFingerprint },
      // These two are back: the snooze ended, and the card changed since it was archived.
      { companyId, userId: SCOTT, itemKey: itemOf(expiredSnoozeCard).dismissalKey, kind: "snooze", snoozedUntil: new Date(Date.now() - 60_000), fingerprint: itemOf(expiredSnoozeCard).changeFingerprint },
      { companyId, userId: SCOTT, itemKey: itemOf(changedCard).dismissalKey, kind: "dismiss", fingerprint: "an-older-version.me" },
    ]);

    const archived = await list(companyId, SCOTT, "archived");
    expect(new Set(archived.items.map((item) => item.subject.id))).toEqual(new Set([archivedCard, snoozedCard, archivedPoolCard]));
    expect(archived.items.every((item) => item.dismissal?.isActive)).toBe(true);
    const snoozed = archived.items.find((item) => item.subject.id === snoozedCard)!;
    expect(snoozed.dismissal).toMatchObject({ kind: "snooze", snoozedUntil: tomorrow.toISOString(), isActive: true });
    expect(archived.items.find((item) => item.subject.id === archivedPoolCard)?.audience.kind).toBe("pool");
    expect(archived.totalCount).toBe(3);
    expect(archived.receipts).toBeUndefined();

    // The tab count is the Archived list; the badge is still only current For you cards.
    expect(archived.viewCounts).toMatchObject({ mine: 3, unassigned: 0, archived: 3 });
    expect(archived.deskBadgeCount).toBe(3);
    for (const view of ["mine", "unassigned", "company", "all"] as const) {
      expect((await list(companyId, SCOTT, view)).viewCounts).toEqual(archived.viewCounts);
    }
    // Everyone leaves out the cards you hid, like the other views (PAP-768).
    const everyone = await list(companyId, SCOTT, "all");
    expect(archived.viewCounts.all).toBe(everyone.items.length);
    expect(everyone.items.map((item) => item.subject.id)).not.toContain(archivedPoolCard);
    const mineIds = (await list(companyId, SCOTT, "mine")).items.map((item) => item.subject.id);
    expect(mineIds).toEqual(expect.arrayContaining([currentCard, expiredSnoozeCard, changedCard]));
    expect(mineIds).not.toContain(archivedCard);
    expect(mineIds).not.toContain(snoozedCard);
    expect((await list(companyId, SCOTT, "unassigned")).items.map((item) => item.subject.id)).not.toContain(archivedPoolCard);

    // Archive is personal: Dotta's Archived view is empty and her pool still has the card.
    const dottaArchived = await list(companyId, DOTTA, "archived");
    expect(dottaArchived.items).toEqual([]);
    expect(dottaArchived.viewCounts.archived).toBe(0);
    expect((await list(companyId, DOTTA, "unassigned")).items.map((item) => item.subject.id)).toContain(archivedPoolCard);

    // Restore (deleting the dismissal) moves the card back to For you.
    await db.delete(inboxDismissals).where(and(eq(inboxDismissals.userId, SCOTT), eq(inboxDismissals.itemKey, itemOf(archivedCard).dismissalKey)));
    const restored = await list(companyId, SCOTT, "archived");
    expect(restored.items.map((item) => item.subject.id)).not.toContain(archivedCard);
    expect(restored.viewCounts).toMatchObject({ mine: 4, archived: 2 });
  });

  it("accepts view=archived on the route and still rejects unknown views", async () => {
    const { companyId } = await seedCompany("ARR");
    const testApp = express();
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId: SCOTT, companyIds: [companyId], isInstanceAdmin: false };
      next();
    });
    testApp.use("/api", attentionRoutes(db));
    testApp.use(errorHandler);
    const feed = await request(testApp).get(`/api/companies/${companyId}/attention?view=archived&all=true`).expect(200);
    expect(feed.body).toMatchObject({ items: [], viewCounts: { archived: 0 } });
    expect(feed.body.receipts).toBeUndefined();
    await request(testApp).get(`/api/companies/${companyId}/attention?view=hidden`).expect(400);
  });

  it("scopes decision history on the route: mine is handled by me or for me, all is everyone (PAP-768)", async () => {
    const { companyId, workerId } = await seedCompany("HSR");
    const scottCard = await insertConfirmation({ companyId, issueId: await insertIssue({ companyId, createdByUserId: SCOTT, originKind: "manual" }), workerId });
    await db.update(issueThreadInteractions)
      .set({ status: "accepted", resolvedAt: new Date(), resolvedByUserId: SCOTT })
      .where(eq(issueThreadInteractions.id, scottCard));
    const app = (userId: string) => {
      const testApp = express();
      testApp.use((req, _res, next) => {
        (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false };
        next();
      });
      testApp.use("/api", attentionRoutes(db));
      testApp.use(errorHandler);
      return testApp;
    };
    const history = async (userId: string, query: string) =>
      (await request(app(userId)).get(`/api/companies/${companyId}/attention/history?${query}`).expect(200)).body.items.map((item: { sourceId: string }) => item.sourceId);
    expect(await history(SCOTT, "scope=mine")).toEqual([scottCard]);
    expect(await history(DOTTA, "scope=mine")).toEqual([]);
    expect(await history(DOTTA, "scope=all")).toEqual([scottCard]);
    expect(await history(DOTTA, "")).toEqual([scottCard]);
    await request(app(DOTTA)).get(`/api/companies/${companyId}/attention/history?scope=team`).expect(400);
  });

  it("claims a pool card for one person and removes it from every other person's pool", async () => {
    const { companyId, workerId } = await seedCompany("CLM", true);
    const routineTask = await insertIssue({ companyId, createdByAgentId: workerId, originKind: "routine_execution" });
    const poolCard = await insertConfirmation({ companyId, issueId: routineTask, workerId });
    const svc = attentionService(db);
    const board = (userId: string) => ({ type: "board" as const, source: "session" as const, userId, companyIds: [companyId], isInstanceAdmin: false });

    expect((await list(companyId, DOTTA, "unassigned")).items.some((item) => item.subject.id === poolCard)).toBe(true);
    const claim = await svc.claim(companyId, {
      sourceKind: "issue_thread_interaction", sourceId: poolCard, userId: SCOTT, actor: board(SCOTT),
    });
    expect(claim).toMatchObject({ sourceId: poolCard, claimedByUserId: SCOTT, alreadyClaimed: false, issueId: routineTask });

    const scottMine = await list(companyId, SCOTT, "mine");
    expect(audienceOf(scottMine.items, poolCard)).toEqual({ kind: "user", userId: SCOTT, reason: "addressee" });
    expect((await list(companyId, DOTTA, "unassigned")).items.some((item) => item.subject.id === poolCard)).toBe(false);
    expect((await list(companyId, SCOTT, "unassigned")).items.some((item) => item.subject.id === poolCard)).toBe(false);

    // Claiming again is a no-op; a different person gets a conflict, not a takeover.
    await expect(svc.claim(companyId, {
      sourceKind: "issue_thread_interaction", sourceId: poolCard, userId: SCOTT, actor: board(SCOTT),
    })).resolves.toMatchObject({ alreadyClaimed: true });
    await expect(svc.claim(companyId, {
      sourceKind: "issue_thread_interaction", sourceId: poolCard, userId: DOTTA, actor: board(DOTTA),
    })).rejects.toMatchObject({ status: 409 });

    // The claim moves placement only: the resolver policy is unchanged.
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, poolCard));
    expect(row?.addresseeUserId).toBe(SCOTT);
    expect(row?.effectiveResolverPolicy).toBe("anyone");
  });

  it("claims a stuck agent's request but leaves a runnable agent's request with the agent", async () => {
    const { companyId, workerId, errorAgentId } = await seedCompany("CLA", true);
    const svc = attentionService(db);
    const board = { type: "board" as const, source: "session" as const, userId: SCOTT, companyIds: [companyId], isInstanceAdmin: false };
    // A paused agent cannot run, so its request reaches the pool; an agent in error still can.
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, errorAgentId));
    const task = await insertIssue({ companyId, createdByAgentId: workerId, originKind: "routine_execution" });
    const stuck = await insertConfirmation({ companyId, issueId: task, workerId, addresseeAgentId: errorAgentId });
    const runnable = await insertConfirmation({ companyId, issueId: task, workerId, addresseeAgentId: workerId });

    await svc.claim(companyId, { sourceKind: "issue_thread_interaction", sourceId: stuck, userId: SCOTT, actor: board });
    const [claimed] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, stuck));
    expect(claimed).toMatchObject({ addresseeUserId: SCOTT, addresseeAgentId: null });

    await expect(svc.claim(companyId, { sourceKind: "issue_thread_interaction", sourceId: runnable, userId: SCOTT, actor: board }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("serves the claim route to board users only, validates input and writes one activity entry", async () => {
    const { companyId, workerId } = await seedCompany("CLR", true);
    const routineTask = await insertIssue({ companyId, createdByAgentId: workerId, originKind: "routine_execution" });
    const poolCard = await insertConfirmation({ companyId, issueId: routineTask, workerId });
    const approvalId = randomUUID();
    await db.insert(approvals).values({ id: approvalId, companyId, type: "request_board_approval", status: "pending", payload: {} });

    function app(actor: Record<string, unknown>) {
      const testApp = express();
      testApp.use(express.json());
      testApp.use((req, _res, next) => {
        (req as any).actor = actor;
        next();
      });
      testApp.use("/api", attentionRoutes(db));
      testApp.use(errorHandler);
      return testApp;
    }
    const scott = { type: "board", source: "session", userId: SCOTT, companyIds: [companyId], isInstanceAdmin: false };
    const outsider = { type: "board", source: "session", userId: "outsider", companyIds: [], isInstanceAdmin: false };
    const agent = { type: "agent", source: "agent_key", companyId, agentId: workerId, runId: null };
    const claimUrl = (kind: string, id: string) => `/api/companies/${companyId}/attention/${kind}/${id}/claim`;

    await request(app(agent)).post(claimUrl("issue_thread_interaction", poolCard)).expect(403);
    await request(app(outsider)).post(claimUrl("issue_thread_interaction", poolCard)).expect(403);
    await request(app(scott)).post(claimUrl("nonsense", poolCard)).expect(400);
    await request(app(scott)).post(claimUrl("issue_thread_interaction", "not-a-uuid")).expect(400);
    await request(app(scott)).post(claimUrl("issue_thread_interaction", randomUUID())).expect(404);
    await request(app(scott)).post(claimUrl("approval", approvalId)).expect(422);

    const claimed = await request(app(scott)).post(claimUrl("issue_thread_interaction", poolCard)).expect(200);
    expect(claimed.body).toEqual({
      sourceKind: "issue_thread_interaction", sourceId: poolCard, claimedByUserId: SCOTT, alreadyClaimed: false,
    });
    await request(app(scott)).post(claimUrl("issue_thread_interaction", poolCard)).expect(200);

    const entries = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "attention.claimed")));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorType: "user", actorId: SCOTT, entityType: "issue", entityId: routineTask });
    expect(entries[0]?.details).toMatchObject({ sourceKind: "issue_thread_interaction", sourceId: poolCard, claimedByUserId: SCOTT });
  });
});
