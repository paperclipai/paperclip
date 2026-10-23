import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  issueApprovals,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { githubPrClosureSweepService } from "./github-pr-closure-sweep.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping github-pr-closure-sweep tests on this host: ${support.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("githubPrClosureSweepService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-closure-sweep-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    // Clean up in dependency order
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seed(opts: {
    issueStatus?: string;
    approvalStatus?: string;
    prRepo?: string;
    prNumber?: number;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const approvalId = randomUUID();
    const owner = "acme";
    const repo = opts.prRepo ?? "acme-app";
    const prNumber = opts.prNumber ?? 42;

    await db.insert(companies).values({
      id: companyId,
      name: "Sweep Test Co",
      issuePrefix: "SWP",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implement feature X",
      status: opts.issueStatus ?? "in_review",
      assigneeAgentId: agentId,
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: opts.approvalStatus ?? "pending",
      payload: {
        title: "Approve feature X",
        prs: [{ repo: `${owner}/${repo}`, number: prNumber, sha: "abc123" }],
      },
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId,
      approvalId,
    });

    return { companyId, agentId, issueId, approvalId, owner, repo, prNumber };
  }

  it("happy path: cancels card, moves in_review task to todo, adds comment, wakes agent", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);
    const f = await seed({ issueStatus: "in_review" });
    const svc = githubPrClosureSweepService(db, { wakeup });

    const result = await svc.sweepClosedWithoutMergedPrApprovals([
      { companyId: f.companyId, owner: f.owner, repo: f.repo, number: f.prNumber },
    ]);

    expect(result).toEqual({ checked: 1, cancelled: 1, issuesRouted: 1, woken: 1 });

    // Approval should be cancelled
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, f.approvalId));
    expect(approval?.status).toBe("cancelled");
    expect(approval?.decisionNote).toContain("closed without merging");

    // Issue should be moved to todo
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue?.status).toBe("todo");

    // A comment should have been added
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("PR closed without merging");

    // Wakeup should have been called
    expect(wakeup).toHaveBeenCalledOnce();
    expect(wakeup.mock.calls[0]?.[0]).toBe(f.agentId);
  });

  it("concurrent guard: card already decided, totalCancelled stays 0", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);
    const f = await seed({ approvalStatus: "approved" });
    const svc = githubPrClosureSweepService(db, { wakeup });

    const result = await svc.sweepClosedWithoutMergedPrApprovals([
      { companyId: f.companyId, owner: f.owner, repo: f.repo, number: f.prNumber },
    ]);

    // Approval was already decided so it doesn't match pending filter
    expect(result.checked).toBe(0);
    expect(result.cancelled).toBe(0);
    expect(result.issuesRouted).toBe(0);
    expect(result.woken).toBe(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("no linked tasks: cancels card but routes nothing", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);
    const companyId = randomUUID();
    const approvalId = randomUUID();
    const owner = "acme";
    const repo = "no-tasks-repo";
    const prNumber = 99;

    await db.insert(companies).values({ id: companyId, name: "No Tasks Co", issuePrefix: "NTK" });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: {
        title: "Approve something",
        prs: [{ repo: `${owner}/${repo}`, number: prNumber, sha: "def456" }],
      },
    });
    // No issueApprovals rows

    const svc = githubPrClosureSweepService(db, { wakeup });
    const result = await svc.sweepClosedWithoutMergedPrApprovals([
      { companyId, owner, repo, number: prNumber },
    ]);

    expect(result.checked).toBe(1);
    expect(result.cancelled).toBe(1);
    expect(result.issuesRouted).toBe(0);
    expect(result.woken).toBe(0);
    expect(wakeup).not.toHaveBeenCalled();

    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval?.status).toBe("cancelled");
  });

  it("task with non-matching status is not re-routed", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);
    const f = await seed({ issueStatus: "done" });
    const svc = githubPrClosureSweepService(db, { wakeup });

    const result = await svc.sweepClosedWithoutMergedPrApprovals([
      { companyId: f.companyId, owner: f.owner, repo: f.repo, number: f.prNumber },
    ]);

    // Card is cancelled
    expect(result.checked).toBe(1);
    expect(result.cancelled).toBe(1);
    // But done task is not in the linked issues query (status filter)
    expect(result.issuesRouted).toBe(0);
    expect(result.woken).toBe(0);

    // Issue should remain done
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue?.status).toBe("done");
  });

  it("blocked task with other active blockers keeps blocked status but gets a comment", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);
    const f = await seed({ issueStatus: "blocked" });

    // Create a second blocker issue that is still active
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId: f.companyId,
      title: "Other blocker",
      status: "in_progress",
    });
    // issueRelations: blockerId blocks f.issueId
    await db.insert(issueRelations).values({
      companyId: f.companyId,
      issueId: blockerId,
      relatedIssueId: f.issueId,
      type: "blocks",
    });

    const svc = githubPrClosureSweepService(db, { wakeup });
    const result = await svc.sweepClosedWithoutMergedPrApprovals([
      { companyId: f.companyId, owner: f.owner, repo: f.repo, number: f.prNumber },
    ]);

    // Card cancelled, issue found, but status change skipped
    expect(result.checked).toBe(1);
    expect(result.cancelled).toBe(1);
    expect(result.issuesRouted).toBe(0);

    // Issue should remain blocked (not moved to todo)
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue?.status).toBe("blocked");

    // But a comment should still have been added
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("PR closed without merging");
  });

  it("blocked task whose only active blocker is the now-cancelled card moves to todo", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);
    const f = await seed({ issueStatus: "blocked" });
    // No other issueRelations rows — the approval card was the only blocker

    const svc = githubPrClosureSweepService(db, { wakeup });
    const result = await svc.sweepClosedWithoutMergedPrApprovals([
      { companyId: f.companyId, owner: f.owner, repo: f.repo, number: f.prNumber },
    ]);

    expect(result.issuesRouted).toBe(1);

    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue?.status).toBe("todo");
  });

  it("returns zeros when no hints are provided", async () => {
    const svc = githubPrClosureSweepService(db);
    const result = await svc.sweepClosedWithoutMergedPrApprovals([]);
    expect(result).toEqual({ checked: 0, cancelled: 0, issuesRouted: 0, woken: 0 });
  });

  it("cross-company: task in another company is not routed", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);
    const f = await seed({ issueStatus: "in_review" });

    // Second company with its own issue linked to the SAME approval
    const otherCompanyId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other Co", issuePrefix: "OTH" });
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: otherCompanyId,
      title: "Other company task",
      status: "in_review",
    });
    await db.insert(issueApprovals).values({
      companyId: otherCompanyId,
      issueId: otherIssueId,
      approvalId: f.approvalId,
    });

    const svc = githubPrClosureSweepService(db, { wakeup });
    const result = await svc.sweepClosedWithoutMergedPrApprovals([
      { companyId: f.companyId, owner: f.owner, repo: f.repo, number: f.prNumber },
    ]);

    // Only the first company's task should be routed
    expect(result.issuesRouted).toBe(1);

    const [otherIssue] = await db.select().from(issues).where(eq(issues.id, otherIssueId));
    expect(otherIssue?.status).toBe("in_review");
  });

  it("duplicate card links: task processed only once even with two cancelled cards", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);
    const f = await seed({ issueStatus: "in_review" });

    // Second approval card in the same company referencing the same PR
    const approval2Id = randomUUID();
    await db.insert(approvals).values({
      id: approval2Id,
      companyId: f.companyId,
      type: "request_board_approval",
      status: "pending",
      payload: {
        title: "Second approval card for same PR",
        prs: [{ repo: `${f.owner}/${f.repo}`, number: f.prNumber, sha: "def456" }],
      },
    });
    await db.insert(issueApprovals).values({
      companyId: f.companyId,
      issueId: f.issueId,
      approvalId: approval2Id,
    });

    const svc = githubPrClosureSweepService(db, { wakeup });
    const result = await svc.sweepClosedWithoutMergedPrApprovals([
      { companyId: f.companyId, owner: f.owner, repo: f.repo, number: f.prNumber },
    ]);

    expect(result.checked).toBe(2);
    expect(result.cancelled).toBe(2);
    // Despite two links, issue should be routed only once
    expect(result.issuesRouted).toBe(1);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(comments).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledOnce();
  });

  it("malformed prs payload does not throw, card is skipped", async () => {
    const companyId = randomUUID();
    const approvalId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Malformed Co", issuePrefix: "MAL" });
    // Approval with prs: null (malformed)
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Bad payload", prs: null },
    });

    const svc = githubPrClosureSweepService(db);
    await expect(
      svc.sweepClosedWithoutMergedPrApprovals([
        { companyId, owner: "acme", repo: "acme-app", number: 42 },
      ]),
    ).resolves.toMatchObject({ checked: 0, cancelled: 0 });
  });
});
