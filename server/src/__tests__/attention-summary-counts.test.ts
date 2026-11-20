import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvals, companies, createDb, decisionQueueItems, decisionRetention, inboxDismissals, issues, type Db,
} from "@paperclipai/db";
import { ATTENTION_SOURCE_KINDS, type AttentionFeed, type AttentionItem, type AttentionSummary } from "@paperclipai/shared";
import {
  ATTENTION_SUMMARY_BOARD_ACTORS, seedAttentionSummaryFixture, seedAttentionSummaryVolume, type AttentionSummaryFixture,
} from "./helpers/attention-summary-fixture.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { seedReviewAttentionFixture, type ReviewAttentionFixture } from "./helpers/review-attention-fixture.js";
import { errorHandler } from "../middleware/index.js";
import { attentionRoutes } from "../routes/attention.js";
import { attentionService } from "../services/attention.js";
import { issueReadSqlCondition, type AuthorizationActor } from "../services/authorization.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention summary tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Counts = Pick<AttentionSummary, "totalCount" | "deskBadgeCount" | "viewCounts" | "countsBySourceKind">;
const VIEWS = ["mine", "unassigned", "company", "archived", "all"] as const;
const counts = (value: Counts): Counts => ({
  totalCount: value.totalCount, deskBadgeCount: value.deskBadgeCount, viewCounts: value.viewCounts,
  countsBySourceKind: value.countsBySourceKind,
});
const taskIdsOf = (items: AttentionItem[]) => [...new Set(items.flatMap((item) =>
  item.relatedIssue ? [item.relatedIssue.id] : item.subject.kind === "issue" ? [item.subject.id] : []))].sort();
// A card that is evidence of another card counts with that card.
const leads = (items: AttentionItem[]) => items.filter((item) => !item.obligationLeadId || item.obligationLeadId === item.id);

/**
 * The numbers the full feed implies, counted from its cards: the cards of the
 * unfiltered feed, and the leading cards of each view.
 */
async function countsFromFeed(db: Db, companyId: string, options: { userId: string; actor: AuthorizationActor }) {
  const service = attentionService(db);
  const everything = { ...options, all: true, allowUnscopedAll: true } as const;
  const feed = await service.list(companyId, everything);
  const viewCounts = { mine: 0, unassigned: 0, company: 0, archived: 0, all: 0 };
  for (const view of VIEWS) viewCounts[view] = leads((await service.list(companyId, { ...everything, view })).items).length;
  const countsBySourceKind = Object.fromEntries(ATTENTION_SOURCE_KINDS.map((kind) => [kind, 0])) as Counts["countsBySourceKind"];
  for (const item of feed.items) countsBySourceKind[item.sourceKind] += 1;
  const counted: Counts = { totalCount: feed.items.length, deskBadgeCount: viewCounts.mine, viewCounts, countsBySourceKind };
  return { feed, counted };
}

