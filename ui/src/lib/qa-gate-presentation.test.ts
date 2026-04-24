import { describe, expect, it } from "vitest";
import { getSmartReviewActionUi, getSmartReviewPresentation } from "./qa-gate-presentation";

describe("getSmartReviewPresentation", () => {
  it("offers a Start QA action before the issue enters QA", () => {
    expect(
      getSmartReviewPresentation({
        issueStatus: "todo",
        lastQaSummaryAt: null,
      } as any),
    ).toEqual({
      actionLabel: "Start QA",
      actionStatus: "in_review",
      statusLabel: "Not in QA yet",
    });
  });

  it("keeps the QA Ship action once the issue is in review", () => {
    expect(
      getSmartReviewPresentation({
        issueStatus: "in_review",
        lastQaSummaryAt: null,
      } as any),
    ).toEqual({
      actionLabel: "QA Ship",
      actionStatus: "done",
      statusLabel: "No QA summary yet",
    });
  });

  it("prioritizes the QA ownership blocker over verdict formatting problems during review", () => {
    expect(
      getSmartReviewPresentation({
        issueStatus: "in_review",
        lastQaSummaryAt: null,
        missingRequirements: [
          "qa_gate_no_eligible_qa_agent",
          "qa_gate_missing_qa_pass",
          "qa_gate_missing_release_confirmation",
          "qa_gate_missing_qa_summary",
          "qa_gate_missing_verification",
        ],
      } as any),
    ).toEqual({
      actionLabel: "QA Ship",
      actionStatus: "done",
      statusLabel: "No QA summary yet",
      blockingMessage: "QA blocked: no healthy QA reviewer is available.",
      blockingDetails: [
        "Also true once QA ownership is restored: the latest QA verdict is incomplete.",
        "Missing: [QA PASS], [RELEASE CONFIRMED], Smart Review summary, verification evidence.",
      ],
    });
  });

  it("collapses multiple missing QA verdict tokens into one blocker", () => {
    expect(
      getSmartReviewPresentation({
        issueStatus: "in_review",
        lastQaSummaryAt: null,
        missingRequirements: [
          "qa_gate_missing_qa_pass",
          "qa_gate_missing_release_confirmation",
          "qa_gate_missing_qa_summary",
          "qa_gate_missing_verification",
        ],
      } as any),
    ).toEqual({
      actionLabel: "QA Ship",
      actionStatus: "done",
      statusLabel: "No QA summary yet",
      blockingMessage: "Latest QA verdict is incomplete.",
      blockingDetails: [
        "Missing: [QA PASS], [RELEASE CONFIRMED], Smart Review summary, verification evidence.",
      ],
    });
  });

  it("prioritizes the missing QA state transition for terminal issues over malformed verdict details", () => {
    expect(
      getSmartReviewPresentation({
        issueStatus: "done",
        lastQaSummaryAt: null,
        missingRequirements: [
          "qa_gate_requires_in_review",
          "qa_gate_missing_qa_pass",
          "qa_gate_missing_release_confirmation",
        ],
      } as any),
    ).toEqual({
      actionLabel: "QA Closed",
      actionStatus: null,
      statusLabel: "Not in QA yet",
      blockingMessage: "Move the issue into QA before shipping.",
    });
  });

  it("disables the action for terminal issues and preserves summary recency", () => {
    const lastQaSummaryAt = new Date("2026-04-15T12:00:00Z");
    expect(
      getSmartReviewPresentation({
        issueStatus: "done",
        lastQaSummaryAt,
      } as any),
    ).toEqual({
      actionLabel: "QA Closed",
      actionStatus: null,
      statusLabel: `Last summary ${lastQaSummaryAt.toISOString()}`,
    });
  });

  it("accepts QA summary timestamps from API strings", () => {
    expect(
      getSmartReviewPresentation({
        issueStatus: "done",
        lastQaSummaryAt: "2026-04-15T12:00:00.000Z",
      } as any),
    ).toMatchObject({
      statusLabel: "Last summary 2026-04-15T12:00:00.000Z",
    });
  });

  it("handles malformed QA summary timestamps without crashing", () => {
    expect(
      getSmartReviewPresentation({
        issueStatus: "done",
        lastQaSummaryAt: {} as any,
      } as any),
    ).toEqual({
      actionLabel: "QA Closed",
      actionStatus: null,
      statusLabel: "Not in QA yet",
    });
  });

  it("allows Start QA when multiple healthy QA agents are available for pooled routing", () => {
    expect(
      getSmartReviewPresentation({
        issueStatus: "todo",
        lastQaSummaryAt: null,
        assigneeAgentId: "agent-engineer",
        assigneeUserId: null,
        agents: [
          { id: "agent-engineer", role: "engineer", status: "idle", name: "Eng" },
          { id: "agent-qa-1", role: "qa", status: "idle", name: "QA One" },
          { id: "agent-qa-2", role: "qa", status: "idle", name: "QA Two" },
        ],
      } as any),
    ).toEqual({
      actionLabel: "Start QA",
      actionStatus: "in_review",
      statusLabel: "Not in QA yet",
    });
  });

  it("still allows Start QA when one pooled QA agent is already assigned", () => {
    expect(
      getSmartReviewPresentation({
        issueStatus: "todo",
        lastQaSummaryAt: null,
        assigneeAgentId: "agent-qa-1",
        assigneeUserId: null,
        agents: [
          { id: "agent-engineer", role: "engineer", status: "idle", name: "Eng" },
          { id: "agent-qa-1", role: "qa", status: "idle", name: "QA One" },
          { id: "agent-qa-2", role: "qa", status: "idle", name: "QA Two" },
        ],
      } as any),
    ).toEqual({
      actionLabel: "Start QA",
      actionStatus: "in_review",
      statusLabel: "Not in QA yet",
    });
  });

  it("allows Start QA when one healthy QA agent has the canonical release-gate designation", () => {
    expect(
      getSmartReviewPresentation({
        issueStatus: "todo",
        lastQaSummaryAt: null,
        assigneeAgentId: "agent-engineer",
        assigneeUserId: null,
        agents: [
          { id: "agent-engineer", role: "engineer", status: "idle", name: "Eng" },
          { id: "agent-qa-release", role: "qa", status: "idle", name: "QA and Release Engineer" },
          { id: "agent-qa-runner", role: "qa", status: "idle", name: "QA Runner" },
        ],
      } as any),
    ).toEqual({
      actionLabel: "Start QA",
      actionStatus: "in_review",
      statusLabel: "Not in QA yet",
    });
  });

  it("blocks Start QA when no healthy QA agent is available", () => {
    expect(
      getSmartReviewPresentation({
        issueStatus: "todo",
        lastQaSummaryAt: null,
        assigneeAgentId: "agent-engineer",
        assigneeUserId: null,
        agents: [
          { id: "agent-engineer", role: "engineer", status: "idle", name: "Eng" },
          { id: "agent-qa", role: "qa", status: "paused", name: "QA" },
        ],
      } as any),
    ).toEqual({
      actionLabel: "QA Blocked",
      actionStatus: null,
      statusLabel: "No healthy QA available",
      blockingMessage: "No healthy QA agent is available to review this issue right now.",
    });
  });

  it("keeps blocked QA Ship actions clickable so the server can explain the failure", () => {
    expect(
      getSmartReviewActionUi({
        actionStatus: "done",
        canShip: false,
        isPending: false,
      }),
    ).toEqual({
      variant: "outline",
      disabled: false,
    });
  });
});
