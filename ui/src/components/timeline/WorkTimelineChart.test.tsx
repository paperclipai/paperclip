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

    const timeAxis = container.querySelector<HTMLElement>("[data-testid='work-timeline-time-axis']");

    expect(timeAxis?.textContent).toContain("Jul 2");
    expect(timeAxis?.textContent).toContain("AM");
    expect(timeAxis?.textContent).not.toContain("09:00");
  });

  it("freezes the time axis over vertical scrolling while preserving horizontal alignment", async () => {
    renderChart(timelineSample());

    const scroller = container.querySelector<HTMLElement>("[data-testid='work-timeline-scroll']")!;
    const timeAxis = container.querySelector<HTMLElement>("[data-testid='work-timeline-time-axis']")!;
    const axisSvg = timeAxis.querySelector<SVGSVGElement>("svg")!;

    expect(timeAxis.getAttribute("class")).toContain("absolute");
    expect(timeAxis.getAttribute("class")).toContain("top-0");
    expect(timeAxis.style.height).toBe("32px");
    expect(axisSvg.style.transform).toBe("translateX(0px)");

    flushSync(() => {
      Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 400 });
      Object.defineProperty(scroller, "scrollLeft", { configurable: true, value: 240 });
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(timeAxis.textContent).toContain("Jul 2");
    expect(axisSvg.style.transform).toBe("translateX(-240px)");
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
    expect(gutter?.getAttribute("class")).not.toContain("top-0");
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

  it("keeps connectors hidden until hover, renders them orthogonally, and highlights the connected graph", async () => {
    const data = timelineSample();
    data.actors.push({ id: "agent:cto", type: "agent", name: "CTO" });
    data.spans.push(
      {
        actorId: "agent:cto",
        laneHint: null,
        runId: "run-3",
        issueId: "issue-3",
        issueIdentifier: "PAP-12427",
        issueTitle: "Follow-up validation",
        start: "2026-07-02T11:45:00.000Z",
        end: "2026-07-02T12:00:00.000Z",
        status: "completed",
        retryOfRunId: null,
      },
      {
        actorId: "agent:codex",
        laneHint: null,
        runId: "run-4",
        issueId: "issue-4",
        issueIdentifier: "PAP-12428",
        issueTitle: "Unrelated work",
        start: "2026-07-02T13:00:00.000Z",
        end: "2026-07-02T14:00:00.000Z",
        status: "completed",
        retryOfRunId: null,
      },
    );
    data.edges = [
      {
        fromActorId: "agent:codex",
        toActorId: "agent:qa",
        issueId: "issue-2",
        at: "2026-07-02T10:45:00.000Z",
        kind: "delegation",
      },
      {
        fromActorId: "agent:qa",
        toActorId: "agent:cto",
        issueId: "issue-3",
        at: "2026-07-02T11:35:00.000Z",
        kind: "delegation",
      },
    ];
    renderChart(data);

    expect(container.querySelectorAll("[data-testid='timeline-connector']")).toHaveLength(0);

    const hovered = container.querySelector<SVGGElement>("[data-run-id='run-2']")!;
    flushSync(() => {
      hovered.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 100, clientY: 100 }));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelectorAll("[data-testid='timeline-connector']")).toHaveLength(2);
    const connectorStrokePaths = Array.from(
      container.querySelectorAll<SVGPathElement>("[data-testid='timeline-connector'] path[fill='none']"),
    );
    expect(connectorStrokePaths.map((path) => path.getAttribute("d"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/ V.+ H/)]),
    );
    expect(container.querySelector("[data-run-id='run-1']")?.getAttribute("data-connected-state")).toBe("connected");
    expect(container.querySelector("[data-run-id='run-2']")?.getAttribute("data-connected-state")).toBe("connected");
    expect(container.querySelector("[data-run-id='run-3']")?.getAttribute("data-connected-state")).toBe("connected");
    expect(container.querySelector("[data-run-id='run-4']")?.getAttribute("data-connected-state")).toBe("faded");

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
      { sourceRunId: "run-2", targetRunId: "run-3", dashed: false },
    ]);
    const bars = new Map(layout.rows.flatMap((row) => row.bars.map((bar) => [bar.span.runId, bar])));
    expect(layout.connectors[0].x1).toBe(bars.get("run-1")?.x2);
    expect(layout.connectors[0].x2).toBe(bars.get("run-2")?.x1);
  });

  it("renders kickoff chips for human users but not delegating agents", () => {
    const data = timelineSample();
    data.actors.push({ id: "user:dotta", type: "user", name: "Dotta" });
    data.edges = [
      {
        fromActorId: "user:dotta",
        toActorId: "agent:codex",
        issueId: "issue-1",
        at: "2026-07-02T08:45:00.000Z",
        kind: "delegation",
      },
      {
        fromActorId: "agent:codex",
        toActorId: "agent:qa",
        issueId: "issue-2",
        at: "2026-07-02T10:45:00.000Z",
        kind: "delegation",
      },
    ];

    renderChart(data);

    const kickoffChips = container.querySelectorAll("[data-testid='timeline-kickoff-chip']");
    expect(kickoffChips).toHaveLength(1);
    expect(kickoffChips[0].textContent).toContain("DO");
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

  it("cleans up chart drag listeners when unmounted mid-drag", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    renderChart(timelineSample(), { onZoomScaleChange: vi.fn() });

    const chartSvg = container.querySelector<SVGSVGElement>("svg.absolute")!;
    vi.spyOn(chartSvg, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 400,
      width: 1000,
      height: 400,
      toJSON: () => ({}),
    });

    flushSync(() => {
      chartSvg.dispatchEvent(new MouseEvent("mousedown", { clientX: 260, bubbles: true, cancelable: true }));
    });

    expect(add).toHaveBeenCalledWith("mousemove", expect.any(Function));
    expect(add).toHaveBeenCalledWith("mouseup", expect.any(Function));

    flushSync(() => root.unmount());
    root = createRoot(container);

    expect(remove).toHaveBeenCalledWith("mousemove", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("mouseup", expect.any(Function));
  });

  it("cleans up minimap drag listeners when unmounted mid-drag", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    renderChart(timelineSample(), { onZoomScaleChange: vi.fn() });

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
    });

    expect(add).toHaveBeenCalledWith("mousemove", expect.any(Function));
    expect(add).toHaveBeenCalledWith("mouseup", expect.any(Function));

    flushSync(() => root.unmount());
    root = createRoot(container);

    expect(remove).toHaveBeenCalledWith("mousemove", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("mouseup", expect.any(Function));
  });

  it("keeps the default now timestamp stable across rerenders", () => {
    const now = new Date("2026-07-02T12:00:00.000Z").getTime();
    const later = new Date("2026-07-02T13:00:00.000Z").getTime();
    let currentNow = now;
    vi.spyOn(Date, "now").mockImplementation(() => currentNow);
    const data = timelineSample();
    data.spans[0] = {
      ...data.spans[0],
      end: null,
      status: "running",
    };

    renderChart(data, { nowMs: undefined });
    const initialWidth = container
      .querySelector<SVGRectElement>("[data-run-id='run-1'] rect")
      ?.getAttribute("width");

    currentNow = later;
    renderChart(data, { nowMs: undefined });

    expect(container.querySelector<SVGRectElement>("[data-run-id='run-1'] rect")?.getAttribute("width")).toBe(initialWidth);
  });

  it("lets dragging the chart grid select a time range to zoom into", () => {
    const onZoomScaleChange = vi.fn();
    renderChart(timelineSample(), { onZoomScaleChange });

    const chartSvg = container.querySelector<SVGSVGElement>("svg.absolute")!;
    const width = Number(chartSvg.getAttribute("width") ?? "1000");
    const height = Number(chartSvg.getAttribute("height") ?? "400");
    vi.spyOn(chartSvg, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    });

    flushSync(() => {
      chartSvg.dispatchEvent(new MouseEvent("mousedown", { clientX: 260, bubbles: true, cancelable: true }));
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 520, bubbles: true, cancelable: true }));
    });

    expect(container.querySelector("[data-testid='timeline-drag-selection']")).not.toBeNull();

    flushSync(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: 520, bubbles: true, cancelable: true }));
    });

    expect(onZoomScaleChange).toHaveBeenCalled();
    expect(container.querySelector("[data-testid='timeline-drag-selection']")).toBeNull();
  });
});
