import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import request from "supertest";
import { agents, heartbeatRuns, issueRecoveryActions, issueRelations, issues, statusCards } from "@paperclipai/db";
import { companySearchQuerySchema, createIssueSchema, defaultStatusCardRefreshPolicy, PROVIDER_QUOTA_MONITOR_SERVICE_NAME, type Issue } from "@paperclipai/shared";
import { issueDisplayStatusSql } from "../services/issue-display-status.js";
import { issueService } from "../services/issues.js";
import { companySearchService } from "../services/company-search.js";
import { statusCardService } from "../services/status-cards.js";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres, routeApp,
  seedCompanyWithBoardAccess, useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("Monitoring task presentation", () => {
  const ctx = useEmbeddedPostgres("paperclip-monitoring-status-", {
    resetEach: async (db) => { await db.execute(sql`SET client_min_messages = warning`); await db.execute(sql`TRUNCATE TABLE companies CASCADE`); },
  });

  async function fixture() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Monitoring");
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({ id: agentId, companyId: company.companyId, name: "Monitor owner", role: "engineer", status: "paused", adapterType: "process", adapterConfig: {} });
    const nextCheckAt = new Date(Date.now() + 60 * 60_000);
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId, companyId: company.companyId, title: "Check deployment", status: "in_progress",
      assigneeAgentId: agentId, createdByUserId: company.actor.userId,
      monitorNextCheckAt: nextCheckAt,
      executionPolicy: { mode: "normal", stages: [], commentRequired: false, monitor: { nextCheckAt: nextCheckAt.toISOString(), notes: "Check deployment" } },
    });
    return { ...company, agentId, issueId };
  }

  async function displayStatus(id: string) {
    const [row] = await ctx.db.select({ status: issues.status, displayStatus: issueDisplayStatusSql() }).from(issues).where(eq(issues.id, id));
    return row;
  }

  it("projects a scheduled wait consistently across detail, compact rows, summaries, search and counts", async () => {
    const f = await fixture();
    const svc = issueService(ctx.db);
    expect(await svc.getById(f.issueId)).toMatchObject({ status: "in_progress", displayStatus: "monitoring" });
    expect(await svc.list(f.companyId, { displayStatus: "monitoring", listProjection: "index" })).toEqual([expect.objectContaining({ id: f.issueId, status: "in_progress", displayStatus: "monitoring" })]);
    expect(await svc.count(f.companyId, { displayStatus: "monitoring" })).toBe(1);
    const app = routeApp(ctx.db, f.actor, issueRoutes);
    const summary = await request(app).get(`/api/companies/${f.companyId}/issues/summaries?ids=${f.issueId}`).expect(200);
    expect(summary.body[0]).toMatchObject({ status: "in_progress", displayStatus: "monitoring" });
    const result = await companySearchService(ctx.db).search(f.companyId, companySearchQuerySchema.parse({ q: "deployment", displayStatus: "monitoring" }));
    expect(result.results[0]?.issue).toMatchObject({ id: f.issueId, status: "in_progress", displayStatus: "monitoring" });
    expect(result.filterOptionCounts.displayStatus?.monitoring).toBe(1);
    expect(result.filterOptionCounts.status.in_progress).toBe(1);
    const [card] = await ctx.db.insert(statusCards).values({ companyId: f.companyId, interestPrompt: "Watch deployment", mentionedIssueIds: [f.issueId], refreshPolicy: defaultStatusCardRefreshPolicy }).returning();
    expect(await statusCardService(ctx.db).listMentionedIssues(card!)).toEqual([expect.objectContaining({ id: f.issueId, status: "in_progress", displayStatus: "monitoring" })]);
    // Existing agent/API lifecycle filters keep their original meaning.
    expect(await svc.count(f.companyId, { status: "in_progress" })).toBe(1);
    expect(createIssueSchema.safeParse({ title: "Manual monitoring", status: "monitoring" }).success).toBe(false);
  });

  it("filters before pagination and keeps In Progress separate from Monitoring", async () => {
    const f = await fixture();
    await ctx.db.insert(issues).values({ companyId: f.companyId, title: "Ordinary work", status: "in_progress", assigneeAgentId: f.agentId });
    const svc = issueService(ctx.db);
    expect(await svc.list(f.companyId, { displayStatus: "monitoring", limit: 1, offset: 0 })).toEqual([expect.objectContaining({ id: f.issueId })]);
    expect(await svc.list(f.companyId, { displayStatus: "monitoring", limit: 1, offset: 1 })).toEqual([]);
    expect(await svc.count(f.companyId, { displayStatus: "in_progress" })).toBe(1);
    expect(await svc.count(f.companyId, { status: "in_progress" })).toBe(2);
  });

  it("shows the same wait indicator in list blocker summaries and task detail relations", async () => {
    const f = await fixture();
    const [dependent] = await ctx.db.insert(issues).values({ companyId: f.companyId, title: "Ship after deployment", status: "blocked" }).returning();
    await ctx.db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.issueId, relatedIssueId: dependent!.id, type: "blocks" });
    const svc = issueService(ctx.db);
    const list = await svc.list(f.companyId, { includeBlockedBy: true }) as Array<Awaited<ReturnType<typeof svc.list>>[number] & Pick<Issue, "blockedBy">>;
    expect(list.find(row => row.id === dependent!.id)?.blockedBy).toEqual([expect.objectContaining({ id: f.issueId, displayStatus: "monitoring" })]);
    const detail = await request(routeApp(ctx.db, f.actor, issueRoutes)).get(`/api/issues/${dependent!.id}`).expect(200);
    expect(detail.body.blockedBy).toEqual([expect.objectContaining({ id: f.issueId, displayStatus: "monitoring" })]);
  });

  it("returns to In Progress during the check and Monitoring after another yield, then Done", async () => {
    const f = await fixture();
    const runId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, status: "queued" });
    expect((await displayStatus(f.issueId)).displayStatus).toBe("in_progress");
    await ctx.db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
    await ctx.db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, f.issueId));
    expect((await displayStatus(f.issueId)).displayStatus).toBe("in_progress");
    await ctx.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    await ctx.db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
    expect((await displayStatus(f.issueId)).displayStatus).toBe("monitoring");
    await ctx.db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    expect(await displayStatus(f.issueId)).toEqual({ status: "done", displayStatus: "done" });
  });

  it.each(["blocked", "in_review", "todo", "cancelled"])("preserves %s even with a retained monitor", async (status) => {
    const f = await fixture();
    await ctx.db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    expect((await displayStatus(f.issueId)).displayStatus).toBe(status);
  });

  it("does not label cleared, consumed, orphaned or quota-recovery schedules Monitoring", async () => {
    const f = await fixture();
    await ctx.db.update(issues).set({ executionState: { monitor: { status: "cleared" } } }).where(eq(issues.id, f.issueId));
    expect((await displayStatus(f.issueId)).displayStatus).toBe("in_progress");
    await ctx.db.update(issues).set({ executionState: null, monitorNextCheckAt: null }).where(eq(issues.id, f.issueId));
    expect((await displayStatus(f.issueId)).displayStatus).toBe("in_progress");
    await ctx.db.update(issues).set({ monitorNextCheckAt: new Date(), executionPolicy: { monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME } } }).where(eq(issues.id, f.issueId));
    expect((await displayStatus(f.issueId)).displayStatus).toBe("in_progress");
    await ctx.db.update(issues).set({ executionPolicy: null }).where(eq(issues.id, f.issueId));
    expect((await displayStatus(f.issueId)).displayStatus).toBe("in_progress");
  });

  it("keeps recovery and review holds visible and never writes a new lifecycle state", async () => {
    const f = await fixture();
    await ctx.db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "source", ownerType: "board", cause: "process_lost", fingerprint: randomUUID(), nextAction: "Inspect stopped run" });
    expect((await displayStatus(f.issueId)).displayStatus).toBe("in_progress");
    await ctx.db.execute(sql`UPDATE issue_recovery_actions SET status = 'escalated' WHERE source_issue_id = ${f.issueId}`);
    expect((await displayStatus(f.issueId)).displayStatus).toBe("in_progress");
    await ctx.db.execute(sql`UPDATE issue_recovery_actions SET status = 'resolved' WHERE source_issue_id = ${f.issueId}`);
    expect((await displayStatus(f.issueId)).displayStatus).toBe("monitoring");
    await ctx.db.update(issues).set({ executionState: { currentParticipant: { type: "user", userId: "reviewer" } } }).where(eq(issues.id, f.issueId));
    expect((await displayStatus(f.issueId)).displayStatus).toBe("in_progress");
  });
});
