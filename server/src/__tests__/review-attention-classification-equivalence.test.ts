import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, inboxDismissals } from "@paperclipai/db";
import type { AttentionFeed, AttentionSummary, Issue } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { seedReviewAttentionFixture, type ReviewAttentionFixture } from "./helpers/review-attention-fixture.js";

// Every classification the routes run is also run by the pre-fix
// implementation on the same input. A difference fails the test.
const shadow = vi.hoisted(() => ({
  mismatches: [] as string[],
  classifications: 0,
  graphsWithRelations: 0,
  findingStates: new Set<string>(),
  pathKinds: new Set<string>(),
  reviewsClassified: 0,
}));

vi.mock("../services/recovery/issue-graph-liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/recovery/issue-graph-liveness.js")>();
  const reference = await import("./helpers/issue-graph-liveness-reference.js");
  const same = (label: string, current: unknown, expected: unknown) => {
    if (JSON.stringify(current) !== JSON.stringify(expected)) shadow.mismatches.push(label);
  };
  return {
    ...actual,
    classifyIssueGraphLiveness(input: Parameters<typeof actual.classifyIssueGraphLiveness>[0]) {
      const findings = actual.classifyIssueGraphLiveness(input);
      same(`findings of ${input.issues.length} tasks`, findings, reference.referenceClassifyIssueGraphLiveness(input));
      shadow.classifications += 1;
      if (input.relations.length > 0) shadow.graphsWithRelations += 1;
      for (const finding of findings) shadow.findingStates.add(finding.state);
      return findings;
    },
    createIssueReviewPathClassifier(input: Parameters<typeof actual.createIssueReviewPathClassifier>[0]) {
      const reviewPathsOf = actual.createIssueReviewPathClassifier(input);
      return (issue: Parameters<typeof reviewPathsOf>[0]) => {
        const paths = reviewPathsOf(issue);
        same(`review paths of ${issue.identifier}`, paths, reference.referenceClassifyIssueReviewPaths(input, issue));
        shadow.reviewsClassified += 1;
        for (const path of paths) shadow.pathKinds.add(path.kind);
        return paths;
      };
    },
  };
});

