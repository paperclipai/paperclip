import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { activityService } from "../services/activity.ts";

function createDbStub(rows: unknown[] = []) {
  const query = {
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    then: vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(rows))),
  };

  const from = vi.fn(() => query);
  const select = vi.fn(() => ({ from }));

  return {
    db: {
      select,
    },
    query,
    select,
    from,
  };
}

describe("activityService.forIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clamps the limit to 100 and preserves newest-first ordering", async () => {
    const rows = [
      {
        id: "event-1",
        createdAt: new Date("2026-03-31T12:35:00.000Z"),
      },
      {
        id: "event-2",
        createdAt: new Date("2026-03-31T12:34:00.000Z"),
      },
    ];
    const dbStub = createDbStub(rows);
    const svc = activityService(dbStub.db as any);

    const result = await svc.forIssue("issue-1", {
      action: "issue.comment_added",
      cursor: "2026-03-31T12:36:00.000Z",
      limit: 250,
    });

    expect(dbStub.select).toHaveBeenCalledTimes(1);
    expect(dbStub.from).toHaveBeenCalledTimes(1);
    expect(dbStub.query.where).toHaveBeenCalledTimes(1);
    expect(dbStub.query.orderBy).toHaveBeenCalledTimes(1);
    expect(dbStub.query.limit).toHaveBeenCalledWith(100);
    expect(result).toEqual(rows);
  });

  it("does not apply a default limit when none is provided", async () => {
    const dbStub = createDbStub([]);
    const svc = activityService(dbStub.db as any);

    await svc.forIssue("issue-1");

    expect(dbStub.query.limit).not.toHaveBeenCalled();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("activityService.forIssue pagination cursor", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof activityService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeEach(async () => {
    if (!tempDb) {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-service-");
      db = createDb(tempDb.connectionString);
      svc = activityService(db);
    }
  });

  afterEach(async () => {
    if (!tempDb) return;
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("supports compound cursor timestamps without skipping same-timestamp events", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const eventNewestAt = new Date("2026-03-31T12:35:00.000Z");
    const eventNewestId = "f0000000-0000-4000-8000-000000000001";
    const sameTimestampNextId = "a0000000-0000-4000-8000-000000000002";
    const olderEventId = "90000000-0000-4000-8000-000000000003";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "ACT",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(activityLog).values([
      {
        id: olderEventId,
        companyId,
        actorType: "agent",
        actorId: "agent-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { order: "older" },
        createdAt: new Date("2026-03-31T12:34:00.000Z"),
      },
      {
        id: sameTimestampNextId,
        companyId,
        actorType: "agent",
        actorId: "agent-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { order: "same-ts-next" },
        createdAt: eventNewestAt,
      },
      {
        id: eventNewestId,
        companyId,
        actorType: "agent",
        actorId: "agent-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { order: "newest" },
        createdAt: eventNewestAt,
      },
    ]);

    const page = await svc.forIssue(issueId, {
      cursor: `${eventNewestAt.toISOString()}|${eventNewestId}`,
      limit: 10,
    });

    expect(page.map((event) => event.id)).toEqual([sameTimestampNextId, olderEventId]);
  });
});
