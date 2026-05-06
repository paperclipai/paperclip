import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";
import { extractIssueTimelineEvents } from "./issue-timeline-events";

describe("extractIssueTimelineEvents", () => {
  it("extracts and sorts status and assignee changes from issue updates", () => {
    const events = extractIssueTimelineEvents([
      {
        id: "evt-2",
        companyId: "company-1",
        actorType: "user",
        actorId: "local-board",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-1",
        agentId: null,
        runId: null,
        createdAt: new Date("2026-03-31T12:02:00.000Z"),
        details: {
          assigneeAgentId: "agent-2",
          assigneeUserId: null,
          _previous: {
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        },
      },
      {
        id: "evt-1",
        companyId: "company-1",
        actorType: "user",
        actorId: "local-board",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-1",
        agentId: null,
        runId: null,
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        details: {
          status: "in_progress",
          _previous: {
            status: "todo",
          },
        },
      },
      {
        id: "evt-ignored",
        companyId: "company-1",
        actorType: "user",
        actorId: "local-board",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: "issue-1",
        agentId: null,
        runId: null,
        createdAt: new Date("2026-03-31T12:03:00.000Z"),
        details: {
          commentId: "comment-1",
        },
      },
    ] satisfies ActivityEvent[]);

    expect(events).toEqual([
      {
        id: "evt-1",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        actorType: "user",
        actorId: "local-board",
        runId: null,
        statusChange: {
          from: "todo",
          to: "in_progress",
        },
      },
      {
        id: "evt-2",
        createdAt: new Date("2026-03-31T12:02:00.000Z"),
        actorType: "user",
        actorId: "local-board",
        runId: null,
        assigneeChange: {
          from: {
            agentId: "agent-1",
            userId: null,
          },
          to: {
            agentId: "agent-2",
            userId: null,
          },
        },
      },
    ]);
  });

  it("uses reopenedFrom when a reopen update omits _previous", () => {
    const events = extractIssueTimelineEvents([
      {
        id: "evt-reopen",
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        details: {
          status: "todo",
          reopened: true,
          reopenedFrom: "done",
          source: "comment",
        },
      },
    ] satisfies ActivityEvent[]);

    expect(events).toEqual([
      {
        id: "evt-reopen",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        actorType: "agent",
        actorId: "agent-1",
        runId: "run-1",
        statusChange: {
          from: "done",
          to: "todo",
        },
      },
    ]);
  });

  it("marks explicit follow-up timeline updates", () => {
    const events = extractIssueTimelineEvents([
      {
        id: "evt-follow-up",
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        details: {
          status: "todo",
          reopened: true,
          reopenedFrom: "done",
          source: "comment",
          commentId: "comment-1",
          resumeIntent: true,
          followUpRequested: true,
        },
      },
    ] satisfies ActivityEvent[]);

    expect(events).toEqual([
      {
        id: "evt-follow-up",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        actorType: "agent",
        actorId: "agent-1",
        runId: "run-1",
        commentId: "comment-1",
        followUpRequested: true,
        statusChange: {
          from: "done",
          to: "todo",
        },
      },
    ]);
  });

  it("synthesizes non-status follow-up rows from comment activity", () => {
    const events = extractIssueTimelineEvents([
      {
        id: "evt-comment-follow-up",
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        details: {
          commentId: "comment-1",
          resumeIntent: true,
          followUpRequested: true,
        },
      },
    ] satisfies ActivityEvent[]);

    expect(events).toEqual([
      {
        id: "evt-comment-follow-up",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        actorType: "agent",
        actorId: "agent-1",
        runId: "run-1",
        commentId: "comment-1",
        followUpRequested: true,
      },
    ]);
  });

  it("ignores issue updates without visible status or assignee transitions", () => {
    const events = extractIssueTimelineEvents([
      {
        id: "evt-title",
        companyId: "company-1",
        actorType: "user",
        actorId: "local-board",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-1",
        agentId: null,
        runId: null,
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        details: {
          title: "New title",
          _previous: {
            title: "Old title",
          },
        },
      },
    ] satisfies ActivityEvent[]);

    expect(events).toEqual([]);
  });
});
