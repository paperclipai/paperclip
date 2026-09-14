// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineAuditActivity } from "./RoutineAuditActivity";

const getRoutineMock = vi.hoisted(() => vi.fn());
const listRoutineRunsMock = vi.hoisted(() => vi.fn());
const routineActivityMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/routines", () => ({
  routinesApi: {
    get: (routineId: string) => getRoutineMock(routineId),
    listRuns: (routineId: string, limit?: number) => listRoutineRunsMock(routineId, limit),
    activity: (
      companyId: string,
      routineId: string,
      scope: { triggerIds: string[]; runIds: string[] },
    ) => routineActivityMock(companyId, routineId, scope),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("RoutineAuditActivity", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getRoutineMock.mockResolvedValue({ triggers: [{ id: "trigger-1" }, { id: "trigger-2" }] });
    listRoutineRunsMock.mockResolvedValue([{ id: "run-1" }, { id: "run-2" }]);
    routineActivityMock.mockResolvedValue([
      {
        id: "event-1",
        action: "routine.run.completed",
        details: { runId: "run-1" },
        createdAt: new Date("2026-08-31T18:01:05.000Z"),
      },
    ]);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("loads activity through the routine endpoint with its trigger and run scope", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RoutineAuditActivity companyId="company-1" routineId="routine-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(getRoutineMock).toHaveBeenCalledWith("routine-1");
    expect(listRoutineRunsMock).toHaveBeenCalledWith("routine-1", 200);
    expect(routineActivityMock).toHaveBeenCalledWith("company-1", "routine-1", {
      triggerIds: ["trigger-1", "trigger-2"],
      runIds: ["run-1", "run-2"],
    });
    expect(container.textContent).toContain("routine.run.completed");
  });
});
