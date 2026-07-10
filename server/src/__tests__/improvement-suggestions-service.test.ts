import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  improvementSuggestions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { improvementSuggestionService } from "../services/improvement-suggestions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres improvement suggestion tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("improvement suggestion governance workflow", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-improvement-suggestions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(improvementSuggestions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Governance Auditor",
      role: "general",
      adapterType: "codex_local",
      status: "idle",
      adapterConfig: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Investigate recurring handoff loss",
      status: "in_progress",
      priority: "medium",
      createdByAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { issueId },
    });
    return { companyId, agentId, issueId, runId };
  }

  it("keeps agent-detected suggestions pending until a board decision", async () => {
    const seeded = await seed();
    const svc = improvementSuggestionService(db);
    const created = await svc.create(seeded.companyId, {
      targetLayer: "root_skill",
      title: "Preserve handoff sources",
      summary: "Repeated executor runs lost the authoritative reference.",
      proposedChange: "Require source-of-truth references in every delegated execution contract.",
      evidence: [{ kind: "run", ref: seeded.runId, note: "Run ended without the cited source." }],
      sourceIssueId: seeded.issueId,
    }, {
      type: "agent",
      agentId: seeded.agentId,
      runId: seeded.runId,
    });

    expect(created).toMatchObject({
      originKind: "agent_detected",
      status: "pending_review",
      sourceIssueId: seeded.issueId,
      sourceRunId: seeded.runId,
      createdByAgentId: seeded.agentId,
      reviewedAt: null,
    });

    const reviewed = await svc.review(seeded.companyId, created.id, {
      decision: "accept",
      note: "Evidence supports making this a universal handoff guardrail.",
    }, "board-user");
    expect(reviewed).toMatchObject({
      status: "accepted",
      reviewedByUserId: "board-user",
      reviewNote: "Evidence supports making this a universal handoff guardrail.",
    });
    await expect(svc.review(seeded.companyId, created.id, {
      decision: "reject",
      note: "A second decision must not overwrite the audit trail.",
    }, "other-board-user")).rejects.toMatchObject({ status: 409 });
  });

  it("records board-directed changes as accepted directives, not agent suggestions", async () => {
    const seeded = await seed();
    const svc = improvementSuggestionService(db);
    const created = await svc.create(seeded.companyId, {
      targetLayer: "company_sop",
      title: "Adopt a weekly incident review",
      summary: "The board is directing a standing review cadence.",
      proposedChange: "Review unresolved improvement suggestions every Friday.",
      evidence: [{ kind: "issue", ref: seeded.issueId, note: null }],
      sourceIssueId: seeded.issueId,
    }, {
      type: "board",
      userId: "board-user",
    });

    expect(created).toMatchObject({
      originKind: "board_directed",
      status: "accepted",
      createdByUserId: "board-user",
      reviewedByUserId: "board-user",
      reviewNote: "Recorded as a board-directed change.",
    });
    await expect(svc.review(seeded.companyId, created.id, {
      decision: "reject",
      note: "Directives do not enter the suggestion review queue.",
    }, "board-user")).rejects.toMatchObject({ status: 409 });
  });
});
