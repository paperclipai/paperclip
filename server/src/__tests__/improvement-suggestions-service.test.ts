import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companyMemberships,
  companies,
  createDb,
  heartbeatRuns,
  improvementSuggestions,
  instanceUserRoles,
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
    await db.delete(instanceUserRoles);
    await db.delete(companyMemberships);
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
    const otherAgentId = randomUUID();
    const otherRunId = randomUUID();
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
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other Agent",
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
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId: otherAgentId,
      status: "succeeded",
      contextSnapshot: { issueId },
    });
    return { companyId, agentId, issueId, runId, otherAgentId, otherRunId };
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

    await expect(svc.create(seeded.companyId, {
      targetLayer: "company_skill",
      title: "Spoofed run provenance",
      summary: "An agent must not cite another agent's run as its authenticated source run.",
      proposedChange: "Reject cross-agent source run attribution.",
      evidence: [{ kind: "run", ref: seeded.otherRunId, note: null }],
      sourceIssueId: seeded.issueId,
    }, {
      type: "agent",
      agentId: seeded.agentId,
      runId: seeded.otherRunId,
    })).rejects.toMatchObject({ status: 422 });

    await db.insert(instanceUserRoles).values({ userId: "board-user", role: "instance_admin" });
    const reviewed = await svc.review(seeded.companyId, created.id, {
      decision: "accept",
      note: "Evidence supports making this a universal handoff guardrail.",
    }, { userId: "board-user" });
    expect(reviewed).toMatchObject({
      status: "accepted",
      reviewedByUserId: "board-user",
      reviewNote: "Evidence supports making this a universal handoff guardrail.",
    });
    await expect(svc.review(seeded.companyId, created.id, {
      decision: "reject",
      note: "A second decision must not overwrite the audit trail.",
    }, { userId: "board-user" })).rejects.toMatchObject({ status: 409 });
  });

  it("records board-directed changes as accepted directives, not agent suggestions", async () => {
    const seeded = await seed();
    const svc = improvementSuggestionService(db);
    await db.insert(companyMemberships).values({
      companyId: seeded.companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "owner",
    });
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
      runId: seeded.runId,
    } as any);

    expect(created).toMatchObject({
      originKind: "board_directed",
      status: "accepted",
      createdByUserId: "board-user",
      reviewedByUserId: "board-user",
      reviewNote: "Recorded as a board-directed change.",
      sourceRunId: null,
    });
    await expect(svc.review(seeded.companyId, created.id, {
      decision: "reject",
      note: "Directives do not enter the suggestion review queue.",
    }, { userId: "board-user" })).rejects.toMatchObject({ status: 409 });
  });

  it("creates one linked implementation issue for an accepted suggestion", async () => {
    const seeded = await seed();
    const svc = improvementSuggestionService(db);
    await db.insert(companyMemberships).values({
      companyId: seeded.companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "owner",
    });
    const accepted = await svc.create(seeded.companyId, {
      targetLayer: "company_skill",
      title: "Require source checks",
      summary: "The company repeatedly accepted work without checking the source.",
      proposedChange: "Add a source verification checklist to the company skill.",
      evidence: [{ kind: "issue", ref: seeded.issueId, note: "Original failure" }],
      sourceIssueId: seeded.issueId,
    }, {
      type: "board",
      userId: "board-user",
    });

    const first = await svc.createImplementationIssue(
      seeded.companyId,
      accepted.id,
      {},
      { userId: "board-user" },
    );
    expect(first.created).toBe(true);
    expect(first.issue).toMatchObject({
      companyId: seeded.companyId,
      originKind: "improvement_suggestion",
      originId: accepted.id,
      status: "todo",
      assigneeAgentId: seeded.agentId,
      parentId: null,
    });
    expect(first.issue.description).toContain("Add a source verification checklist to the company skill.");
    expect(first.suggestion.implementationIssue).toMatchObject({ id: first.issue.id });

    const second = await svc.createImplementationIssue(
      seeded.companyId,
      accepted.id,
      {},
      { userId: "board-user" },
    );
    expect(second.created).toBe(false);
    expect(second.issue.id).toBe(first.issue.id);

    const linkedIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, accepted.id));
    expect(linkedIssues).toHaveLength(1);
  });

  it("reserves root-level directives and reviews for instance administrators", async () => {
    const seeded = await seed();
    const svc = improvementSuggestionService(db);
    await db.insert(companyMemberships).values([
      {
        companyId: seeded.companyId,
        principalType: "user",
        principalId: "owner-user",
        status: "active",
        membershipRole: "owner",
      },
      {
        companyId: seeded.companyId,
        principalType: "user",
        principalId: "admin-user",
        status: "active",
        membershipRole: "admin",
      },
      {
        companyId: seeded.companyId,
        principalType: "user",
        principalId: "operator-user",
        status: "active",
        membershipRole: "operator",
      },
    ]);

    const companyInput = {
      targetLayer: "company_skill" as const,
      title: "Improve local triage",
      summary: "The company needs a stronger triage procedure.",
      proposedChange: "Add a company-specific triage checklist.",
      evidence: [{ kind: "issue" as const, ref: seeded.issueId, note: null }],
      sourceIssueId: seeded.issueId,
    };
    await expect(svc.create(seeded.companyId, companyInput, {
      type: "board",
      userId: "operator-user",
    })).rejects.toMatchObject({ status: 403 });

    const companyDirective = await svc.create(seeded.companyId, companyInput, {
      type: "board",
      userId: "owner-user",
    });
    expect(companyDirective.originKind).toBe("board_directed");
    const adminDirective = await svc.create(seeded.companyId, {
      ...companyInput,
      title: "Admin-directed local triage",
    }, {
      type: "board",
      userId: "admin-user",
    });
    expect(adminDirective.originKind).toBe("board_directed");

    await expect(svc.create(seeded.companyId, {
      ...companyInput,
      targetLayer: "orchestration_code",
      title: "Change the root harness",
    }, {
      type: "board",
      userId: "owner-user",
    })).rejects.toMatchObject({ status: 403 });

    const pendingRoot = await svc.create(seeded.companyId, {
      ...companyInput,
      targetLayer: "root_skill",
      title: "Agent-detected root change",
    }, {
      type: "agent",
      agentId: seeded.agentId,
      runId: seeded.runId,
    });
    await expect(svc.review(seeded.companyId, pendingRoot.id, {
      decision: "accept",
      note: "Company owners cannot approve root changes.",
    }, { userId: "owner-user" })).rejects.toMatchObject({ status: 403 });

    await db.insert(instanceUserRoles).values({ userId: "instance-admin", role: "instance_admin" });
    const accepted = await svc.review(seeded.companyId, pendingRoot.id, {
      decision: "accept",
      note: "Instance administrator accepts the root-level improvement.",
    }, { userId: "instance-admin" });
    expect(accepted.status).toBe("accepted");
  });
});
