import { describe, it, expect, vi } from "vitest";
import { handleIssueUpdated, handleCommentCreated, handleApprovalCreated } from "../src/triggers.js";
import type { PluginConfig, CachedIssueState } from "../src/config-schema.js";

const CEO = "506c873e-3a40-4483-9a45-0eb0fa1554bb";
const WALTER = "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9";
const WHI = "9cebf3cf-efe8-4597-a400-f06488900a87";

function baseConfig(): PluginConfig {
  return {
    pushoverUserKeyRef: "key-uuid",
    pushoverAppTokenRef: "token-uuid",
    boardUserId: WALTER,
    clickbackBaseUrl: "https://company.whitestag.ai",
    dryRun: false,
    companies: [
      { companyId: WHI, issuePrefix: "WHI", topAgentIds: [CEO], enabled: true },
    ],
  };
}

type IssueStub = {
  id?: string;
  identifier?: string;
  title?: string;
  status?: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

function makeCtx(
  prev: CachedIssueState | null,
  opts: { issue?: IssueStub; comments?: any[] } = {},
) {
  const issue = {
    id: "iss-1",
    companyId: WHI,
    title: "Cleanup",
    identifier: "WHI-42",
    status: "done" as const,
    assigneeAgentId: CEO,
    assigneeUserId: null as string | null,
    updatedAt: new Date("2026-05-11T10:00:00.000Z"),
    ...opts.issue,
  };
  return {
    state: {
      get: vi.fn(async (s: any) => {
        if (
          s.scopeKind === "issue" &&
          s.scopeId === "iss-1" &&
          s.stateKey === "pushover-watch:last-seen"
        ) {
          return prev;
        }
        return null;
      }),
      set: vi.fn(async () => {}),
    },
    http: { fetch: vi.fn(async () => new Response("{}", { status: 200 })) },
    secrets: { resolve: vi.fn(async (ref: string) => `resolved-${ref}`) },
    issues: {
      get: vi.fn(async () => issue),
      listComments: vi.fn(async () => opts.comments ?? []),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
  } as any;
}

function issueUpdatedEvent(over: any = {}) {
  return {
    eventId: "evt-1",
    eventType: "issue.updated",
    occurredAt: "2026-05-11T10:00:00.000Z",
    companyId: WHI,
    entityId: "iss-1",
    entityType: "issue",
    payload: { status: "done", ...over },
  };
}

describe("handleIssueUpdated", () => {
  it("fires T1 when CEO task moves to done", async () => {
    const prev: CachedIssueState = {
      status: "in_progress",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      updatedAt: "2026-05-11T09:00:00.000Z",
    };
    const ctx = makeCtx(prev, { issue: { status: "done", assigneeAgentId: CEO } });
    await handleIssueUpdated(ctx, baseConfig(), issueUpdatedEvent() as any);

    expect(ctx.http.fetch).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body);
    expect(body.get("title")).toMatch(/^\[WHI\] CEO erledigt:/);
    expect(body.get("url")).toBe("https://company.whitestag.ai/WHI/issues/WHI-42");
    expect(body.get("priority")).toBe("0");
  });

  it("does not fire when prev state is unknown (post-bootstrap-gap safety)", async () => {
    const ctx = makeCtx(null);
    await handleIssueUpdated(ctx, baseConfig(), issueUpdatedEvent() as any);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("fires T2 when status moves to in_review and assigneeUserId is the board user", async () => {
    const prev: CachedIssueState = {
      status: "in_progress",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      updatedAt: "2026-05-11T09:00:00.000Z",
    };
    const ctx = makeCtx(prev, {
      issue: { status: "in_review", assigneeAgentId: CEO, assigneeUserId: WALTER },
    });
    await handleIssueUpdated(ctx, baseConfig(), issueUpdatedEvent({ status: "in_review" }) as any);
    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body);
    expect(body.get("title")).toMatch(/^\[WHI\] Review-Handover:/);
  });

  it("fires T3 when status moves to blocked AND latest comment mentions board user", async () => {
    const prev: CachedIssueState = {
      status: "in_progress",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      updatedAt: "2026-05-11T09:00:00.000Z",
    };
    const ctx = makeCtx(prev, {
      issue: { status: "blocked", assigneeAgentId: CEO },
      comments: [
        {
          id: "c-1",
          body: `Waiting on [@Walter](user://${WALTER})`,
          authorAgentId: "agent-x",
          authorUserId: null,
          createdAt: new Date(),
        },
      ],
    });
    await handleIssueUpdated(ctx, baseConfig(), issueUpdatedEvent({ status: "blocked" }) as any);
    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body);
    expect(body.get("title")).toMatch(/^\[WHI\] Blockiert, braucht dich:/);
    expect(body.get("priority")).toBe("1");
  });

  it("does NOT fire T3 when latest comment doesn't mention board user", async () => {
    const prev: CachedIssueState = {
      status: "in_progress",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      updatedAt: "2026-05-11T09:00:00.000Z",
    };
    const ctx = makeCtx(prev, {
      issue: { status: "blocked", assigneeAgentId: CEO },
      comments: [
        { id: "c-1", body: "no mentions", authorAgentId: "x", authorUserId: null, createdAt: new Date() },
      ],
    });
    await handleIssueUpdated(ctx, baseConfig(), issueUpdatedEvent({ status: "blocked" }) as any);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });
});

function commentCreatedEvent(commentId: string, issueId = "iss-1") {
  return {
    eventId: "evt-c",
    eventType: "issue.comment.created",
    occurredAt: "2026-05-11T10:05:00.000Z",
    companyId: WHI,
    entityId: commentId,
    entityType: "comment",
    payload: { issueId },
  };
}

describe("handleCommentCreated (T4)", () => {
  it("fires when comment body mentions board user and author is not Walter", async () => {
    const ctx = makeCtx(null, {
      comments: [
        {
          id: "c-1",
          body: `Hi [@Walter](user://${WALTER}), thoughts?`,
          authorAgentId: "agent-x",
          authorUserId: null,
          createdAt: new Date(),
        },
      ],
    });
    await handleCommentCreated(ctx, baseConfig(), commentCreatedEvent("c-1") as any);

    expect(ctx.http.fetch).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body);
    expect(body.get("title")).toMatch(/^\[WHI\] @-Mention/);
  });

  it("does not fire when author IS Walter (self-mention)", async () => {
    const ctx = makeCtx(null, {
      comments: [
        {
          id: "c-2",
          body: `Note to self [@Walter](user://${WALTER})`,
          authorAgentId: null,
          authorUserId: WALTER,
          createdAt: new Date(),
        },
      ],
    });
    await handleCommentCreated(ctx, baseConfig(), commentCreatedEvent("c-2") as any);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("does not fire when body has no mention of board user", async () => {
    const ctx = makeCtx(null, {
      comments: [
        { id: "c-3", body: "plain comment, no mention", authorAgentId: "agent-x", authorUserId: null, createdAt: new Date() },
      ],
    });
    await handleCommentCreated(ctx, baseConfig(), commentCreatedEvent("c-3") as any);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("does not fire when comment cannot be located in the parent issue", async () => {
    const ctx = makeCtx(null, { comments: [] });
    await handleCommentCreated(ctx, baseConfig(), commentCreatedEvent("c-missing") as any);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("does not fire when payload has no issueId reference", async () => {
    const ctx = makeCtx(null);
    await handleCommentCreated(ctx, baseConfig(), {
      eventId: "evt-x",
      eventType: "issue.comment.created",
      occurredAt: "2026-05-11T10:05:00.000Z",
      companyId: WHI,
      entityId: "c-orphan",
      entityType: "comment",
      payload: {},
    } as any);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });
});

describe("handleApprovalCreated (T5)", () => {
  it("fires on pending request_board_approval", async () => {
    const ctx = makeCtx(null);
    await handleApprovalCreated(ctx, baseConfig(), {
      eventId: "evt-5",
      eventType: "approval.created",
      occurredAt: "2026-05-11T10:05:00.000Z",
      companyId: WHI,
      entityId: "appr-1",
      entityType: "approval",
      payload: {
        id: "appr-1",
        type: "request_board_approval",
        status: "pending",
        title: "Approve monthly hosting spend",
      },
    } as any);
    expect(ctx.http.fetch).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body);
    expect(body.get("priority")).toBe("1");
    expect(body.get("title")).toMatch(/^\[WHI\] Approval wartet:/);
    expect(body.get("url")).toBe("https://company.whitestag.ai/WHI/approvals/appr-1");
  });

  it("does not fire on non-pending or non-board-approval payload", async () => {
    const ctx = makeCtx(null);
    await handleApprovalCreated(ctx, baseConfig(), {
      eventId: "evt-6",
      eventType: "approval.created",
      occurredAt: "2026-05-11T10:05:00.000Z",
      companyId: WHI,
      entityId: "appr-2",
      entityType: "approval",
      payload: { id: "appr-2", type: "hire_agent", status: "pending", title: "Hire" },
    } as any);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });
});
