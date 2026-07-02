// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkTimelineChart } from "./WorkTimelineChart";

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function renderChart(data: WorkTimelineResult) {
  flushSync(() => {
    root.render(
      <WorkTimelineChart
        data={data}
        zoom="hour"
        colorMode="issue"
        nowMs={new Date("2026-07-02T12:00:00.000Z").getTime()}
      />,
    );
  });
}

function timelineSample(): WorkTimelineResult {
  return {
    actors: [
      { id: "agent:codex", type: "agent", name: "CodexCoder" },
      { id: "agent:qa", type: "agent", name: "QA" },
    ],
    spans: [
      {
        actorId: "agent:codex",
        laneHint: null,
        runId: "run-1",
        issueId: "issue-1",
        issueIdentifier: "PAP-12443",
        issueTitle: "Work Timeline sticky gutter",
        start: "2026-07-02T09:00:00.000Z",
        end: "2026-07-02T10:00:00.000Z",
        status: "completed",
        retryOfRunId: null,
      },
      {
        actorId: "agent:qa",
        laneHint: null,
        runId: "run-2",
        issueId: "issue-2",
        issueIdentifier: "PAP-12426",
        issueTitle: "QA validation",
        start: "2026-07-02T11:00:00.000Z",
        end: "2026-07-02T11:30:00.000Z",
        status: "completed",
        retryOfRunId: null,
      },
    ],
    events: [],
    edges: [],
    pagination: { limit: 200, offset: 0, totalIssues: 2, hasMore: false },
    window: {
      from: "2026-07-02T00:00:00.000Z",
      to: "2026-07-03T00:00:00.000Z",
      capped: false,
    },
  };
}

describe("WorkTimelineChart", () => {
  it("renders actor labels in a sticky gutter outside the horizontally scrolling SVG", () => {
    renderChart(timelineSample());

    const scroller = container.querySelector<HTMLElement>("[data-testid='work-timeline-scroll']");
    const gutter = container.querySelector<SVGSVGElement>("[data-testid='work-timeline-actor-gutter']");
    const chartSvg = container.querySelector<SVGSVGElement>("svg.absolute");

    expect(scroller).not.toBeNull();
    expect(gutter).not.toBeNull();
    expect(chartSvg).not.toBeNull();
    expect(gutter?.getAttribute("class")).toContain("sticky");
    expect(gutter?.getAttribute("class")).toContain("left-0");
    expect(gutter?.getAttribute("width")).toBe("176");
    expect(chartSvg?.getAttribute("width")).not.toBe(gutter?.getAttribute("width"));
    expect(gutter?.textContent).toContain("CodexCoder");

    flushSync(() => {
      scroller!.scrollLeft = 10_000;
      scroller!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    expect(container.querySelector("[data-testid='work-timeline-actor-gutter']")?.textContent).toContain("CodexCoder");
  });
});
