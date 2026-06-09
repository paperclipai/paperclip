import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/awaiting-human-notifications.js", () => ({
  enqueueAwaitingHumanNotification: vi.fn().mockResolvedValue({
    status: "enqueued",
    channel: "clickup-chat",
    detail: "enqueued",
  }),
}));

const { logActivity } = await import("../services/activity-log.js");
const { enqueueAwaitingHumanNotification } = await import("../services/awaiting-human-notifications.js");
const { maybeLogAwaitingHumanHandoff } = await import("../services/awaiting-human-handoff.js");

const basePreviousIssue = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "BIZ-35",
  title: "Community reply approval",
  status: "in_progress",
  updatedAt: "2026-05-11T10:00:00.000Z",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
};

const baseUpdatedIssue = {
  ...basePreviousIssue,
  status: "awaiting_human",
  updatedAt: "2026-05-11T10:05:00.000Z",
  assigneeAgentId: null,
  assigneeUserId: "board-user",
};

const baseActor = {
  actorType: "agent" as const,
  actorId: "agent-1",
  agentId: "agent-1",
  userId: null,
  runId: "run-1",
};

function mockDbWithAwaitingHumanRows(
  rows: Array<{ createdAt?: Date; details: Record<string, unknown> | null }> = [],
): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  } as unknown as Db;
}

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.BIZBOX_PUBLIC_URL;
});