const { errorHandler } = await import("../middleware/index.js");
const { attentionRoutes } = await import("../routes/attention.js");
const { issueRoutes } = await import("../routes/issues.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review attention equivalence tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type ListedIssue = Issue & { blockedInboxAttention?: { state: string } };

describeEmbeddedPostgres("review attention through the routes: indexed classification", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixture!: ReviewAttentionFixture;
  let other!: ReviewAttentionFixture;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-attention-equivalence-");
    db = createDb(tempDb.connectionString);
    // Two companies of the same shapes. Each request reads one of them.
    fixture = await seedReviewAttentionFixture(db, { tasks: 640, agents: 24, prefix: "RAE" });
    other = await seedReviewAttentionFixture(db, { tasks: 320, agents: 12, prefix: "OTH" });
  }, 120_000);

  beforeEach(() => {
    shadow.mismatches.length = 0;
    shadow.classifications = 0;
    shadow.graphsWithRelations = 0;
    shadow.reviewsClassified = 0;
    shadow.findingStates.clear();
    shadow.pathKinds.clear();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  function app(target: ReviewAttentionFixture) {
    const testApp = express();
    testApp.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board", source: "session", userId: target.userId, companyIds: [target.companyId], isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", attentionRoutes(db));
    testApp.use("/api", issueRoutes(db, {} as never));
    testApp.use(errorHandler);
    return testApp;
  }

  async function read<Body>(target: ReviewAttentionFixture, route: string) {
    const response = await request(app(target)).get(`/api/companies/${target.companyId}${route}`);
    expect(response.status, `${route}: ${JSON.stringify(response.body).slice(0, 300)}`).toBe(200);
    return response.body as Body;
  }

  const stable = (summary: AttentionSummary) => ({ ...summary, generatedAt: null });

  it("gives every review the paths the fixture was built with, and the pre-fix classification of every request", async () => {
    const reviews = await read<ListedIssue[]>(fixture, "/issues?status=in_review&limit=1000");
    expect(reviews).toHaveLength(fixture.expectedReviews.length);
    const byId = new Map(reviews.map((row) => [row.id, row.reviewAttention!]));
    for (const expected of fixture.expectedReviews) {
      const attention = byId.get(expected.id)!;
      const label = `${expected.identifier} (variant ${expected.variant})`;
      expect(attention.paths.map((path) => path.kind).sort(), label).toEqual([...expected.kinds].sort());
      expect(attention.state, label).toBe(expected.kinds.length > 0 ? "covered" : "stalled");
      if (expected.stalledReason) expect(attention.reason, label).toContain(expected.stalledReason);
    }
    // The fixture reaches every kind of path, a review that recovery tasks
    // cover, and the three ways a review stalls.
    expect(new Set(fixture.expectedReviews.flatMap((review) => review.kinds))).toEqual(new Set([
      "human_reviewer", "execution_participant", "monitor", "interaction", "approval", "queued_wake", "active_run",
      "recovery", "external_response",
    ]));
    expect(fixture.expectedReviews.filter((review) => review.variant < 4 && review.kinds.includes("recovery")).length).toBeGreaterThan(0);
    expect(new Set(fixture.expectedReviews.map((review) => review.stalledReason)).size).toBe(4);

    // The dashboard task list and the blocked inbox, whose task graph has the
    // blocked chains, the cycles and the terminal blockers.
    const taskList = await read<ListedIssue[]>(fixture, "/issues");
    for (const row of taskList.filter((task) => task.status === "in_review")) {
      expect(row.reviewAttention, row.identifier ?? row.id).toEqual(byId.get(row.id));
    }
    const blockedInbox = await read<ListedIssue[]>(fixture, "/issues?attention=blocked");
    expect(blockedInbox.length).toBeGreaterThan(0);

    expect(shadow.mismatches).toEqual([]);
    expect(shadow.reviewsClassified).toBeGreaterThanOrEqual(fixture.expectedReviews.length);
    expect(shadow.graphsWithRelations).toBeGreaterThan(0);
    expect([...shadow.pathKinds].sort()).toEqual([
      "active_run", "approval", "execution_participant", "external_response", "human_reviewer", "interaction",
      "monitor", "queued_wake", "recovery",
    ]);
    expect([...shadow.findingStates].sort()).toEqual(expect.arrayContaining([
      "blocked_by_assigned_backlog_issue", "blocked_by_cancelled_issue", "blocked_by_unassigned_issue",
      "blocked_by_uninvokable_assignee", "in_review_without_action_path", "invalid_review_participant",
    ]));
  }, 60_000);

  it("counts the reviews that need a person, leaves out the ones a person dismissed, and reads one company", async () => {
    const summary = await read<AttentionSummary>(fixture, "/attention/summary");
    const feed = await read<AttentionFeed>(fixture, "/attention?all=true");
    // A review needs a person when it is stalled, assigned to a user, waiting
    // for a user participant, or waiting for a pending approval.
    const needsPerson = fixture.expectedReviews.filter((review) =>
      review.kinds.length === 0 || [4, 7, 10].includes(review.variant));
    const stalled = fixture.expectedReviews.filter((review) => review.kinds.length === 0);
    expect(summary.countsBySourceKind.review).toBe(needsPerson.length);
    expect(summary.totalCount).toBe(feed.items.length);
    expect(feed.countsBySourceKind).toEqual(summary.countsBySourceKind);
    const reviewCards = feed.items.filter((item) => item.sourceKind === "review");
    const label = (id: string) => {
      const expected = fixture.expectedReviews.find((review) => review.id === id);
      return expected ? `${expected.identifier} (variant ${expected.variant})` : `task ${fixture.taskIds.indexOf(id) + 1}`;
    };
    expect(reviewCards.map((item) => label(item.subject.id)).sort()).toEqual(needsPerson.map((review) => label(review.id)).sort());
    expect(reviewCards.filter((item) => item.inlineResolvable).map((item) => label(item.subject.id)).sort())
      .toEqual(stalled.map((review) => label(review.id)).sort());

    // The other company has its own counts, and its requests read none of
    // this company's tasks.
    const otherSummary = await read<AttentionSummary>(other, "/attention/summary");
    const otherFeed = await read<AttentionFeed>(other, "/attention?all=true");
    expect(otherSummary.countsBySourceKind.review).toBe(other.expectedReviews.filter((review) =>
      review.kinds.length === 0 || [4, 7, 10].includes(review.variant)).length);
    const ownIds = new Set(fixture.taskIds);
    expect(otherFeed.items.filter((item) => ownIds.has(item.subject.id))).toEqual([]);
    expect(stable(await read<AttentionSummary>(fixture, "/attention/summary"))).toEqual(stable(summary));

    // Dismissed cards leave the count. The reviews stay stalled.
    const dismissed = reviewCards.filter((item) => item.inlineResolvable).slice(0, 3);
    expect(dismissed).toHaveLength(3);
    await db.insert(inboxDismissals).values(dismissed.map((item) => ({
      companyId: fixture.companyId, userId: fixture.userId, itemKey: item.dismissalKey, kind: "dismiss" as const,
      fingerprint: item.changeFingerprint,
    })));
    const afterDismissal = await read<AttentionSummary>(fixture, "/attention/summary");
    expect(afterDismissal.totalCount).toBe(summary.totalCount - 3);
    expect(afterDismissal.countsBySourceKind.review).toBe(needsPerson.length - 3);
    expect(afterDismissal.viewCounts.archived).toBe(summary.viewCounts.archived + 3);
    const reviews = await read<ListedIssue[]>(fixture, "/issues?status=in_review&limit=1000");
    for (const item of dismissed) {
      expect(reviews.find((row) => row.id === item.subject.id)?.reviewAttention?.state).toBe("stalled");
    }

    expect(shadow.mismatches).toEqual([]);
    expect(shadow.reviewsClassified).toBeGreaterThan(0);
  }, 60_000);
});
