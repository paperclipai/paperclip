// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel, isReleaseApproval, resolvedApprovalLabel, RELEASE_MANAGER_AGENT_ID } from "./ApprovalPayload";
import type { Approval } from "@paperclipai/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });
});

function makeTestApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-test",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-04-01"),
    updatedAt: new Date("2026-04-01"),
    ...overrides,
  };
}

describe("isReleaseApproval", () => {
  it("returns false for hire_agent type", () => {
    expect(isReleaseApproval(makeTestApproval({ type: "hire_agent" }))).toBe(false);
  });

  it("returns false for request_board_approval with empty payload", () => {
    expect(isReleaseApproval(makeTestApproval({ payload: {} }))).toBe(false);
  });

  it("returns true when payload.approvalCategory is 'release'", () => {
    expect(
      isReleaseApproval(makeTestApproval({ payload: { approvalCategory: "release" } })),
    ).toBe(true);
  });

  it("returns true when payload.releaseAction is a non-empty string", () => {
    expect(
      isReleaseApproval(makeTestApproval({ payload: { releaseAction: "approve_release" } })),
    ).toBe(true);
  });

  it("returns true when requestedByAgentId matches RELEASE_MANAGER_AGENT_ID", () => {
    expect(
      isReleaseApproval(makeTestApproval({ requestedByAgentId: RELEASE_MANAGER_AGENT_ID })),
    ).toBe(true);
  });

  it("returns false when requestedByAgentId is a different UUID", () => {
    expect(
      isReleaseApproval(makeTestApproval({ requestedByAgentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })),
    ).toBe(false);
  });

  it("returns true when both discriminator and agent ID match", () => {
    expect(
      isReleaseApproval(
        makeTestApproval({
          requestedByAgentId: RELEASE_MANAGER_AGENT_ID,
          payload: { approvalCategory: "release" },
        }),
      ),
    ).toBe(true);
  });
});

describe("resolvedApprovalLabel", () => {
  it("returns 'Release Approval: [title]' for release approval", () => {
    expect(
      resolvedApprovalLabel(
        makeTestApproval({
          payload: { approvalCategory: "release", title: "v2.1.0 hotfix" },
        }),
      ),
    ).toBe("Release Approval: v2.1.0 hotfix");
  });

  it("returns 'Board Approval: [title]' for non-release board approval", () => {
    expect(
      resolvedApprovalLabel(
        makeTestApproval({
          payload: { title: "Reply with an ASCII frog" },
        }),
      ),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});
