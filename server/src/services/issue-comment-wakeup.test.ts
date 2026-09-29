import { describe, expect, it } from "vitest";
import { isAgentAcknowledgementOnly, shouldWakeAssigneeForIssueComment } from "./issue-comment-wakeup.js";

describe("shouldWakeAssigneeForIssueComment", () => {
  it("suppresses explicit resume from the run that currently owns the issue", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-current",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("preserves explicit resume from a completed prior run", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(true);
  });

  it("keeps ordinary self-comments inert", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: false,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {},
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("does not wake a closed issue unless the comment reopened it", () => {
    const base = {
      selfComment: false,
      resumeRequested: false,
      issueAtCommentStart: {},
      currentStatus: "done",
    };
    expect(
      shouldWakeAssigneeForIssueComment({ ...base, reopened: false }),
    ).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...base, reopened: true })).toBe(
      true,
    );
  });
});

describe("isAgentAcknowledgementOnly", () => {
  const base = { actorType: "agent", resumeRequested: false, reopened: false, hasAttachments: false };

  it("suppresses only exact agent courtesy replies", () => {
    expect(isAgentAcknowledgementOnly({ ...base, body: "Acknowledged." })).toBe(true);
    expect(isAgentAcknowledgementOnly({ ...base, body: "Noted" })).toBe(true);
    expect(isAgentAcknowledgementOnly({ ...base, body: "Noted: new drawing received" })).toBe(false);
    expect(isAgentAcknowledgementOnly({ ...base, body: "[AI_TECH_INCIDENT]\n{}" })).toBe(false);
  });

  it("preserves human replies, explicit resumes, reopened issues and attachments", () => {
    expect(isAgentAcknowledgementOnly({ ...base, body: "Thanks", actorType: "user" })).toBe(false);
    expect(isAgentAcknowledgementOnly({ ...base, body: "Thanks", resumeRequested: true })).toBe(false);
    expect(isAgentAcknowledgementOnly({ ...base, body: "Thanks", reopened: true })).toBe(false);
    expect(isAgentAcknowledgementOnly({ ...base, body: "Thanks", hasAttachments: true })).toBe(false);
  });
});