describe("maybeLogAwaitingHumanHandoff", () => {
  it("sends a ClickUp notification for request_confirmation handoffs", async () => {
    process.env.BIZBOX_PUBLIC_URL = "https://bizbox.example";

    const created = await maybeLogAwaitingHumanHandoff(mockDbWithAwaitingHumanRows(), {
      previousIssue: basePreviousIssue,
      updatedIssue: baseUpdatedIssue,
      source: "issue_thread_interactions.create",
      handoffKind: "request_confirmation",
      actor: baseActor,
      interaction: {
        id: "interaction-1",
        kind: "request_confirmation",
        title: null,
        summary: null,
        payload: {
          version: 1,
          prompt: "Approve the exact GitHub reply before posting.",
        },
      },
    });

    expect(created).toBe(true);
    expect(enqueueAwaitingHumanNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        issueId: "issue-1",
        dedupeKey: "interaction:interaction-1",
        handoffKind: "request_confirmation",
        notification: expect.objectContaining({
          title: "BIZ-35 needs confirmation",
          link: "https://bizbox.example/issues/BIZ-35",
          summary: "Approve the exact GitHub reply before posting.",
          cta: "Reply with Approve, Reject, or Change followed by feedback.",
          body: expect.stringMatching(/Reply with:[\s\S]*`Change` followed by feedback[\s\S]*Disclaimer:[\s\S]*Open in Bizbox: https:\/\/bizbox\.example\/issues\/BIZ-35/),
        }),
      }),
    );
    expect(logActivity).toHaveBeenCalledTimes(1);
  });

  it("passes approval context through the handoff payload", async () => {
    process.env.BIZBOX_PUBLIC_URL = "https://bizbox.example";

    const created = await maybeLogAwaitingHumanHandoff(mockDbWithAwaitingHumanRows(), {
      previousIssue: basePreviousIssue,
      updatedIssue: baseUpdatedIssue,
      source: "issue_thread_interactions.create",
      handoffKind: "request_confirmation",
      actor: baseActor,
      approvalContext: {
        approvalName: "Policy approval",
        requiresSecondReview: true,
      },
      interaction: {
        id: "interaction-ugc-1",
        kind: "request_confirmation",
        title: null,
        summary: null,
        payload: {
          version: 1,
          prompt: "Approve the finance article before it goes to the final reviewer.",
        },
      },
    });

    expect(created).toBe(true);
    expect(enqueueAwaitingHumanNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        notification: expect.objectContaining({
          approvalContext: {
            approvalName: "Policy approval",
            approvalStage: null,
            requiresSecondReview: true,
          },
        }),
      }),
    );
  });

  it("renders absolute target links for relative request confirmation targets", async () => {
    process.env.BIZBOX_PUBLIC_URL = "https://bizbox.example";

    const created = await maybeLogAwaitingHumanHandoff(mockDbWithAwaitingHumanRows(), {
      previousIssue: basePreviousIssue,
      updatedIssue: baseUpdatedIssue,
      source: "issue_thread_interactions.create",
      handoffKind: "request_confirmation",
      actor: baseActor,
      interaction: {
        id: "interaction-1b",
        kind: "request_confirmation",
        title: null,
        summary: null,
        payload: {
          version: 1,
          prompt: "Do you approve attached growth image for use?",
          target: {
            type: "custom",
            key: "growth-image-attachment",
            label: "Growth image attachment",
            href: "/api/attachments/347bbaac-d44e-4c4e-9d76-63a2b9e495a8/content",
          },
        },
      },
    });

    expect(created).toBe(true);
    expect(enqueueAwaitingHumanNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        notification: expect.objectContaining({
          body: expect.stringContaining("Target link: https://bizbox.example/api/attachments/347bbaac-d44e-4c4e-9d76-63a2b9e495a8/content"),
        }),
      }),
    );
  });

  it("sends a ClickUp notification for ask_user_questions handoffs", async () => {
    const created = await maybeLogAwaitingHumanHandoff(mockDbWithAwaitingHumanRows(), {
      previousIssue: basePreviousIssue,
      updatedIssue: baseUpdatedIssue,
      source: "issue_thread_interactions.create",
      handoffKind: "ask_user_questions",
      actor: baseActor,
      interaction: {
        id: "interaction-2",
        kind: "ask_user_questions",
        title: null,
        summary: null,
        payload: {
          version: 1,
          questions: [
            { id: "scope", prompt: "Which scope?", selectionMode: "single", options: [{ id: "a", label: "A" }] },
            { id: "risk", prompt: "What risk?", selectionMode: "single", options: [{ id: "b", label: "B" }] },
          ],
        },
      },
    });

    expect(created).toBe(true);
    expect(enqueueAwaitingHumanNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        handoffKind: "ask_user_questions",
        notification: expect.objectContaining({
          title: "BIZ-35 needs answers",
          summary: "Need answers to 2 question(s).",
          link: "/issues/BIZ-35",
          body: expect.stringMatching(/Question 1: Which scope\?[\s\S]*Open in Bizbox: \/issues\/BIZ-35/),
        }),
      }),
    );
  });

  it("sends a ClickUp notification for human_owned_blocker handoffs", async () => {
    const created = await maybeLogAwaitingHumanHandoff(mockDbWithAwaitingHumanRows(), {
      previousIssue: basePreviousIssue,
      updatedIssue: baseUpdatedIssue,
      source: "heartbeat.reconcile_stranded_assigned_issues",
      handoffKind: "human_owned_blocker",
      actor: baseActor,
      blockers: [
        {
          id: "blocker-1",
          identifier: "BIZ-36",
          title: "Board decision needed",
          assigneeUserId: "board-user",
        },
      ],
    });

    expect(created).toBe(true);
    expect(enqueueAwaitingHumanNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        handoffKind: "human_owned_blocker",
        notification: expect.objectContaining({
          summary: "Waiting on human input to unblock BIZ-36.",
        }),
      }),
    );
  });

  it("does not resend when the same handoff dedupe key is already logged", async () => {
    const dedupeKey = "human-blocker:issue-1:blocker-1";
    const db = mockDbWithAwaitingHumanRows([{
      createdAt: new Date("2026-05-11T10:06:00.000Z"),
      details: { dedupeKey },
    }]);
    const created = await maybeLogAwaitingHumanHandoff(db, {
      previousIssue: {
        ...basePreviousIssue,
        status: "awaiting_human",
      },
      updatedIssue: baseUpdatedIssue,
      source: "heartbeat.reconcile_stranded_assigned_issues",
      handoffKind: "human_owned_blocker",
      actor: baseActor,
      blockers: [
        {
          id: "blocker-1",
          identifier: "BIZ-36",
          title: "Board decision needed",
          assigneeUserId: "board-user",
        },
      ],
    });

    expect(created).toBe(false);
    expect(enqueueAwaitingHumanNotification).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("retries delivery when the issue is still awaiting_human but no dedupe marker was logged", async () => {
    vi.mocked(enqueueAwaitingHumanNotification)
      .mockResolvedValueOnce({
        status: "failed",
        channel: "clickup-chat",
        detail: "http-error:500",
      } as any)
      .mockResolvedValueOnce({
        status: "sent",
        channel: "clickup-chat",
        detail: "sent",
        externalId: "msg_124",
      } as any);

    const db = mockDbWithAwaitingHumanRows();
    const first = await maybeLogAwaitingHumanHandoff(db, {
      previousIssue: {
        ...basePreviousIssue,
        status: "awaiting_human",
      },
      updatedIssue: baseUpdatedIssue,
      source: "heartbeat.reconcile_stranded_assigned_issues",
      handoffKind: "human_owned_blocker",
      actor: baseActor,
      blockers: [
        {
          id: "blocker-1",
          identifier: "BIZ-36",
          title: "Board decision needed",
          assigneeUserId: "board-user",
        },
      ],
    });
    const second = await maybeLogAwaitingHumanHandoff(db, {
      previousIssue: {
        ...basePreviousIssue,
        status: "awaiting_human",
      },
      updatedIssue: baseUpdatedIssue,
      source: "heartbeat.reconcile_stranded_assigned_issues",
      handoffKind: "human_owned_blocker",
      actor: baseActor,
      blockers: [
        {
          id: "blocker-1",
          identifier: "BIZ-36",
          title: "Board decision needed",
          assigneeUserId: "board-user",
        },
      ],
    });

    expect(first).toBe(false);
    expect(second).toBe(true);
    expect(enqueueAwaitingHumanNotification).toHaveBeenCalledTimes(2);
  });

  it("retries after a skipped delivery once notification config is restored", async () => {
    vi.mocked(enqueueAwaitingHumanNotification)
      .mockResolvedValueOnce({
        status: "skipped",
        channel: "clickup-chat",
        detail: "missing-credential: CLICKUP_PERSONAL_TOKEN",
      } as any)
      .mockResolvedValueOnce({
        status: "sent",
        channel: "clickup-chat",
        detail: "sent",
        externalId: "msg_125",
      } as any);

    const db = mockDbWithAwaitingHumanRows();
    const first = await maybeLogAwaitingHumanHandoff(db, {
      previousIssue: {
        ...basePreviousIssue,
        status: "awaiting_human",
      },
      updatedIssue: baseUpdatedIssue,
      source: "heartbeat.reconcile_stranded_assigned_issues",
      handoffKind: "human_owned_blocker",
      actor: baseActor,
      blockers: [
        {
          id: "blocker-1",
          identifier: "BIZ-36",
          title: "Board decision needed",
          assigneeUserId: "board-user",
        },
      ],
    });
    const second = await maybeLogAwaitingHumanHandoff(db, {
      previousIssue: {
        ...basePreviousIssue,
        status: "awaiting_human",
      },
      updatedIssue: baseUpdatedIssue,
      source: "heartbeat.reconcile_stranded_assigned_issues",
      handoffKind: "human_owned_blocker",
      actor: baseActor,
      blockers: [
        {
          id: "blocker-1",
          identifier: "BIZ-36",
          title: "Board decision needed",
          assigneeUserId: "board-user",
        },
      ],
    });

    expect(first).toBe(false);
    expect(second).toBe(true);
    expect(enqueueAwaitingHumanNotification).toHaveBeenCalledTimes(2);
  });

  it("does not suppress a new blocker cycle from an old-cycle dedupe log", async () => {
    const db = mockDbWithAwaitingHumanRows([
      {
        createdAt: new Date("2026-05-11T10:10:00.000Z"),
        details: { dedupeKey: "human-blocker:issue-1:blocker-1" },
      },
    ]);

    const created = await maybeLogAwaitingHumanHandoff(db, {
      previousIssue: {
        ...basePreviousIssue,
        status: "in_progress",
        updatedAt: "2026-05-11T10:04:00.000Z",
      },
      updatedIssue: {
        ...baseUpdatedIssue,
        updatedAt: "2026-05-11T11:00:00.000Z",
      },
      source: "heartbeat.reconcile_stranded_assigned_issues",
      handoffKind: "human_owned_blocker",
      actor: baseActor,
      blockers: [
        {
          id: "blocker-1",
          identifier: "BIZ-36",
          title: "Board decision needed",
          assigneeUserId: "board-user",
        },
      ],
    });

    expect(created).toBe(true);
    expect(enqueueAwaitingHumanNotification).toHaveBeenCalledTimes(1);
  });
});
