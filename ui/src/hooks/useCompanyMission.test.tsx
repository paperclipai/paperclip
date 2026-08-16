// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal } from "@paperclipai/shared";
import { useCompanyMission } from "./useCompanyMission";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockGoalsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));

function companyGoal(id: string): Goal {
  return {
    id,
    companyId: "company-1",
    title: "Ship the thing",
    description: null,
    level: "company",
    status: "active",
    parentId: null,
    ownerAgentId: null,
    createdAt: new Date("2026-03-02T00:00:00Z"),
    updatedAt: new Date("2026-03-02T00:00:00Z"),
  } as Goal;
}

let captured: ReturnType<typeof useCompanyMission> | null = null;

function Harness({ companyId }: { companyId: string | null }) {
  captured = useCompanyMission(companyId);
  return null;
}

describe("useCompanyMission", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  let root: Root | null = null;

  function render(companyId: string | null) {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Harness companyId={companyId} />
        </QueryClientProvider>,
      );
    });
  }

  // React Query resolves through microtasks and React schedules the re-render
  // after them, so a single tick is not reliably enough under load. Drain
  // until the hook reports an answer rather than guessing at a tick count.
  async function settle() {
    for (let i = 0; i < 50 && !captured?.settled; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  beforeEach(() => {
    captured = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it("withholds an answer while the lookup is in flight", () => {
    mockGoalsApi.list.mockReturnValue(new Promise(() => {}));
    render("company-1");

    expect(captured).toEqual({
      hasMission: undefined,
      settled: false,
      mission: { goalId: null, goalInput: "" },
      fetching: true,
    });
  });

  it("reports a mission when the company has a company-level goal", async () => {
    mockGoalsApi.list.mockResolvedValue([companyGoal("goal-1")]);
    render("company-1");
    await settle();

    // The mission comes back in the shape the wizard's textarea holds, so the
    // agent step can seed the lead agent's instructions from it.
    expect(captured).toEqual({
      hasMission: true,
      settled: true,
      mission: { goalId: "goal-1", goalInput: "Ship the thing" },
      fetching: false,
    });
  });

  it("reports no mission when the company has no company-level goal", async () => {
    mockGoalsApi.list.mockResolvedValue([]);
    render("company-1");
    await settle();

    expect(captured).toEqual({
      hasMission: false,
      settled: true,
      mission: { goalId: null, goalInput: "" },
      fetching: false,
    });
  });

  it("settles with an unknown mission when the lookup fails", async () => {
    // The fail-open rule. Waiting for the data itself would leave `settled`
    // false forever after a request exhausts its retries, and every caller
    // gates opening onboarding on it — an agentless company would then get no
    // onboarding at all, which is worse than being asked for its mission
    // twice.
    mockGoalsApi.list.mockRejectedValue(new Error("goals unavailable"));
    render("company-1");
    await settle();

    expect(captured).toEqual({
      hasMission: undefined,
      settled: true,
      mission: { goalId: null, goalInput: "" },
      fetching: false,
    });
  });

  it("settles immediately when there is no company to ask about", () => {
    // A disabled query stays pending forever. Reading that as "still loading"
    // is the same failure as above, reached without a request.
    render(null);

    expect(captured).toEqual({
      hasMission: undefined,
      settled: true,
      mission: { goalId: null, goalInput: "" },
      fetching: false,
    });
    expect(mockGoalsApi.list).not.toHaveBeenCalled();
  });
});
