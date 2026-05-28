import { describe, expect, it } from "vitest";
import type { IssueThreadInteraction } from "./issue-thread-interactions";
import {
  isExternallyHandoffInteraction,
  resolveDisplayHandoffStatus,
  shouldPollInteractionHandoffStatus,
  shouldShowInteractionHandoffStatus,
} from "./interaction-handoff-status";

function makeInteraction(
  overrides: Partial<IssueThreadInteraction> & Pick<IssueThreadInteraction, "kind">,
): IssueThreadInteraction {
  return {
    id: "interaction-1",
    companyId: "company-1",
    issueId: "issue-1",
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdAt: "2026-05-22T12:00:00.000Z",
    updatedAt: "2026-05-22T12:00:00.000Z",
    payload: overrides.kind === "ask_user_questions"
      ? { version: 1, questions: [] }
      : overrides.kind === "request_confirmation"
        ? { version: 1, prompt: "Approve?" }
        : { version: 1, tasks: [] },
    ...overrides,
  } as IssueThreadInteraction;
}

describe("interaction-handoff-status", () => {
  it("identifies externally handed-off interaction kinds", () => {
    expect(isExternallyHandoffInteraction(makeInteraction({ kind: "request_confirmation" }))).toBe(true);
    expect(isExternallyHandoffInteraction(makeInteraction({ kind: "suggest_tasks" }))).toBe(false);
  });

  it("shows status for pending handoff interactions", () => {
    const interaction = makeInteraction({ kind: "request_confirmation", status: "pending" });
    expect(shouldShowInteractionHandoffStatus(interaction, {
      interactionId: interaction.id,
      provider: "clickup",
      providerLabel: "ClickUp",
      phase: "listening",
      label: "Waiting in ClickUp",
      detail: "Next check in 30s",
      isCheckingNow: false,
      lastCheckedAt: null,
      nextCheckAt: null,
      closeOutcome: null,
    })).toBe(true);
  });

  it("falls back to a default status when the API has not returned bridge state yet", () => {
    const interaction = makeInteraction({ kind: "request_confirmation", status: "pending" });
    const status = resolveDisplayHandoffStatus(interaction, null);
    expect(status?.phase).toBe("none");
    expect(status?.label).toBe("External handoff not started");
    expect(shouldShowInteractionHandoffStatus(interaction, status)).toBe(true);
  });

  it("polls while an active handoff is in progress", () => {
    const interactions = [makeInteraction({ kind: "request_confirmation", status: "pending" })];
    expect(shouldPollInteractionHandoffStatus(interactions, {
      issueId: "issue-1",
      serverNow: "2026-05-22T12:00:00.000Z",
      byInteractionId: {
        "interaction-1": {
          interactionId: "interaction-1",
          provider: "clickup",
          providerLabel: "ClickUp",
          phase: "checking",
          label: "Checking ClickUp for your reply",
          detail: null,
          isCheckingNow: true,
          lastCheckedAt: null,
          nextCheckAt: null,
          closeOutcome: null,
        },
      },
    })).toBe(true);
  });
});
