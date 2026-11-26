import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import { activityLog, issueComments, issueReadStates, issues } from "@paperclipai/db";
import { isAgentCreatedIssue } from "@paperclipai/shared";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { describeEmbeddedPostgres, resetCompanyIssueFixtures, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue creation visibility", () => {
  const ctx = useEmbeddedPostgres("paperclip-creation-visibility-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await resetCompanyIssueFixtures(db);
    },
  });

  it("filters ordinary and compact searches before pagination without changing API defaults", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Creation visibility");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other company");
    const rows = [
      { id: randomUUID(), companyId, title: "Visibility human", createdByUserId: userId, originKind: "manual" },
      { id: randomUUID(), companyId, title: "Visibility second human", createdByUserId: userId, originKind: "manual" },
      { id: randomUUID(), companyId, title: "Visibility channel", createdByUserId: userId, originKind: "chat_channel" },
      { id: randomUUID(), companyId, title: "Visibility onboarding", createdByUserId: userId, originKind: "onboarding_first_task" },
      { id: randomUUID(), companyId, title: "Visibility inbound email", originKind: "chat_channel", originId: "email:endpoint:thread" },
      { id: randomUUID(), companyId, title: "Visibility outbound email", originKind: "chat_channel", originId: "email-send:tool-call" },
      ...["routine_execution", "task_watchdog", "stranded_issue_recovery", "plugin:workflow:task", "harness_liveness_escalation", "manual"].map((originKind) => ({ id: randomUUID(), companyId, title: `Visibility ${originKind}`, originKind, responsibleUserId: userId })),
      { id: randomUUID(), companyId, title: "Visibility manually run routine", createdByUserId: userId, originKind: "routine_execution" },
    ];
    await ctx.db.insert(issues).values([
      ...rows.map((row, index) => ({ ...row, status: "todo", updatedAt: new Date(2026, 9, 13, 0, index) })),
      { companyId: other.companyId, title: "Visibility other company", createdByUserId: other.userId },
      { companyId, title: "Visibility private task", createdByUserId: other.userId, visibility: "private" },
    ]);
    const app = routeApp(ctx.db, actor, issueRoutes);
    const path = `/api/companies/${companyId}/issues`;
    const defaults = await request(app).get(`${path}?includeRoutineExecutions=true`).expect(200);
    expect(defaults.body).toHaveLength(rows.length);
    for (const view of ["", "&view=compact"]) {
      const first = await request(app).get(`${path}?includeAgentCreatedTasks=false&q=Visibility&sortField=updated&limit=2${view}`).expect(200);
      const second = await request(app).get(`${path}?includeAgentCreatedTasks=false&q=Visibility&sortField=updated&limit=2&offset=2${view}`).expect(200);
      expect(first.body).toHaveLength(2);
      expect(second.body).toHaveLength(1);
      expect([...first.body, ...second.body].every((issue: Parameters<typeof isAgentCreatedIssue>[0]) => !isAgentCreatedIssue(issue))).toBe(true);
    }
    await request(app).get(`${path}?includeAgentCreatedTasks=invalid`).expect(400);
    await request(app).get(`${path}?includeParticipatedTasks=invalid`).expect(400);
    await request(app).get(`/api/companies/${other.companyId}/issues?includeAgentCreatedTasks=false`).expect(403);
  });

  it("preserves participation but excludes routine ownership and read-only activity", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Inbox participation");
    const ids = Object.fromEntries(["scheduled", "commented", "assigned", "manual", "read", "touched", "channelScheduled", "channelCommented", "channelManual"].map((name) => [name, randomUUID()]));
    await ctx.db.insert(issues).values(Object.entries(ids).map(([name, id]) => ({
      id, companyId, title: `Participation ${name}`, status: "todo", originKind: name.startsWith("channel") ? "chat_channel" : "routine_execution",
      responsibleUserId: userId,
      assigneeUserId: name === "assigned" ? userId : null,
      createdByUserId: name === "manual" || name === "channelManual" ? userId : null,
    })));
    await ctx.db.insert(issueComments).values([ids.commented!, ids.channelCommented!].map((issueId) => ({ companyId, issueId, authorUserId: userId, body: "I joined this task" })));
    await ctx.db.insert(issueReadStates).values({ companyId, issueId: ids.read!, userId, lastReadAt: new Date() });
    await ctx.db.insert(activityLog).values([
      { companyId, entityType: "issue", entityId: ids.read!, actorType: "user", actorId: userId, action: "issue.read_marked" },
      { companyId, entityType: "issue", entityId: ids.touched!, actorType: "user", actorId: userId, action: "issue.inbox_touched" },
    ]);
    const app = routeApp(ctx.db, actor, issueRoutes);
    const path = `/api/companies/${companyId}/issues`;
    const mine = await request(app).get(`${path}?touchedByUserId=me&inboxArchivedByUserId=me&includeRoutineExecutions=true`).expect(200);
    const expected = [ids.commented, ids.assigned, ids.manual, ids.touched, ids.channelCommented, ids.channelManual].sort();
    expect(mine.body.map((issue: { id: string }) => issue.id).sort()).toEqual(expected);
    const discovery = await request(app).get(`${path}?q=Participation&includeAgentCreatedTasks=false&includeParticipatedTasks=true`).expect(200);
    expect(discovery.body.map((issue: { id: string }) => issue.id).sort()).toEqual(expected);
    const strict = await issueService(ctx.db).list(companyId, { includeAgentCreatedTasks: false });
    expect(strict).toEqual([]);
  });
});
