// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "./ApprovalCard";

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

describe("ApprovalCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockPluginSlotOutlet.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("mounts approvalCard slots with approval and payload props", () => {
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
        <ApprovalCard
          approval={approval}
          requesterAgent={null}
          companyPrefix="PAP"
        />,
      );
    });

    const outletCalls = mockPluginSlotOutlet.mock.calls as unknown as Array<[PluginSlotOutletMockProps]>;
    const cardSlotProps = outletCalls
      .map(([props]) => props)
      .find((props) => props.slotTypes.includes("approvalCard"));

    expect(cardSlotProps).toBeDefined();
    expect(cardSlotProps?.context).toMatchObject({
      companyId: "company-1",
      companyPrefix: "PAP",
    });
    expect(cardSlotProps?.componentProps).toMatchObject({
      approval,
      payload,
    });
  });
});
