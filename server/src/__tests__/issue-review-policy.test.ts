import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues, type Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import {
  assertIssueReviewVerdictActorAllowed,
  isIssueReviewVerdictInteraction,
} from "../services/issue-review-policy.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue review verdict policy", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-review-policy-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedReview(policy: "not_creator" | "human_only") {
    const companyId = randomUUID();
    const requesterAgentId = randomUUID();
    const peerAgentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Review Policy Company",
      issuePrefix: "RPC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: requesterAgentId,
        companyId,
        name: "Requester",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: peerAgentId,
        companyId,
        name: "Peer reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const [issue] = await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review this",
      status: "in_review",
      priority: "medium",
      reviewPolicy: policy,
      createdByAgentId: requesterAgentId,
    }).returning();
    return { issue, companyId, requesterAgentId, peerAgentId };
  }

  it("does no database work for the default anyone policy", async () => {
    const noQueryDb = new Proxy({}, {
      get() {
        throw new Error("default policy must not query");
      },
    }) as Db;

    await expect(assertIssueReviewVerdictActorAllowed(noQueryDb, {
      issue: { id: randomUUID(), companyId: randomUUID(), reviewPolicy: null },
      actor: { type: "agent", id: randomUUID() },
    })).resolves.toBeUndefined();
  });

  it("blocks the in-review requester under not_creator and admits another agent", async () => {
    const seeded = await seedReview("not_creator");
    expect(seeded.issue.reviewPolicy).toBe("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.requesterAgentId,
      agentId: seeded.requesterAgentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: { status: "in_review", _previous: { status: "in_progress" } },
    });

    const denied = assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
    });
    await expect(denied).rejects.toMatchObject<HttpError>({
      status: 403,
      details: expect.objectContaining({
        code: "review_policy_denied",
        policy: "not_creator",
        allowedActor: "writer_other_than_review_requester",
      }),
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.peerAgentId },
    })).resolves.toBeUndefined();
  });

  it("ignores later in-review snapshots that did not record a status transition", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values([
      {
        companyId: seeded.companyId,
        actorType: "agent",
        actorId: seeded.requesterAgentId,
        agentId: seeded.requesterAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: seeded.issue.id,
        details: { status: "in_review", _previous: { status: "in_progress" } },
        createdAt: new Date("2026-08-06T00:00:00.000Z"),
      },
      {
        companyId: seeded.companyId,
        actorType: "agent",
        actorId: seeded.peerAgentId,
        agentId: seeded.peerAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: seeded.issue.id,
        details: { status: "in_review", priority: "high" },
        createdAt: new Date("2026-08-06T00:01:00.000Z"),
      },
    ]);

    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
    })).rejects.toMatchObject<HttpError>({
      status: 403,
      details: expect.objectContaining({ code: "review_policy_denied" }),
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.peerAgentId },
    })).resolves.toBeUndefined();
  });

  it("classifies only confirmations created by the review requester as review verdicts", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.requesterAgentId,
      agentId: seeded.requesterAgentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        reviewInteractionId: "review-confirmation",
        _previous: { status: "in_progress" },
      },
    });

    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "review-confirmation", createdByAgentId: seeded.requesterAgentId },
    })).resolves.toBe(true);
    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "review-confirmation", createdByAgentId: seeded.peerAgentId },
    })).resolves.toBe(false);
    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "requester-sibling", createdByAgentId: seeded.requesterAgentId },
    })).resolves.toBe(false);
  });

  it("uses authenticated principal type for human_only", async () => {
    const seeded = await seedReview("human_only");
    expect(seeded.issue.reviewPolicy).toBe("human_only");
    const denied = assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
    });
    await expect(denied).rejects.toMatchObject<HttpError>({
      status: 403,
      details: expect.objectContaining({
        code: "review_policy_denied",
        policy: "human_only",
        allowedActor: "authenticated_user_with_issue_write_access",
      }),
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "user", id: "board-user" },
    })).resolves.toBeUndefined();
  });
});
