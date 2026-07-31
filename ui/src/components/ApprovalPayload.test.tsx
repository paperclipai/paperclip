// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";

const mockPluginSlotOutlet = vi.hoisted(() => vi.fn(() => null));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: mockPluginSlotOutlet,
}));

type PluginSlotOutletMockProps = {
  slotTypes: string[];
  context: Record<string, unknown>;
  componentProps: Record<string, unknown>;
};

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
    mockPluginSlotOutlet.mockClear();
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

  it("mounts approvalPayloadField slots with approval and payload props", () => {
    const root = createRoot(container);
    const payload = {
      title: "Open deployment deck",
      summary: "Review typed artifact links before deciding.",
    };
    const approval: Approval = {
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-07-03T10:00:00.000Z"),
      updatedAt: new Date("2026-07-03T10:00:00.000Z"),
    };

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={payload}
          approval={approval}
          companyPrefix="PAP"
        />,
      );
    });

    const outletCalls = mockPluginSlotOutlet.mock.calls as unknown as Array<[PluginSlotOutletMockProps]>;
    const payloadSlotProps = outletCalls
      .map(([props]) => props)
      .find((props) => props.slotTypes.includes("approvalPayloadField"));

    expect(payloadSlotProps).toBeDefined();
    expect(payloadSlotProps?.context).toMatchObject({
      companyId: "company-1",
      companyPrefix: "PAP",
    });
    expect(payloadSlotProps?.componentProps).toMatchObject({
      approval,
      payload,
    });

    act(() => {
      root.unmount();
    });
  });
});
