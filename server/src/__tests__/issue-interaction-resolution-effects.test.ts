import type { Db } from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { finalizeAcceptedInteractionResolution } from "../services/issue-interaction-resolution-effects.js";

describe("finalizeAcceptedInteractionResolution", () => {
  it("skips final approval review creation for primary_only confirmations", async () => {
    const db = {
      transaction: vi.fn(),
    } as unknown as Db;
    const logActivity = vi.fn().mockResolvedValue(undefined);
    const heartbeat = {
      wakeup: vi.fn().mockResolvedValue(undefined),
    };
    const interaction: IssueThreadInteraction = {
      id: "interaction-primary-only",
      companyId: "company-1",
      issueId: "issue-1",
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "none",
      createdAt: new Date(),
      updatedAt: new Date(),
      payload: {
        version: 1,
        prompt: "Approve this action?",
        approvalPolicy: "primary_only",
      },
    };

    const result = await finalizeAcceptedInteractionResolution({
      db,
      heartbeat,
      logActivity,
      issue: {
        id: "issue-1",
        companyId: "company-1",
        identifier: "ISS-1",
        status: "awaiting_human",
        assigneeAgentId: "agent-1",
      },
      interaction,
      createdIssues: [],
      actor: { actorType: "user", actorId: "user-1" },
      source: "test",
    });

    expect(result).toBe(false);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(logActivity.mock.calls[0]?.[1]).toMatchObject({
      action: "issue.thread_interaction_accepted",
      details: {
        interactionId: "interaction-primary-only",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    });
  });
});
