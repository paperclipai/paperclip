import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildIssueChildrenCompletedWakeIdempotencyKey,
  claimIssueChildrenCompletedWake,
} from "../services/issue-children-completed-wakeup.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("claimIssueChildrenCompletedWake", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-children-completed-wake-claim-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "Watchdog parent assignee" })
      .returning({ id: agents.id });
    return { companyId, agentId: agent.id };
  }

  async function enqueueChildrenCompletedWakeRow(input: {
    companyId: string;
    agentId: string;
    idempotencyKey: string;
  }) {
    await db.insert(agentWakeupRequests).values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      status: "queued",
      idempotencyKey: input.idempotencyKey,
    });
  }

  it("persists at most one wake request when two equivalent child completions race", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const idempotencyKey = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "watchdog-child-1",
      childIssueIds: ["watchdog-child-1"],
    });

    let onClaimedCallCount = 0;
    const onClaimed = async () => {
      onClaimedCallCount += 1;
      await enqueueChildrenCompletedWakeRow({ companyId, agentId, idempotencyKey });
      return "enqueued" as const;
    };

    const [first, second] = await Promise.all([
      claimIssueChildrenCompletedWake(db, { companyId, idempotencyKey }, onClaimed),
      claimIssueChildrenCompletedWake(db, { companyId, idempotencyKey }, onClaimed),
    ]);

    const claimedResults = [first, second].filter((outcome) => outcome.claimed);
    const skippedResults = [first, second].filter((outcome) => !outcome.claimed);
    expect(claimedResults).toHaveLength(1);
    expect(skippedResults).toHaveLength(1);
    expect(onClaimedCallCount).toBe(1);

    const persisted = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
    expect(persisted).toHaveLength(1);
  });

  it("still claims independently when the sibling topology differs", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const firstKey = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "child-1",
      childIssueIds: ["child-1"],
    });
    const secondKey = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "child-1",
      childIssueIds: ["child-1", "child-2"],
    });

    const first = await claimIssueChildrenCompletedWake(
      db,
      { companyId, idempotencyKey: firstKey },
      async () => enqueueChildrenCompletedWakeRow({ companyId, agentId, idempotencyKey: firstKey }),
    );
    const second = await claimIssueChildrenCompletedWake(
      db,
      { companyId, idempotencyKey: secondKey },
      async () => enqueueChildrenCompletedWakeRow({ companyId, agentId, idempotencyKey: secondKey }),
    );

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(true);
  });

  it("retries a transient claim failure and still claims exactly once", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const idempotencyKey = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "watchdog-child-1",
      childIssueIds: ["watchdog-child-1"],
    });

    let onClaimedCallCount = 0;
    const onClaimed = async () => {
      onClaimedCallCount += 1;
      if (onClaimedCallCount < 2) {
        throw new Error("simulated transient database fault");
      }
      await enqueueChildrenCompletedWakeRow({ companyId, agentId, idempotencyKey });
      return "enqueued" as const;
    };

    const outcome = await claimIssueChildrenCompletedWake(db, { companyId, idempotencyKey }, onClaimed);

    expect(outcome.claimed).toBe(true);
    expect(onClaimedCallCount).toBe(2);

    const persisted = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
    expect(persisted).toHaveLength(1);
  });

  it("throws after exhausting retries so the caller can fail closed", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const idempotencyKey = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "watchdog-child-1",
      childIssueIds: ["watchdog-child-1"],
    });

    let onClaimedCallCount = 0;
    const onClaimed = async () => {
      onClaimedCallCount += 1;
      throw new Error("simulated sustained database fault");
    };

    await expect(
      claimIssueChildrenCompletedWake(db, { companyId, idempotencyKey }, onClaimed),
    ).rejects.toThrow("simulated sustained database fault");
    expect(onClaimedCallCount).toBe(3);

    const persisted = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
    expect(persisted).toHaveLength(0);
  });
});
