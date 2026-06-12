import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issueRelations, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue detail attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.getBlockedInboxAttention", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-detail-attention-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix = "ATT") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: `${prefix} Agent`, role: "engineer", status: "idle" });
    return { companyId, agentId };
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    status: string;
    assigneeAgentId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      originKind: "manual",
      originFingerprint: "default",
    });
    return id;
  }

  it("matches the list path's attention for the same issue (detail/list parity)", async () => {
    const { companyId, agentId } = await seedCompany("ATR");
    // Blocker is in review, assigned to an agent, with no review participant;
    // the dependent is blocked on it.
    const blockerId = await insertIssue({
      companyId,
      identifier: "ATR-4",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    const blockedId = await insertIssue({ companyId, identifier: "ATR-5", status: "blocked", assigneeAgentId: agentId });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    // The contract: the single-issue helper returns exactly what the list path
    // computes for that issue (whatever the classifier decides).
    const listed = await svc.list(companyId, {
      attention: "blocked",
      includeBlockedInboxAttention: true,
      includeBlockedBy: true,
    } as Parameters<typeof svc.list>[1]);
    const fromList = listed.find((i) => i.id === blockedId)?.blockedInboxAttention ?? null;

    const fromDetail = await svc.getBlockedInboxAttention(companyId, blockedId);
    expect(fromDetail).toEqual(fromList);
  });

  it("returns null for a plain unblocked issue", async () => {
    const { companyId } = await seedCompany("ATN");
    const id = await insertIssue({ companyId, identifier: "ATN-1", status: "todo" });
    expect(await svc.getBlockedInboxAttention(companyId, id)).toBeNull();
  });
});
