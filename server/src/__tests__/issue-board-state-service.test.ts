import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { computeIssueBoardStateMap } from "../services/issue-board-state.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describeEmbeddedPostgres("issue board state service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-board-state-");
    db = createDb(tempDb.connectionString);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("picks the highest-impact root blocker for a multi-level dependency chain", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Coma",
      issuePrefix: "COMA",
      requireBoardApprovalForNewAgents: false,
    });

    const leafIssueId = randomUUID();
    const immediateBlockerId = randomUUID();
    const middleBlockerId = randomUUID();
    const primaryRootId = randomUUID();
    const alternateImmediateId = randomUUID();
    const alternateRootId = randomUUID();
    const siblingBlockedId = randomUUID();

    await db.insert(issues).values([
      {
        id: leafIssueId,
        companyId,
        issueNumber: 1118,
        identifier: "COMA-1118",
        title: "Leaf issue",
        status: "blocked",
        priority: "medium",
      },
      {
        id: immediateBlockerId,
        companyId,
        issueNumber: 1114,
        identifier: "COMA-1114",
        title: "Immediate blocker",
        status: "blocked",
        priority: "medium",
      },
      {
        id: middleBlockerId,
        companyId,
        issueNumber: 1107,
        identifier: "COMA-1107",
        title: "Middle blocker",
        status: "blocked",
        priority: "high",
      },
      {
        id: primaryRootId,
        companyId,
        issueNumber: 1098,
        identifier: "COMA-1098",
        title: "Primary root blocker",
        status: "todo",
        priority: "critical",
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: alternateImmediateId,
        companyId,
        issueNumber: 1115,
        identifier: "COMA-1115",
        title: "Alternate blocker",
        status: "blocked",
        priority: "medium",
      },
      {
        id: alternateRootId,
        companyId,
        issueNumber: 1099,
        identifier: "COMA-1099",
        title: "Alternate root blocker",
        status: "todo",
        priority: "high",
        updatedAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        id: siblingBlockedId,
        companyId,
        issueNumber: 1120,
        identifier: "COMA-1120",
        title: "Sibling blocked issue",
        status: "blocked",
        priority: "medium",
      },
    ]);

    await db.insert(issueRelations).values([
      { companyId, issueId: immediateBlockerId, relatedIssueId: leafIssueId, type: "blocks" },
      { companyId, issueId: middleBlockerId, relatedIssueId: immediateBlockerId, type: "blocks" },
      { companyId, issueId: primaryRootId, relatedIssueId: middleBlockerId, type: "blocks" },
      { companyId, issueId: alternateImmediateId, relatedIssueId: leafIssueId, type: "blocks" },
      { companyId, issueId: alternateRootId, relatedIssueId: alternateImmediateId, type: "blocks" },
      { companyId, issueId: primaryRootId, relatedIssueId: siblingBlockedId, type: "blocks" },
    ]);

    const result = await computeIssueBoardStateMap(db, companyId, [leafIssueId], { includePaths: true });
    const computed = result.get(leafIssueId);

    expect(computed?.boardState.headline).toBe("Blocked by COMA-1098");
    expect(computed?.primaryBlocker?.identifier).toBe("COMA-1098");
    expect(computed?.blockerPath?.map((node) => node.identifier)).toEqual([
      "COMA-1114",
      "COMA-1107",
      "COMA-1098",
    ]);
    expect(computed?.rootBlockers?.map((blocker) => blocker.identifier)).toEqual([
      "COMA-1098",
      "COMA-1099",
    ]);
  });

  it("dedupes shared descendants when ranking root blockers", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Coma",
      issuePrefix: "COMA",
      requireBoardApprovalForNewAgents: false,
    });

    const leafIssueId = randomUUID();
    const rootAId = randomUUID();
    const rootBId = randomUUID();
    const immediateAId = randomUUID();
    const immediateBId = randomUUID();
    const siblingA1Id = randomUUID();
    const siblingA2Id = randomUUID();
    const sharedAId = randomUUID();
    const siblingB1Id = randomUUID();
    const siblingB2Id = randomUUID();
    const siblingB3Id = randomUUID();
    const siblingB4Id = randomUUID();

    await db.insert(issues).values([
      {
        id: leafIssueId,
        companyId,
        issueNumber: 1200,
        identifier: "COMA-1200",
        title: "Leaf issue",
        status: "blocked",
        priority: "medium",
      },
      {
        id: immediateAId,
        companyId,
        issueNumber: 1201,
        identifier: "COMA-1201",
        title: "Immediate blocker A",
        status: "blocked",
        priority: "medium",
      },
      {
        id: immediateBId,
        companyId,
        issueNumber: 1202,
        identifier: "COMA-1202",
        title: "Immediate blocker B",
        status: "blocked",
        priority: "medium",
      },
      {
        id: rootAId,
        companyId,
        issueNumber: 1203,
        identifier: "COMA-1203",
        title: "Shared-descendant root",
        status: "todo",
        priority: "critical",
      },
      {
        id: rootBId,
        companyId,
        issueNumber: 1204,
        identifier: "COMA-1204",
        title: "Wider root",
        status: "todo",
        priority: "high",
      },
      {
        id: siblingA1Id,
        companyId,
        issueNumber: 1205,
        identifier: "COMA-1205",
        title: "A sibling 1",
        status: "blocked",
        priority: "medium",
      },
      {
        id: siblingA2Id,
        companyId,
        issueNumber: 1206,
        identifier: "COMA-1206",
        title: "A sibling 2",
        status: "blocked",
        priority: "medium",
      },
      {
        id: sharedAId,
        companyId,
        issueNumber: 1207,
        identifier: "COMA-1207",
        title: "Shared descendant",
        status: "blocked",
        priority: "medium",
      },
      {
        id: siblingB1Id,
        companyId,
        issueNumber: 1208,
        identifier: "COMA-1208",
        title: "B sibling 1",
        status: "blocked",
        priority: "medium",
      },
      {
        id: siblingB2Id,
        companyId,
        issueNumber: 1209,
        identifier: "COMA-1209",
        title: "B sibling 2",
        status: "blocked",
        priority: "medium",
      },
      {
        id: siblingB3Id,
        companyId,
        issueNumber: 1210,
        identifier: "COMA-1210",
        title: "B sibling 3",
        status: "blocked",
        priority: "medium",
      },
      {
        id: siblingB4Id,
        companyId,
        issueNumber: 1211,
        identifier: "COMA-1211",
        title: "B sibling 4",
        status: "blocked",
        priority: "medium",
      },
    ]);

    await db.insert(issueRelations).values([
      { companyId, issueId: immediateAId, relatedIssueId: leafIssueId, type: "blocks" },
      { companyId, issueId: rootAId, relatedIssueId: immediateAId, type: "blocks" },
      { companyId, issueId: rootAId, relatedIssueId: siblingA1Id, type: "blocks" },
      { companyId, issueId: rootAId, relatedIssueId: siblingA2Id, type: "blocks" },
      { companyId, issueId: siblingA1Id, relatedIssueId: sharedAId, type: "blocks" },
      { companyId, issueId: siblingA2Id, relatedIssueId: sharedAId, type: "blocks" },
      { companyId, issueId: immediateBId, relatedIssueId: leafIssueId, type: "blocks" },
      { companyId, issueId: rootBId, relatedIssueId: immediateBId, type: "blocks" },
      { companyId, issueId: rootBId, relatedIssueId: siblingB1Id, type: "blocks" },
      { companyId, issueId: rootBId, relatedIssueId: siblingB2Id, type: "blocks" },
      { companyId, issueId: rootBId, relatedIssueId: siblingB3Id, type: "blocks" },
      { companyId, issueId: rootBId, relatedIssueId: siblingB4Id, type: "blocks" },
    ]);

    const result = await computeIssueBoardStateMap(db, companyId, [leafIssueId], { includePaths: true });
    const computed = result.get(leafIssueId);

    expect(computed?.primaryBlocker?.identifier).toBe("COMA-1204");
    expect(computed?.rootBlockers).toEqual([
      expect.objectContaining({
        identifier: "COMA-1204",
        blockedIssueCount: 6,
      }),
      expect.objectContaining({
        identifier: "COMA-1203",
        blockedIssueCount: 5,
      }),
    ]);
  });

  it("returns Waiting on QA when review context exists without dependency blockers", async () => {
    const companyId = randomUUID();
    const qaAgentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Coma",
      issuePrefix: "COMA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: qaAgentId,
      companyId,
      name: "QA Iris",
      role: "qa",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1300,
      identifier: "COMA-1300",
      title: "Needs QA signoff",
      status: "in_review",
      priority: "high",
      assigneeAgentId: qaAgentId,
    });

    const result = await computeIssueBoardStateMap(db, companyId, [issueId]);
    const computed = result.get(issueId);

    expect(computed?.boardState.kind).toBe("waiting");
    expect(computed?.boardState.headline).toBe("Waiting on QA");
    expect(computed?.boardState.reasonCode).toBe("review");
    expect(computed?.boardState.primaryAction?.type).toBe("open_issue");
    expect(computed?.boardState.primaryAction?.label).toBe("Review QA state");
  });

  it("returns system_error for blocked issues with no blockers", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Coma",
      issuePrefix: "COMA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1400,
      identifier: "COMA-1400",
      title: "Broken blocked issue",
      status: "blocked",
      priority: "medium",
    });

    const result = await computeIssueBoardStateMap(db, companyId, [issueId]);
    const computed = result.get(issueId);

    expect(computed?.boardState.kind).toBe("system_error");
    expect(computed?.boardState.reasonCode).toBe("invalid_state");
    expect(computed?.boardState.headline).toBe("System error in issue state");
  });

  it("collapses recovery chains into a redirect to the terminal successor", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const intermediateIssueId = randomUUID();
    const successorIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Coma",
      issuePrefix: "COMA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        issueNumber: 1500,
        identifier: "COMA-1500",
        title: "Recovered source issue",
        status: "blocked",
        priority: "medium",
      },
      {
        id: successorIssueId,
        companyId,
        issueNumber: 1502,
        identifier: "COMA-1502",
        title: "Latest continuation issue",
        status: "in_progress",
        priority: "high",
      },
      {
        id: intermediateIssueId,
        companyId,
        issueNumber: 1501,
        identifier: "COMA-1501",
        title: "Intermediate continuation issue",
        status: "blocked",
        priority: "high",
      },
    ]);
    await db.insert(issueRelations).values([
      {
        companyId,
        issueId,
        relatedIssueId: intermediateIssueId,
        type: "recovered_by",
      },
      {
        companyId,
        issueId: intermediateIssueId,
        relatedIssueId: successorIssueId,
        type: "recovered_by",
      },
    ]);

    const result = await computeIssueBoardStateMap(db, companyId, [issueId, intermediateIssueId]);
    const computed = result.get(issueId);
    const intermediateComputed = result.get(intermediateIssueId);

    expect(computed?.boardState.kind).toBe("redirected");
    expect(computed?.boardState.reasonCode).toBe("recovery");
    expect(computed?.boardState.headline).toBe("Superseded by COMA-1502");
    expect(computed?.boardState.primaryAction).toEqual({
      type: "open_issue",
      label: "Open successor",
      targetEntity: "issue",
      targetId: successorIssueId,
    });

    expect(intermediateComputed?.boardState.kind).toBe("redirected");
    expect(intermediateComputed?.boardState.headline).toBe("Superseded by COMA-1502");
  });

  it("ignores cancelled blockers when computing the active blocker headline", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const cancelledBlockerId = randomUUID();
    const activeBlockerId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Coma",
      issuePrefix: "COMA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        issueNumber: 1608,
        identifier: "LEB-608",
        title: "Blocked leaf",
        status: "blocked",
        priority: "medium",
      },
      {
        id: cancelledBlockerId,
        companyId,
        issueNumber: 1609,
        identifier: "LEB-609",
        title: "Cancelled blocker",
        status: "cancelled",
        priority: "high",
      },
      {
        id: activeBlockerId,
        companyId,
        issueNumber: 1610,
        identifier: "LEB-610",
        title: "Active blocker",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(issueRelations).values([
      { companyId, issueId: cancelledBlockerId, relatedIssueId: issueId, type: "blocks" },
      { companyId, issueId: activeBlockerId, relatedIssueId: issueId, type: "blocks" },
    ]);

    const result = await computeIssueBoardStateMap(db, companyId, [issueId], { includePaths: true });
    const computed = result.get(issueId);

    expect(computed?.boardState.kind).toBe("blocked");
    expect(computed?.boardState.headline).toBe("Blocked by LEB-610");
    expect(computed?.primaryBlocker?.identifier).toBe("LEB-610");
    expect(computed?.rootBlockers?.map((blocker) => blocker.identifier)).toEqual(["LEB-610"]);
  });
});
