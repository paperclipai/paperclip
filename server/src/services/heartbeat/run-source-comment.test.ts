import { PgDialect } from "drizzle-orm/pg-core";
import { issueComments, type Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { readRunSourceCommentCandidate, resolveRunSourceCommentId } from "./run-source-comment.js";

type SourceRun = NonNullable<Parameters<typeof readRunSourceCommentCandidate>[0]>;

const commentContext = {
  issueId: "issue-1", source: "issue.comment", wakeReason: "issue_commented", wakeCommentIds: ["comment-1"],
};
const pluginContext = { ...commentContext, source: "plugin:example.chat", sourceCommentId: "comment-1" };

function sourceRun(overrides: Partial<SourceRun> = {}): SourceRun {
  return { companyId: "company-1", nativeIssueId: null, status: "running", contextSnapshot: commentContext, ...overrides };
}

function fakeDb(rows: unknown[]) {
  const from = vi.fn();
  const where = vi.fn();
  const limit = vi.fn().mockResolvedValue(rows);
  const query = {
    from: (table: unknown) => { from(table); return query; },
    where: (filter: unknown) => { where(filter); return query; },
    limit,
  };
  const select = vi.fn(() => query);
  return { db: { select } as unknown as Db, select, from, where, limit };
}

describe("readRunSourceCommentCandidate", () => {
  it("accepts one comment from an issue comment wake", () => {
    expect(readRunSourceCommentCandidate(sourceRun())).toEqual({
      companyId: "company-1", issueId: "issue-1", commentId: "comment-1", kind: "issue_comment",
    });
    expect(readRunSourceCommentCandidate(sourceRun({
      contextSnapshot: { ...commentContext, source: "issue.comment.reopen", wakeReason: "issue_reopened_via_comment" },
    }))?.kind).toBe("issue_comment");
    expect(readRunSourceCommentCandidate(sourceRun({
      contextSnapshot: { ...commentContext, wakeCommentIds: ["comment-1", "comment-1"] },
    }))?.commentId).toBe("comment-1");
    expect(readRunSourceCommentCandidate(sourceRun({ nativeIssueId: "issue-1" }))?.commentId).toBe("comment-1");
  });

  it("accepts a human comment that a plugin relayed", () => {
    expect(readRunSourceCommentCandidate(sourceRun({ contextSnapshot: pluginContext }))?.kind).toBe("plugin_human_comment");
  });

  it.each([
    { ...commentContext, wakeCommentIds: [] },
    { ...commentContext, wakeCommentIds: ["comment-1", "comment-2"] },
    { ...commentContext, wakeCommentIds: undefined, commentId: "comment-1", wakeCommentId: "comment-1" },
    { ...commentContext, issueId: undefined },
    { ...commentContext, source: "assignment" },
    { ...commentContext, source: "automation", wakeReason: "issue_blockers_resolved" },
    { ...commentContext, wakeReason: "issue_comment_mentioned" },
    { ...pluginContext, sourceCommentId: undefined },
    { ...pluginContext, sourceCommentId: "comment-2" },
    { ...pluginContext, pluginId: "plugin-1" },
    { ...pluginContext, pluginKey: "example.chat" },
    { ...pluginContext, interactionId: "interaction-1" },
    { ...pluginContext, approvalId: "approval-1" },
    { ...pluginContext, source: "plugin:example.chat:approval.approve" },
    { ...pluginContext, wakeReason: "plugin_issue_wakeup_requested" },
  ])("returns null for an ambiguous or foreign wake context %#", (contextSnapshot) => {
    expect(readRunSourceCommentCandidate(sourceRun({ contextSnapshot }))).toBeNull();
  });

  it("returns null for a run that is not running or has no usable scope", () => {
    expect(readRunSourceCommentCandidate(null)).toBeNull();
    expect(readRunSourceCommentCandidate(sourceRun({ status: "queued" }))).toBeNull();
    expect(readRunSourceCommentCandidate(sourceRun({ status: "succeeded" }))).toBeNull();
    expect(readRunSourceCommentCandidate(sourceRun({ companyId: "" }))).toBeNull();
    expect(readRunSourceCommentCandidate(sourceRun({ contextSnapshot: [] as unknown as Record<string, unknown> }))).toBeNull();
    expect(readRunSourceCommentCandidate(sourceRun({ nativeIssueId: "issue-2" }))).toBeNull();
  });
});

describe("resolveRunSourceCommentId", () => {
  it("reads the comment by id, company and issue", async () => {
    const database = fakeDb([{ id: "comment-1", authorUserId: "user-1", authorAgentId: null }]);
    expect(await resolveRunSourceCommentId(database.db, sourceRun())).toBe("comment-1");
    expect(database.from).toHaveBeenCalledWith(issueComments);
    expect(new PgDialect().sqlToQuery(database.where.mock.calls[0]![0]).params).toEqual(["comment-1", "company-1", "issue-1"]);
    expect(database.limit).toHaveBeenCalledWith(2);
  });

  it("does not read the database when the run has no candidate", async () => {
    const database = fakeDb([]);
    expect(await resolveRunSourceCommentId(database.db, sourceRun({ status: "succeeded" }))).toBeNull();
    expect(database.select).not.toHaveBeenCalled();
  });

  it.each([
    [[]],
    [[{ id: "comment-1", authorUserId: "user-1", authorAgentId: null }, { id: "comment-1", authorUserId: "user-1", authorAgentId: null }]],
  ])("returns null when the comment row is missing or not unique %#", async (rows) => {
    expect(await resolveRunSourceCommentId(fakeDb(rows).db, sourceRun())).toBeNull();
  });

  it("accepts an agent comment for an issue comment wake", async () => {
    const database = fakeDb([{ id: "comment-1", authorUserId: null, authorAgentId: "agent-1" }]);
    expect(await resolveRunSourceCommentId(database.db, sourceRun())).toBe("comment-1");
  });

  it.each([
    { id: "comment-1", authorUserId: null, authorAgentId: "agent-1" },
    { id: "comment-1", authorUserId: null, authorAgentId: null },
    { id: "comment-1", authorUserId: "user-1", authorAgentId: "agent-1" },
  ])("returns null for a plugin relay comment without a human author %#", async (row) => {
    expect(await resolveRunSourceCommentId(fakeDb([row]).db, sourceRun({ contextSnapshot: pluginContext }))).toBeNull();
  });

  it("returns the comment for a plugin relay comment with a human author", async () => {
    const database = fakeDb([{ id: "comment-1", authorUserId: "user-1", authorAgentId: null }]);
    expect(await resolveRunSourceCommentId(database.db, sourceRun({ contextSnapshot: pluginContext }))).toBe("comment-1");
  });
});
