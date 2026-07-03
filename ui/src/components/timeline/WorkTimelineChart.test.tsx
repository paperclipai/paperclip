// @vitest-environment jsdom

import { flushSync } from "react-dom";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkTimelineChart } from "./WorkTimelineChart";
import { computeLayout } from "@/lib/timeline/layout";

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/PAP/timeline" }),
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
  vi.restoreAllMocks();
});

function renderChart(
  data: WorkTimelineResult,
  props: Partial<ComponentProps<typeof WorkTimelineChart>> = {},
) {
  flushSync(() => {
    root.render(
      <WorkTimelineChart
        data={data}
        zoom="hour"
        colorMode="issue"
        nowMs={new Date("2026-07-02T12:00:00.000Z").getTime()}
        {...props}
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
  it("renders date-aware AM/PM labels on the header axis", () => {
    renderChart(timelineSample());

    const chartSvg = container.querySelector<SVGSVGElement>("svg.absolute");

    expect(chartSvg?.textContent).toContain("Jul 2");
    expect(chartSvg?.textContent).toContain("AM");
    expect(chartSvg?.textContent).not.toContain("09:00");
  });

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

  it("does not render created diamonds or comment bubbles from instant events", () => {
    const data = timelineSample();
    data.actors.push({ id: "user:dotta", type: "user", name: "Dotta" });
    data.events = [
      { actorId: "user:dotta", kind: "created", issueId: "issue-1", at: "2026-07-02T08:30:00.000Z" },
      { actorId: "user:dotta", kind: "commented", issueId: "issue-2", at: "2026-07-02T09:15:00.000Z" },
      { actorId: "user:dotta", kind: "approved", issueId: "issue-1", at: "2026-07-02T10:05:00.000Z" },
    ];
    renderChart(data);

    const gutter = container.querySelector<SVGSVGElement>("[data-testid='work-timeline-actor-gutter']");
    expect(gutter?.textContent).not.toContain("Dotta");
    expect(container.querySelectorAll("[data-testid='timeline-event-marker']")).toHaveLength(0);
    expect(container.querySelectorAll("[data-testid='timeline-comment-marker']")).toHaveLength(0);
  });

  it("keeps connector lines hidden until hover and preserves run ids for filtering", () => {
    const data = timelineSample();
    data.edges = [
      {
        fromActorId: "agent:codex",
        toActorId: "agent:qa",
        issueId: "issue-2",
        at: "2026-07-02T10:45:00.000Z",
        kind: "delegation",
      },
    ];
    renderChart(data);

    expect(container.querySelectorAll("[data-testid='timeline-connector']")).toHaveLength(0);

    const layout = computeLayout(data, {
      gutter: 176,
      rowH: 34,
      barH: 15,
      laneGap: 4,
      pxPerMinute: 8,
      nowMs: new Date("2026-07-02T12:00:00.000Z").getTime(),
    });
    expect(layout.connectors).toMatchObject([
      { sourceRunId: "run-1", targetRunId: "run-2", dashed: false },
    ]);
    const bars = new Map(layout.rows.flatMap((row) => row.bars.map((bar) => [bar.span.runId, bar])));
    expect(layout.connectors[0].x1).toBe(bars.get("run-1")?.x2);
    expect(layout.connectors[0].x2).toBe(bars.get("run-2")?.x1);
  });

  it("reserves normal wheel input for panning and uses modifier-wheel for continuous zoom", () => {
    const onZoomScaleChange = vi.fn();
    renderChart(timelineSample(), { onZoomScaleChange });

    const scroller = container.querySelector<HTMLElement>("[data-testid='work-timeline-scroll']")!;
    flushSync(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 80, bubbles: true, cancelable: true }));
    });
    expect(onZoomScaleChange).not.toHaveBeenCalled();

    flushSync(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 80, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(onZoomScaleChange).toHaveBeenCalledTimes(1);
  });

  it("opens task bars in a new company-prefixed window", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderChart(timelineSample());

    const bar = container.querySelector<SVGGElement>("[data-run-id='run-1']")!;
    flushSync(() => {
      bar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(open).toHaveBeenCalledWith("/PAP/issues/issue-1", "_blank", "noopener,noreferrer");
  });

  it("lets minimap edge handles resize the visible range and update zoom", () => {
    const onZoomScaleChange = vi.fn();
    renderChart(timelineSample(), { onZoomScaleChange });

    const rightHandle = container.querySelector<SVGRectElement>("[data-testid='timeline-minimap-right-handle']")!;
    const minimap = rightHandle.ownerSVGElement!;
    vi.spyOn(minimap, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 900,
      bottom: 54,
      width: 900,
      height: 54,
      toJSON: () => ({}),
    });

    flushSync(() => {
      rightHandle.dispatchEvent(new MouseEvent("mousedown", { clientX: 300, bubbles: true, cancelable: true }));
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 520, bubbles: true, cancelable: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    expect(onZoomScaleChange).toHaveBeenCalled();
  });
});
