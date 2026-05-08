import { describe, it, expect } from "vitest";
import {
  approvalIsForUser,
  interactionIsForUser,
  issueIsOwnedByUser,
} from "../notifier/filters.js";
import type {
  ApprovalRef,
  InteractionRef,
  IssueRef,
} from "../notifier/types.js";

const DINAR = "dinar-uuid";
const OTHER = "other-user";

function issue(overrides: Partial<IssueRef> = {}): IssueRef {
  return { id: "i", title: "t", ...overrides };
}

function interaction(overrides: Partial<InteractionRef> = {}): InteractionRef {
  return {
    id: "x",
    issueId: "i",
    kind: "ask_user_questions",
    status: "pending",
    ...overrides,
  };
}

describe("notifier filters", () => {
  it("issue ownership matches creator or assignee", () => {
    expect(issueIsOwnedByUser(issue({ createdByUserId: DINAR }), DINAR)).toBe(true);
    expect(issueIsOwnedByUser(issue({ assigneeUserId: DINAR }), DINAR)).toBe(true);
    expect(issueIsOwnedByUser(issue({ createdByUserId: OTHER }), DINAR)).toBe(false);
    expect(issueIsOwnedByUser(issue({}), DINAR)).toBe(false);
    expect(issueIsOwnedByUser(issue({ createdByUserId: DINAR }), "")).toBe(false);
  });

  it("interaction filter requires pending status AND ownership of parent issue", () => {
    const owned = issue({ createdByUserId: DINAR });
    const stranger = issue({ createdByUserId: OTHER });
    expect(interactionIsForUser(owned, interaction(), DINAR)).toBe(true);
    expect(interactionIsForUser(stranger, interaction(), DINAR)).toBe(false);
    expect(
      interactionIsForUser(owned, interaction({ status: "accepted" }), DINAR),
    ).toBe(false);
  });

  it("approvals are surfaced to any board member (today: Динар)", () => {
    const a: ApprovalRef = { id: "ap", status: "pending", requestedByAgentId: "agent-x" };
    expect(approvalIsForUser(a, DINAR)).toBe(true);
    // Even when initiated by another user (board co-decider scenario):
    const b: ApprovalRef = { id: "ap2", status: "pending", requestedByUserId: OTHER };
    expect(approvalIsForUser(b, DINAR)).toBe(true);
  });
});