describeEmbeddedPostgres("attention summary: the counts of the full feed", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixture!: AttentionSummaryFixture;
  const reader = (name: (typeof ATTENTION_SUMMARY_BOARD_ACTORS)[number]) => {
    const actor = fixture.actors[name];
    return { userId: actor.userId!, actor };
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-summary-counts-");
    db = createDb(tempDb.connectionString);
    fixture = await seedAttentionSummaryFixture(db);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  it("counts what the feed shows before any feed was read, and seeds what the feed seeds", async () => {
    const owner = reader("board owner");
    // The first read of this database is a summary: it has no state of an earlier feed read to lean on.
    const summary = await attentionService(db).summary(fixture.companyId, owner);
    const stored = async () => ({
      retention: (await db.select({ id: decisionRetention.id }).from(decisionRetention)
        .where(eq(decisionRetention.companyId, fixture.companyId))).length,
      queueItems: (await db.select({ id: decisionQueueItems.id }).from(decisionQueueItems)
        .where(eq(decisionQueueItems.companyId, fixture.companyId))).length,
    });
    const afterSummary = await stored();
    const { feed, counted } = await countsFromFeed(db, fixture.companyId, owner);
    expect(counts(summary)).toEqual(counted);
    expect(counts(feed)).toEqual(counted);
    // The feed found every retention state and every queue member it writes.
    expect(await stored()).toEqual(afterSummary);
    expect(afterSummary.retention).toBeGreaterThanOrEqual(feed.items.length);
    expect(afterSummary.queueItems).toBeGreaterThan(0);

    // The fixture reaches every source, every view and cards that join into one obligation.
    for (const kind of ATTENTION_SOURCE_KINDS) {
      if (kind !== "productivity_review") expect(summary.countsBySourceKind[kind], kind).toBeGreaterThan(0);
    }
    expect(summary.viewCounts.mine).toBeGreaterThan(0);
    expect(summary.viewCounts.unassigned).toBeGreaterThan(0);
    expect(summary.viewCounts.company).toBeGreaterThan(0);
    expect(feed.items.filter((item) => item.obligationLeadId && item.obligationLeadId !== item.id).length).toBeGreaterThan(2);
    expect(summary.viewCounts.all).toBeLessThan(summary.totalCount);
    const cardIds = new Set(feed.items.map((item) => item.subject.id));
    for (const [name, id] of Object.entries(fixture.named)) expect(cardIds.has(id), name).toBe(name !== "forViewer");
    for (const [name, id] of Object.entries(fixture.notCards)) expect(cardIds.has(id), name).toBe(false);
    for (const id of [...Object.values(fixture.cards.unreadablePrivate), ...Object.values(fixture.cards.hidden),
      ...Object.values(fixture.foreign)]) expect(cardIds.has(id)).toBe(false);
  }, 120_000);

  it("gives every board actor the counts and the tasks of their own feed", async () => {
    const totals = new Map<string, number>();
    for (const name of ATTENTION_SUMMARY_BOARD_ACTORS) {
      const options = reader(name);
      const { feed, counted } = await countsFromFeed(db, fixture.companyId, options);
      const summary = await attentionService(db).summary(fixture.companyId, options);
      expect(counts(summary), name).toEqual(counted);
      expect(counts(feed), name).toEqual(counted);
      const index = await attentionService(db).taskIndex(fixture.companyId, options);
      expect(counts(index), name).toEqual(counted);
      expect([...index.taskIds].sort(), name).toEqual(taskIdsOf(feed.items));
      totals.set(name, summary.totalCount);
    }
    // Read access changes the numbers: a reader of every task, an owner, a
    // member without a private task and a user of another company.
    expect(totals.get("instance admin")!).toBeGreaterThan(totals.get("board owner")!);
    expect(totals.get("board owner")!).toBeGreaterThan(totals.get("board member")!);
    expect(totals.get("board operator")!).toBeGreaterThan(totals.get("board member")!);
    expect(totals.get("board viewer")!).toBeGreaterThan(totals.get("board member")!);
    expect(totals.get("local implicit board")).toBe(totals.get("instance admin"));
    expect(totals.get("board without membership")!).toBeLessThanOrEqual(totals.get("board member")!);
  }, 240_000);

  it("leaves out what a person archived or snoozed, and counts a card again when its content changed", async () => {
    const service = attentionService(db);
    for (const name of ["board owner", "board operator"] as const) {
      const options = reader(name);
      const before = await service.summary(fixture.companyId, options);
      const feed = await service.list(fixture.companyId, { ...options, all: true, allowUnscopedAll: true });
      const first = (kind: AttentionItem["sourceKind"], accept: (item: AttentionItem) => boolean = () => true) => {
        const item = feed.items.find((candidate) => candidate.sourceKind === kind && accept(candidate));
        expect(item, `${name}: ${kind}`).toBeTruthy();
        return item!;
      };
      const isLead = (item: AttentionItem) => !item.obligationLeadId || item.obligationLeadId === item.id;
      const changed = first("approval", (item) => isLead(item) && item.subject.id !== fixture.overrideApprovalId);
      const hidden = [
        changed, first("review", isLead), first("blocker_attention", isLead), first("decision"), first("join_request"),
        // Evidence of an obligation: hiding it hides the obligation.
        first("blocker_attention", (item) => !isLead(item)),
      ];
      for (const item of hidden) {
        await service.hideForUser(fixture.companyId, { ...options, sourceKind: item.sourceKind, sourceId: item.subject.id,
          mode: "archive", fingerprint: item.changeFingerprint });
      }
      const snoozed = first("issue_thread_interaction", isLead);
      await service.hideForUser(fixture.companyId, { ...options, sourceKind: snoozed.sourceKind, sourceId: snoozed.subject.id,
        mode: "snooze", until: new Date(Date.now() + 86_400_000).toISOString(), fingerprint: snoozed.changeFingerprint });
      // Dismissals saved before cards had a fingerprint: one after the last
      // activity of its card (still hidden) and one before it (shown again).
      const hiddenLeadIds = new Set(hidden.map((item) => item.obligationLeadId ?? item.id));
      const legacy = feed.items
        .filter((item) => item.sourceKind === "failed_run" && isLead(item) && !hiddenLeadIds.has(item.id)).slice(0, 2);
      expect(legacy).toHaveLength(2);
      await db.insert(inboxDismissals).values([
        { companyId: fixture.companyId, userId: options.userId, itemKey: legacy[0]!.dismissalKey, dismissedAt: new Date() },
        { companyId: fixture.companyId, userId: options.userId, itemKey: legacy[1]!.dismissalKey, dismissedAt: new Date(0) },
        // A snooze that ended, and a dismissal of a card of another company.
        { companyId: fixture.companyId, userId: options.userId, itemKey: first("agent_error_alert").dismissalKey,
          kind: "snooze", dismissedAt: new Date(), snoozedUntil: new Date(Date.now() - 60_000) },
        { companyId: fixture.foreignCompanyId, userId: options.userId, itemKey: first("recovery_action").dismissalKey,
          dismissedAt: new Date() },
      ]);

      const { counted } = await countsFromFeed(db, fixture.companyId, options);
      const hiddenSummary = await service.summary(fixture.companyId, options);
      expect(counts(hiddenSummary), name).toEqual(counted);
      expect(hiddenSummary.viewCounts.archived, name).toBeGreaterThanOrEqual(7);
      expect(hiddenSummary.viewCounts.all, name).toBeLessThanOrEqual(before.viewCounts.all - 7);

      // A new proposal on an archived approval is a new card for the person.
      await db.update(approvals).set({ payload: { title: `A new proposal for ${name}` } }).where(eq(approvals.id, changed.subject.id));
      const returned = await countsFromFeed(db, fixture.companyId, options);
      const returnedSummary = await service.summary(fixture.companyId, options);
      expect(counts(returnedSummary), name).toEqual(returned.counted);
      expect(returnedSummary.viewCounts.archived, name).toBe(hiddenSummary.viewCounts.archived - 1);
      expect(returnedSummary.viewCounts.all, name).toBe(hiddenSummary.viewCounts.all + 1);
    }
    // What one person hid stays in the count of every other person.
    for (const name of ["board admin", "board viewer"] as const) {
      const options = reader(name);
      const { counted } = await countsFromFeed(db, fixture.companyId, options);
      const summary = await service.summary(fixture.companyId, options);
      expect(counts(summary), name).toEqual(counted);
      expect(summary.viewCounts.archived, name).toBe(0);
    }
  }, 240_000);

  it("moves the cards without an owner to the default decision owner of the company", async () => {
    const service = attentionService(db);
    const before = await service.summary(fixture.companyId, reader("board admin"));
    expect(before.viewCounts.unassigned).toBeGreaterThan(0);
    await db.update(companies).set({ defaultDecisionOwnerUserId: fixture.users.admin }).where(eq(companies.id, fixture.companyId));
    try {
      for (const name of ["board admin", "board owner", "board member", "instance admin"] as const) {
        const options = reader(name);
        const { counted } = await countsFromFeed(db, fixture.companyId, options);
        const summary = await service.summary(fixture.companyId, options);
        expect(counts(summary), name).toEqual(counted);
        expect(summary.viewCounts.unassigned, name).toBe(0);
      }
      const after = await service.summary(fixture.companyId, reader("board admin"));
      expect(after.viewCounts.mine).toBeGreaterThanOrEqual(before.viewCounts.mine + before.viewCounts.unassigned);
    } finally {
      await db.update(companies).set({ defaultDecisionOwnerUserId: null }).where(eq(companies.id, fixture.companyId));
    }
  }, 120_000);

  it("reads one company, and returns zeros for a company without cards", async () => {
    const service = attentionService(db);
    const foreign = fixture.actors["board without membership"];
    const foreignOptions = { userId: foreign.userId!, actor: foreign };
    const { feed, counted } = await countsFromFeed(db, fixture.foreignCompanyId, foreignOptions);
    expect(counts(await service.summary(fixture.foreignCompanyId, foreignOptions))).toEqual(counted);
    // The approval, the question, the decision, the failed run, the review
    // and the agent in error of the other company, and nothing of this one.
    expect(new Set(feed.items.map((item) => item.companyId))).toEqual(new Set([fixture.foreignCompanyId]));
    expect(counted.totalCount).toBe(6);

    const empty = await service.summary(fixture.emptyCompanyId, reader("board owner"));
    const emptyFeed = await countsFromFeed(db, fixture.emptyCompanyId, reader("board owner"));
    expect(counts(empty)).toEqual(emptyFeed.counted);
    expect(counts(empty)).toEqual({
      totalCount: 0, deskBadgeCount: 0, viewCounts: { mine: 0, unassigned: 0, company: 0, archived: 0, all: 0 },
      countsBySourceKind: Object.fromEntries(ATTENTION_SOURCE_KINDS.map((kind) => [kind, 0])),
    });
  }, 120_000);

  it("serves the same counts on the route, to board users of the company only", async () => {
    const app = (actor: unknown) => {
      const testApp = express();
      testApp.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = actor;
        next();
      });
      testApp.use("/api", attentionRoutes(db));
      testApp.use(errorHandler);
      return testApp;
    };
    const route = `/api/companies/${fixture.companyId}/attention/summary`;
    for (const name of ["board owner", "board member", "cloud tenant viewer"] as const) {
      const options = reader(name);
      const response = await request(app(options.actor)).get(route).expect(200);
      expect(response.body, name).not.toHaveProperty("items");
      expect(counts(response.body as AttentionSummary), name)
        .toEqual(counts(await attentionService(db).summary(fixture.companyId, options)));
      const page = await request(app(options.actor)).get(`/api/companies/${fixture.companyId}/attention?limit=5`).expect(200);
      expect(counts(response.body as AttentionSummary), name).toEqual(counts(page.body as AttentionFeed));
    }
    await request(app(fixture.actors["board without membership"])).get(route).expect(403);
    await request(app(fixture.actors["agent key"])).get(route).expect(403);
    await request(app(fixture.actors.unauthenticated)).get(route).expect(401);
  }, 120_000);

  it("reads the blocked tasks of the task list, in the order of the task list", async () => {
    const tasks = issueService(db);
    // Blocked tasks that the task list leaves out: a plugin operation and a harness task.
    await db.insert(issues).values([
      { companyId: fixture.companyId, title: "Plugin operation", status: "blocked", originKind: "plugin:example:operation" },
      { companyId: fixture.companyId, title: "Harness task", status: "blocked", harnessKind: "review" },
    ]);
    for (const name of ["board owner", "board member", "instance admin"] as const) {
      const { actor } = reader(name);
      const readCondition = await issueReadSqlCondition(db, actor);
      const listed = await tasks.list(fixture.companyId, { status: "blocked", includeBlockedBy: true, readCondition });
      const roots = await tasks.listBlockerAttentionRoots(fixture.companyId, { status: "blocked", readCondition });
      expect(roots.map((root) => root.id), name).toEqual(listed.map((row) => row.id));
      expect(roots.length, name).toBeGreaterThan(8);
      const attention = await tasks.listBlockerAttention(fixture.companyId, roots);
      for (const row of listed as Array<(typeof listed)[number] & { blockerAttention?: unknown }>) {
        expect(attention.get(row.id), `${name}: ${row.title}`).toEqual(row.blockerAttention);
      }
    }
    const everyBlocked = await db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, fixture.companyId), eq(issues.status, "blocked")));
    const readable = await tasks.listBlockerAttentionRoots(fixture.companyId, { status: "blocked", readCondition: sql<boolean>`true` });
    expect(everyBlocked.length - readable.length).toBe(2);
  }, 120_000);
});

