// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { costsApi } from "../api/costs";
import costsSource from "./Costs.tsx?raw";
import {
  TimeAllocationTable,
  formatDuration,
  formatHours,
  timeAllocationAgentName,
  timeAllocationQueryOptions,
} from "./Costs";

async function act(callback: () => void | Promise<void>) {
  flushSync(() => {
    void callback();
  });
  await Promise.resolve();
}

describe("time allocation cost UI", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("formats minute and hour totals for operators", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(75)).toBe("1h 15m");
    expect(formatHours(1.5)).toBe("1.5h");
  });

  it("wires the selected company and date range to the time-allocation request", async () => {
    const response = {
      companyId: "company-1",
      totalMinutes: 0,
      totalHours: 0,
      eventCount: 0,
      costCents: 0,
      byProject: [],
      byAgent: [],
    };
    const request = vi.spyOn(costsApi, "timeAllocation").mockResolvedValue(response);
    const options = timeAllocationQueryOptions(
      "company-1",
      "2026-07-01T00:00:00.000Z",
      "2026-07-31T23:59:59.999Z",
      true,
    );

    await options.queryFn();

    expect(options.queryKey).toEqual([
      "time-allocation",
      "company-1",
      "2026-07-01T00:00:00.000Z",
      "2026-07-31T23:59:59.999Z",
    ]);
    expect(options.enabled).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "company-1",
      "2026-07-01T00:00:00.000Z",
      "2026-07-31T23:59:59.999Z",
    );

    const disabledOptions = timeAllocationQueryOptions(
      "company-1",
      "2026-07-01T00:00:00.000Z",
      "2026-07-31T23:59:59.999Z",
      false,
    );
    expect(disabledOptions.enabled).toBe(false);
  });

  it("renders time-allocation rows as display-only durations", async () => {
    await act(() => {
      root.render(
        <TimeAllocationTable
          title="By project"
          description="Minutes and hours grouped by project-attributed time events."
          rows={[
            {
              projectId: "project-1",
              projectName: "Memory Lake",
              minutes: 75,
              hours: 1.25,
              eventCount: 1,
              costCents: 0,
            },
          ]}
          nameForRow={(row) => row.projectName ?? row.projectId ?? "Unattributed project"}
          emptyMessage="No project-attributed time allocation events yet."
        />,
      );
    });

    expect(container.textContent).toContain("Memory Lake");
    expect(container.textContent).toContain("1 event");
    expect(container.textContent).toContain("$0.00 display cost");
    expect(container.textContent).toContain("1h 15m");
    expect(container.textContent).toContain("1.25h");
  });

  it("renders unmatched agent rows as unattributed", async () => {
    await act(() => {
      root.render(
        <TimeAllocationTable
          title="By agent"
          description="Minutes and hours grouped by reporting agent."
          rows={[
            {
              agentId: null,
              agentName: null,
              agentStatus: null,
              minutes: 20,
              hours: 1 / 3,
              eventCount: 1,
              costCents: 0,
            },
          ]}
          nameForRow={timeAllocationAgentName}
          emptyMessage="No agent time allocation events yet."
        />,
      );
    });

    expect(container.textContent).toContain("Unattributed agent");
  });

  it("renders a clear empty state", async () => {
    await act(() => {
      root.render(
        <TimeAllocationTable
          title="By agent"
          description="Minutes and hours grouped by reporting agent."
          rows={[]}
          nameForRow={() => "Agent"}
          emptyMessage="No agent time allocation events yet."
        />,
      );
    });

    expect(container.textContent).toContain("No agent time allocation events yet.");
  });

  it("explains zero-cent markers and labels unmatched agents without exposing foreign details", () => {
    expect(costsSource).toContain(
      'subtitle="Only zero-cent time markers appear here; nonzero time-coded events remain in normal cost accounting."',
    );
    expect(costsSource).toContain("nameForRow={timeAllocationAgentName}");
    expect(costsSource).not.toContain('subtitle="Time markers are excluded unless their cost is zero"');
  });
});
