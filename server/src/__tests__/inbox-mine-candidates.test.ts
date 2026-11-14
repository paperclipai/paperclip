import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  activityLog, agents, companies, heartbeatRuns, issueComments, issueInboxArchives, issueReadStates, issues, issueThreadInteractions,
} from "@paperclipai/db";
import { INBOX_MINE_ISSUE_STATUS_FILTER } from "@paperclipai/shared";
import { expect, it } from "vitest";
import { issueReadSqlCondition } from "../services/authorization.js";
import { issueService, type IssueFilters } from "../services/issues.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

// The Mine list ranks candidates from the participation UNION
// (`touchedCandidates: "participation"`). These tests run the original
// `touchedByUserCondition` scan beside it and require identical ordered rows.
describeEmbeddedPostgres("Mine inbox participation candidates", () => {
  const ctx = useEmbeddedPostgres("inbox-mine-candidates-");
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute));

  async function mineFilters(userId: string, overrides: Partial<IssueFilters> = {}): Promise<IssueFilters> {
    return {
      readCondition: await issueReadSqlCondition(ctx.db, { type: "board", source: "session", userId, authorizingUserId: userId } as never),
      touchedByUserId: userId, inboxArchivedByUserId: userId,
      status: INBOX_MINE_ISSUE_STATUS_FILTER, listProjection: "index",
      sortField: "updated", sortDir: "desc", limit: 100,
      includeRoutineExecutions: true, includeLiveDescendantSummary: true,
      ...overrides,
    };
  }

  async function compare(companyId: string, filters: IssueFilters) {
    const svc = issueService(ctx.db);
    const scan = await svc.list(companyId, filters);
    const ranked = await svc.list(companyId, { ...filters, touchedCandidates: "participation" });
    expect(ranked.map((row) => row.id)).toEqual(scan.map((row) => row.id));
    expect(JSON.parse(JSON.stringify(ranked))).toEqual(JSON.parse(JSON.stringify(scan)));
    return scan.map((row) => row.id);
  }

  it("selects the same ordered rows and payloads as the touched scan across participation edge cases", async () => {
    const companyId = randomUUID(), foreignCompanyId = randomUUID();
    const userId = `mine-${randomUUID()}`, otherUserId = `other-${randomUUID()}`;
    await ctx.db.insert(companies).values([
      { id: companyId, name: "Mine candidates", issuePrefix: `M${companyId.slice(0, 6).toUpperCase()}` },
      { id: foreignCompanyId, name: "Foreign", issuePrefix: `F${foreignCompanyId.slice(0, 6).toUpperCase()}` },
    ]);
    const [agent] = await ctx.db.insert(agents).values({ companyId, name: "Worker", adapterType: "process", status: "active" }).returning();
    const named = new Map<string, string>();
    const add = async (name: string, values: Partial<typeof issues.$inferInsert> = {}, minute = named.size) => {
      const [row] = await ctx.db.insert(issues).values({
        companyId, title: name, status: "todo", createdByUserId: otherUserId,
        createdAt: at(0), updatedAt: at(minute), ...values,
      }).returning();
      named.set(name, row!.id);
      return row!.id;
    };
    const activity = (issueId: string, values: Partial<typeof activityLog.$inferInsert>) => ctx.db.insert(activityLog).values({
      companyId, entityType: "issue", entityId: issueId, actorType: "user", actorId: userId, action: "issue.updated", createdAt: at(500), ...values,
    });
    const comment = (issueId: string, values: Partial<typeof issueComments.$inferInsert>) => ctx.db.insert(issueComments).values({
      companyId, issueId, body: "note", authorUserId: userId, createdAt: at(400), ...values,
    });

    // Included: every participation source, done work, and re-activated archives.
    await add("created by me", { createdByUserId: userId });
    await add("assigned to me", { assigneeUserId: userId, createdByUserId: null, createdByAgentId: agent!.id });
    await activity(await add("updated by me"), {});
    await comment(await add("commented by me"), {});
    await add("done by me", { createdByUserId: userId, status: "done", completedAt: at(30) });
    const pending = await add("pending request", { createdByUserId: null, createdByAgentId: agent!.id });
    await ctx.db.insert(issueThreadInteractions).values({
      companyId, issueId: pending, kind: "request_confirmation", status: "pending", addresseeUserId: userId,
      payload: { version: 1, prompt: "Confirm?" } as never, createdAt: at(600),
    });
    const reactivated = await add("archived then re-activated", { createdByUserId: userId });
    await ctx.db.insert(issueInboxArchives).values({ companyId, issueId: reactivated, userId, archivedAt: at(700) });
    await comment(reactivated, { authorUserId: otherUserId, createdAt: at(800) });
    const readIssue = await add("read with later agent comment", { createdByUserId: userId });
    await ctx.db.insert(issueReadStates).values({ companyId, issueId: readIssue, userId, lastReadAt: at(900) });
    await comment(readIssue, { authorUserId: null, authorAgentId: agent!.id, createdAt: at(950) });
    const liveChild = await add("live child of mine", { createdByUserId: userId, parentId: named.get("created by me")! });
    const [run] = await ctx.db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running", contextSnapshot: { issueId: liveChild } }).returning();
    await ctx.db.update(issues).set({ executionRunId: run!.id }).where(sql`${issues.id} = ${liveChild}`);

    // Excluded by both selections.
    const archived = await add("archived without new activity", { createdByUserId: userId });
    await ctx.db.insert(issueInboxArchives).values({ companyId, issueId: archived, userId, archivedAt: at(990) });
    await comment(await add("mention only"), { authorUserId: otherUserId, body: `@${userId} please look` });
    await activity(await add("read audit only"), { action: "issue.read_marked" });
    const upper = await add("uppercase entity id");
    await activity(upper, { entityId: upper.toUpperCase() });
    await comment(await add("channel comment"), { metadata: { sourceChannel: "slack" } as never });
    await add("agent created with my user id", { createdByUserId: userId, createdByAgentId: agent!.id });
    await add("cancelled by me", { createdByUserId: userId, status: "cancelled" });
    await add("hidden by me", { createdByUserId: userId, hiddenAt: at(1) });
    await add("harness by me", { createdByUserId: userId, harnessKind: "synthetic" });
    await add("plugin operation by me", { createdByUserId: userId, originKind: "plugin:demo:operation" });
    const privateId = randomUUID();
    await add("private to someone else", {
      id: privateId, visibility: "private", privacyRootIssueId: privateId, responsibleUserId: otherUserId,
    });
    await activity(privateId, {});
    const answered = await add("answered request", { createdByUserId: null, createdByAgentId: agent!.id });
    await ctx.db.insert(issueThreadInteractions).values({
      companyId, issueId: answered, kind: "request_confirmation", status: "answered", addresseeUserId: userId,
      payload: { version: 1, prompt: "Confirm?" } as never,
    });
    await ctx.db.insert(issues).values({ companyId: foreignCompanyId, title: "foreign", createdByUserId: userId });

    // Page pressure: more than 100 touched issues, many with tied activity times.
    for (let index = 0; index < 130; index++) {
      await add(`bulk ${index}`, { createdByUserId: userId, status: index % 3 === 0 ? "done" : "in_progress" }, index % 4);
    }
    for (let index = 0; index < 40; index++) await add(`untouched ${index}`, {}, 1000 + index);

    const ids = await compare(companyId, await mineFilters(userId));
    expect(ids).toHaveLength(100);
    const all = await compare(companyId, await mineFilters(userId, { limit: 1000 }));
    for (const name of [
      "created by me", "assigned to me", "updated by me", "commented by me", "done by me", "pending request",
      "archived then re-activated", "read with later agent comment", "live child of mine",
    ]) expect(all, name).toContain(named.get(name));
    for (const name of [
      "archived without new activity", "mention only", "read audit only", "uppercase entity id", "channel comment",
      "agent created with my user id", "cancelled by me", "hidden by me", "harness by me", "plugin operation by me",
      "private to someone else", "answered request", "untouched 0",
    ]) expect(all, name).not.toContain(named.get(name));
    expect(all.indexOf(named.get("archived then re-activated")!)).toBeLessThan(all.indexOf(named.get("created by me")!));

    // Other selection shapes stay equivalent: no archive filter, other statuses,
    // offsets, ascending order, unrestricted read access, and another user.
    await compare(companyId, await mineFilters(userId, { inboxArchivedByUserId: undefined }));
    await compare(companyId, await mineFilters(userId, { status: "done", listProjection: undefined, includeLiveDescendantSummary: false }));
    await compare(companyId, await mineFilters(userId, { offset: 50, limit: 30 }));
    await compare(companyId, await mineFilters(userId, { sortDir: "asc" }));
    await compare(companyId, { ...await mineFilters(userId), readCondition: sql<boolean>`true` });
    expect(await compare(companyId, await mineFilters(otherUserId, { limit: 1000 }))).toContain(named.get("archived then re-activated"));
    expect(await compare(companyId, await mineFilters(`nobody-${randomUUID()}`))).toEqual([]);
  });
});
