// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgNode } from "../api/agents";
import { useSeatManagement } from "./useSeatManagement";

const attachableMembersMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../api/seats", () => ({
  seatsApi: {
    attachableMembers: attachableMembersMock,
    detail: vi.fn(),
    update: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    attachHuman: vi.fn(),
    detachHuman: vi.fn(),
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sampleNode: OrgNode = {
  id: "agent-1",
  seatId: "seat-1",
  name: "Operations Seat",
  role: "engineer",
  seatType: "manager",
  operatingMode: "vacant",
  status: "idle",
  reports: [],
};

function Harness() {
  const seatManagement = useSeatManagement("company-1");
  return (
    <button
      type="button"
      data-testid="open"
      onClick={() => seatManagement.openAttachDialog(sampleNode)}
    >
      {seatManagement.attachableMembers.length}
    </button>
  );
}

describe("useSeatManagement", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    attachableMembersMock.mockClear();
  });

  afterEach(() => {
    container.remove();
  });

  it("does not load company members until the attach dialog is opened", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      );
    });

    expect(attachableMembersMock).not.toHaveBeenCalled();

    const openButton = container.querySelector('[data-testid="open"]') as HTMLButtonElement | null;
    expect(openButton).not.toBeNull();

    await act(async () => {
      openButton?.click();
      await Promise.resolve();
    });

    expect(attachableMembersMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });
});
