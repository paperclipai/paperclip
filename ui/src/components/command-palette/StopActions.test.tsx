// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import {
  useStopActions,
  StopConfirmDialog,
  type StopActions as StopActionsHandle,
} from "./StopActions";
import type { LiveRunForIssue } from "../../api/heartbeats";

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
  cancel: vi.fn(),
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

vi.mock("../../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../../context/ToastContext", () => ({
  useToastActions: () => toastState,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

const RUN_A: LiveRunForIssue = {
  id: "run-a",
  status: "running",
  invocationSource: "manual",
  triggerDetail: null,
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  agentId: "agent-a",
  agentName: "Agent A",
  adapterType: "claude",
  issueId: "issue-a",
};

const RUN_B: LiveRunForIssue = {
  ...RUN_A,
  id: "run-b",
  agentId: "agent-b",
  agentName: "Agent B",
  issueId: "issue-b",
};

const ISSUES: Issue[] = [
  { id: "issue-a", title: "Fix the thing" } as Issue,
  { id: "issue-b", title: "Ship the other thing" } as Issue,
];

/** Minimal harness exposing the hook's live return value for assertions and re-renders. */
function Harness({
  onReady,
  query = "",
}: {
  onReady: (stop: StopActionsHandle) => void;
  query?: string;
}) {
  const stop = useStopActions({ companyId: "company-1", open: true, query, issues: ISSUES });
  onReady(stop);
  return (
    <div>
      <StopConfirmDialog stop={stop} />
    </div>
  );
}

function renderHarness(container: HTMLDivElement, onReady: (stop: StopActionsHandle) => void) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness onReady={onReady} />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("useStopActions", () => {
  let container: HTMLDivElement;
  let latest: StopActionsHandle;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.liveRunsForCompany.mockReset();
    mockHeartbeatsApi.cancel.mockReset();
    toastState.pushToast.mockReset();
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([RUN_A, RUN_B]);
    mockHeartbeatsApi.cancel.mockResolvedValue(undefined);
  });

  afterEach(() => {
    container.remove();
  });

  it("stopping all agents cancels every live run", async () => {
    renderHarness(container, (stop) => {
      latest = stop;
    });
    await waitForAssertion(() => expect(latest.liveRunCount).toBe(2));

    act(() => latest.selectStopAll());
    expect(latest.pendingStop?.runIds.sort()).toEqual(["run-a", "run-b"]);

    act(() => latest.confirmStop());
    await waitForAssertion(() => {
      expect(mockHeartbeatsApi.cancel).toHaveBeenCalledWith("run-a");
      expect(mockHeartbeatsApi.cancel).toHaveBeenCalledWith("run-b");
    });
  });

  it("stopping an agent only cancels that agent's runs", async () => {
    renderHarness(container, (stop) => {
      latest = stop;
    });
    await waitForAssertion(() => expect(latest.liveRunCount).toBe(2));

    const agentA = latest.filteredAgents.find((a) => a.agentId === "agent-a")!;
    act(() => latest.selectAgent(agentA));
    expect(latest.pendingStop?.runIds).toEqual(["run-a"]);

    act(() => latest.confirmStop());
    await waitForAssertion(() => {
      expect(mockHeartbeatsApi.cancel).toHaveBeenCalledWith("run-a");
      expect(mockHeartbeatsApi.cancel).not.toHaveBeenCalledWith("run-b");
    });
  });

  it("stopping a task cancels only that task's run and shows its title", async () => {
    renderHarness(container, (stop) => {
      latest = stop;
    });
    await waitForAssertion(() => expect(latest.liveRunCount).toBe(2));

    act(() => latest.selectTask(RUN_B));
    expect(latest.pendingStop?.runIds).toEqual(["run-b"]);
    expect(latest.pendingStop?.title).toContain("Ship the other thing");

    act(() => latest.confirmStop());
    await waitForAssertion(() => {
      expect(mockHeartbeatsApi.cancel).toHaveBeenCalledWith("run-b");
      expect(mockHeartbeatsApi.cancel).not.toHaveBeenCalledWith("run-a");
    });
  });

  it("stopping all agents when nothing is running does not open a confirmation", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    renderHarness(container, (stop) => {
      latest = stop;
    });
    await waitForAssertion(() => expect(latest.liveRunCount).toBe(0));

    act(() => latest.selectStopAll());
    expect(latest.pendingStop).toBeNull();
    expect(mockHeartbeatsApi.cancel).not.toHaveBeenCalled();
  });
});