describeEmbeddedPostgres("attention summary: what one request reads", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let meter!: ReturnType<typeof meterDatabaseStatements>;
  const companies: Record<string, ReviewAttentionFixture> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-summary-cost-");
    db = createDb(tempDb.connectionString);
    meter = meterDatabaseStatements(db, tempDb.connectionString);
    // Two sizes on the two sides of the batch size of the related-row reads
    // (500), and three small companies that differ in one property each.
    companies.small = await seedReviewAttentionFixture(db, { tasks: 2_000, agents: 24, prefix: "SML", descriptionBytes: 200 });
    companies.large = await seedReviewAttentionFixture(db, { tasks: 6_000, agents: 24, prefix: "LRG", descriptionBytes: 200 });
    companies.plain = await seedReviewAttentionFixture(db, { tasks: 600, agents: 24, prefix: "PLN", descriptionBytes: 200 });
    companies.longText = await seedReviewAttentionFixture(db, { tasks: 600, agents: 24, prefix: "TXT", descriptionBytes: 20_000 });
    companies.budgets = await seedReviewAttentionFixture(db, { tasks: 600, agents: 24, prefix: "BDG", descriptionBytes: 200 });
    for (const name of ["plain", "longText"]) await seedAttentionSummaryVolume(db, companies[name]!, { budgetPolicies: 0 });
    await seedAttentionSummaryVolume(db, companies.budgets!, { budgetPolicies: 20 });
    await db.$client.unsafe("analyze");
  }, 240_000);

  afterAll(async () => {
    meter?.uninstall();
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const actorOf = (company: ReviewAttentionFixture): AuthorizationActor => ({
    type: "board", source: "session", userId: company.userId, companyIds: [company.companyId], isInstanceAdmin: false,
  });
  async function metered<Result>(read: () => Promise<Result>) {
    const before = meter.read();
    const result = await read();
    const after = meter.read();
    return {
      result, statements: after.statements - before.statements, transactions: after.transactions - before.transactions,
      rows: after.rows - before.rows, bytes: after.bytesReceived - before.bytesReceived,
    };
  }
  /** One summary request after an earlier one has written the retention states and seeded the queues. */
  async function summaryCost(company: ReviewAttentionFixture) {
    const options = { userId: company.userId, actor: actorOf(company) };
    await attentionService(db).summary(company.companyId, options);
    return metered(() => attentionService(db).summary(company.companyId, options));
  }
  /** What the two classifications that a count depends on read for the same tasks. */
  async function classificationCost(company: ReviewAttentionFixture) {
    const rowsOf = (status: string) => db.select().from(issues)
      .where(and(eq(issues.companyId, company.companyId), eq(issues.status, status)));
    const [blocked, reviews] = [await rowsOf("blocked"), await rowsOf("in_review")];
    const blocker = await metered(() => issueService(db).listBlockerAttention(company.companyId, blocked));
    const review = await metered(() => issueService(db).listReviewAttention(company.companyId, reviews));
    return { statements: blocker.statements + review.statements, rows: blocker.rows + review.rows };
  }

  it("issues a fixed number of statements of its own, whatever the number of cards", async () => {
    const [small, large] = [await summaryCost(companies.small!), await summaryCost(companies.large!)];
    const [smallClassification, largeClassification] = [
      await classificationCost(companies.small!), await classificationCost(companies.large!),
    ];
    expect(large.result.totalCount).toBeGreaterThan(small.result.totalCount * 2.5);
    expect(large.result.countsBySourceKind.blocker_attention).toBeGreaterThan(150);
    expect(large.result.countsBySourceKind.review).toBeGreaterThan(250);
    // The classifications read their related rows in batches, so their
    // statements grow with the tasks. Nothing else in the request does.
    expect(largeClassification.statements).toBeGreaterThan(smallClassification.statements);
    const ownStatements = { small: small.statements - smallClassification.statements, large: large.statements - largeClassification.statements };
    expect(ownStatements.large).toBe(ownStatements.small);
    expect(ownStatements.large).toBeLessThanOrEqual(30);
    // Rows: each blocked task and each review one time, each card's task for
    // its audience, its retention state, and the rows of the classifications.
    const ownRows = large.rows - largeClassification.rows;
    expect(ownRows).toBeLessThanOrEqual(companies.large!.counts.blocked + companies.large!.counts.reviews + 4 * large.result.totalCount);
  }, 240_000);

  it("reads no task description", async () => {
    const [plain, longText] = [await summaryCost(companies.plain!), await summaryCost(companies.longText!)];
    expect(counts(longText.result)).toEqual(counts(plain.result));
    expect(longText.statements).toBe(plain.statements);
    expect(longText.rows).toBe(plain.rows);
    // 600 tasks with 20,000 bytes of description each against 200 bytes each.
    expect(longText.bytes).toBeLessThan(plain.bytes * 1.05);
  }, 120_000);

  it("does not sum the spend of the budget policies", async () => {
    const [plain, budgets] = [await summaryCost(companies.plain!), await summaryCost(companies.budgets!)];
    expect(counts(budgets.result)).toEqual(counts(plain.result));
    expect(budgets.statements).toBe(plain.statements);
    // Both companies have cards that seed the decision queues, so the request
    // also made the writes of the feed: the queues hold those cards.
    expect(budgets.result.countsBySourceKind.issue_thread_interaction).toBeGreaterThanOrEqual(30);
    const seeded = await db.select({ id: decisionQueueItems.id }).from(decisionQueueItems)
      .where(eq(decisionQueueItems.companyId, companies.budgets!.companyId));
    expect(seeded.length).toBeGreaterThanOrEqual(30);
  }, 120_000);
});
