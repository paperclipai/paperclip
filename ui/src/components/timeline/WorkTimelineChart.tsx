/**
 * Work Timeline — custom-SVG Gantt (board-locked Direction C, PAP-12422).
 *
 * Renders actor rows with concurrency sub-lanes, run bars (no issue IDs on the
 * bar — identity is the thin left colour tab; truncated title shows on hover),
 * human kickoff chips at each bar's leading edge, straight
 * hover-revealed agent→agent delegation connectors (dashed for retries), an
 * in-progress fade to "now", a hover tooltip, and a full-window mini-map with a
 * draggable brush.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "@/lib/router";
import type { WorkTimelineActor, WorkTimelineResult } from "@paperclipai/shared";
import { applyCompanyPrefix, extractCompanyPrefixFromPath } from "@/lib/company-routes";
import {
  AXIS_H,
  actorType,
  chooseTickStepMs,
  computeLayout,
  formatDuration,
  issueColor,
  shortLabel,
  type LayoutOptions,
  type PositionedBar,
} from "@/lib/timeline/layout";

export type ZoomLevel = "hour" | "day" | "week";

const ZOOM_DURATION_MIN: Record<ZoomLevel, number> = {
  hour: 60,
  day: 24 * 60,
  week: 7 * 24 * 60,
};
const MIN_PX_PER_MIN = 0.08;
const MAX_PX_PER_MIN = 12;
const DEFAULT_VIEWPORT_W = 960;
const MIN_MINIMAP_SELECTION_MS = 15 * 60 * 1000;

function plotViewportWidth(viewportWidth: number): number {
  return Math.max(240, viewportWidth - GEOM.gutter - 24);
}

export function zoomScaleForLevel(level: ZoomLevel, viewportWidth = DEFAULT_VIEWPORT_W): number {
  return clampScale(plotViewportWidth(viewportWidth) / ZOOM_DURATION_MIN[level]);
}

export function nearestZoomForScale(pxPerMinute: number, viewportWidth = DEFAULT_VIEWPORT_W): ZoomLevel {
  return (Object.entries(ZOOM_DURATION_MIN) as [ZoomLevel, number][]).reduce<ZoomLevel>((best, [level]) => (
    Math.abs(zoomScaleForLevel(level, viewportWidth) - pxPerMinute)
    < Math.abs(zoomScaleForLevel(best, viewportWidth) - pxPerMinute)
      ? level
      : best
  ), "day");
}

function clampScale(pxPerMinute: number): number {
  return Math.min(MAX_PX_PER_MIN, Math.max(MIN_PX_PER_MIN, pxPerMinute));
}

/** Pick an initial zoom whose plotted width comfortably fills a typical viewport. */
export function defaultZoomForWindow(fromMs: number, toMs: number): ZoomLevel {
  const hours = (toMs - fromMs) / 3_600_000;
  if (hours <= 4) return "hour";
  if (hours <= 48) return "day";
  return "week";
}

const GEOM: Omit<LayoutOptions, "pxPerMinute" | "nowMs"> = {
  gutter: 176,
  rowH: 34,
  barH: 15,
  laneGap: 4,
};
const AVATAR_R = 11;
const CHIP_R = 9;

interface TooltipState {
  x: number;
  y: number;
  bar: PositionedBar;
  connectorHint: string | null;
}

interface DragSelectionState {
  anchorX: number;
  currentX: number;
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const hasMinutes = d.getMinutes() !== 0;
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: hasMinutes ? "2-digit" : undefined,
    hour12: true,
  });
}

function fmtTick(ms: number, stepMs: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (stepMs >= 24 * 60 * 60 * 1000) {
    return date;
  }
  return `${date}, ${fmtClock(ms)}`;
}

export function formatVisibleDurationMinutes(minutes: number): string {
  const rounded = Math.max(1, Math.round(minutes));
  if (rounded >= 7 * 24 * 60 && rounded % (7 * 24 * 60) === 0) {
    const weeks = rounded / (7 * 24 * 60);
    return `${weeks} week${weeks === 1 ? "" : "s"} visible`;
  }
  if (rounded >= 24 * 60 && rounded % (24 * 60) === 0) {
    const days = rounded / (24 * 60);
    return `${days} day${days === 1 ? "" : "s"} visible`;
  }
  if (rounded >= 24 * 60) {
    const days = Math.floor(rounded / (24 * 60));
    const hours = Math.round((rounded % (24 * 60)) / 60);
    return `${days}d${hours > 0 ? ` ${hours}h` : ""} visible`;
  }
  if (rounded >= 60 && rounded % 60 === 0) {
    const hours = rounded / 60;
    return `${hours} hour${hours === 1 ? "" : "s"} visible`;
  }
  if (rounded >= 60) return `${Math.floor(rounded / 60)}h ${rounded % 60}m visible`;
  return `${rounded} minutes visible`;
}

function truncate(text: string, n = 42): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

/** An SVG avatar glyph: square for humans, dashed circle for system, circle for agents. */
function AvatarGlyph({
  cx,
  cy,
  r,
  label,
  type,
}: {
  cx: number;
  cy: number;
  r: number;
  label: string;
  type: string;
}) {
  const stroke = "var(--color-foreground)";
  const fill = type === "system" ? "var(--color-muted)" : "var(--color-card)";
  return (
    <g>
      {type === "user" ? (
        <rect x={cx - r} y={cy - r} width={2 * r} height={2 * r} rx={3} fill={fill} stroke={stroke} strokeWidth={1.5} />
      ) : (
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill={fill}
          stroke={stroke}
          strokeWidth={1.5}
          strokeDasharray={type === "system" ? "3 2" : undefined}
        />
      )}
      <text x={cx} y={cy + 3.4} fontSize={r > 10 ? 9 : 8} textAnchor="middle" fill={stroke}>
        {label}
      </text>
    </g>
  );
}

export interface WorkTimelineChartProps {
  data: WorkTimelineResult;
  zoom: ZoomLevel;
  zoomScale?: number;
  onZoomScaleChange?: (nextScale: number, nextZoom: ZoomLevel) => void;
  onVisibleRangeLabelChange?: (label: string) => void;
  /** override "now" (tests / stories); defaults to Date.now(). */
  nowMs?: number;
}

export function WorkTimelineChart({
  data,
  zoom,
  zoomScale,
  onZoomScaleChange,
  onVisibleRangeLabelChange,
  nowMs,
}: WorkTimelineChartProps) {
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialWindowKeyRef = useRef<string | null>(null);
  const centerMsRef = useRef<number | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [hoveredRunId, setHoveredRunId] = useState<string | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportW, setViewportW] = useState(0);
  const [dragSelection, setDragSelection] = useState<DragSelectionState | null>(null);

  const now = nowMs ?? Date.now();
  const pxPerMinute = zoomScale ?? zoomScaleForLevel(zoom, viewportW || DEFAULT_VIEWPORT_W);
  const layout = useMemo(
    () => computeLayout(data, { ...GEOM, pxPerMinute, nowMs: now }),
    [data, pxPerMinute, now],
  );
  const connectedRunIds = useMemo(() => {
    if (!hoveredRunId) return null;
    const connected = new Set([hoveredRunId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of layout.connectors) {
        if (connected.has(c.sourceRunId) && !connected.has(c.targetRunId)) {
          connected.add(c.targetRunId);
          changed = true;
        }
        if (connected.has(c.targetRunId) && !connected.has(c.sourceRunId)) {
          connected.add(c.sourceRunId);
          changed = true;
        }
      }
    }
    return connected;
  }, [hoveredRunId, layout.connectors]);
  const visibleConnectors = useMemo(
    () =>
      connectedRunIds
        ? layout.connectors.filter((c) => connectedRunIds.has(c.sourceRunId) && connectedRunIds.has(c.targetRunId))
        : [],
    [connectedRunIds, layout.connectors],
  );
  const companyPrefix = extractCompanyPrefixFromPath(location.pathname);

  const timeToScrollLeft = (ms: number, viewportWidth: number) => {
    const x = layout.gutter + ((ms - layout.fromMs) / 60000) * layout.pxPerMinute;
    return Math.max(0, Math.min(layout.width - viewportWidth, x - viewportWidth / 2));
  };

  const scrollCenterMs = (el: HTMLDivElement) => {
    const centerX = el.scrollLeft + el.clientWidth / 2;
    return layout.fromMs + ((centerX - layout.gutter) / layout.pxPerMinute) * 60000;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nextViewportW = el.clientWidth;
    if (nextViewportW > 0 && nextViewportW !== viewportW) setViewportW(nextViewportW);

    const windowKey = `${data.window.from}:${data.window.to}`;
    if (initialWindowKeyRef.current !== windowKey) {
      initialWindowKeyRef.current = windowKey;
      const latest = Math.max(0, layout.width - nextViewportW);
      el.scrollLeft = latest;
      setScrollLeft(latest);
      centerMsRef.current = scrollCenterMs(el);
      return;
    }

    if (centerMsRef.current != null) {
      const next = timeToScrollLeft(centerMsRef.current, nextViewportW);
      el.scrollLeft = next;
      setScrollLeft(next);
    }
  }, [data.window.from, data.window.to, layout.fromMs, layout.gutter, layout.pxPerMinute, layout.toMs, layout.width, viewportW]);

  useEffect(() => {
    if (!onVisibleRangeLabelChange) return;
    const effectiveViewportW = viewportW || DEFAULT_VIEWPORT_W;
    const minutes = plotViewportWidth(effectiveViewportW) / layout.pxPerMinute;
    onVisibleRangeLabelChange(formatVisibleDurationMinutes(minutes));
  }, [layout.pxPerMinute, onVisibleRangeLabelChange, viewportW]);

  const stepMs = chooseTickStepMs(layout.pxPerMinute);
  const ticks: number[] = [];
  const startTick = Math.ceil(layout.fromMs / stepMs) * stepMs;
  for (let ms = startTick; ms <= layout.toMs; ms += stepMs) ticks.push(ms);

  const barFill = (bar: PositionedBar): string => issueColor(bar.span.issueId);

  const openIssue = (issueId: string) => {
    const href = applyCompanyPrefix(`/issues/${encodeURIComponent(issueId)}`, companyPrefix);
    window.open(href, "_blank", "noopener,noreferrer");
  };

  const updateVisibleRange = (fromMs: number, toMs: number) => {
    if (!onZoomScaleChange) return;
    const el = scrollRef.current;
    const boundedFrom = Math.max(layout.fromMs, Math.min(layout.toMs, fromMs));
    const boundedTo = Math.max(layout.fromMs, Math.min(layout.toMs, toMs));
    const startMs = Math.min(boundedFrom, boundedTo);
    const endMs = Math.max(boundedFrom, boundedTo);
    const durationMs = Math.max(MIN_MINIMAP_SELECTION_MS, endMs - startMs);
    const centerMs = startMs + durationMs / 2;
    const effectiveViewportW = el?.clientWidth || viewportW || DEFAULT_VIEWPORT_W;
    const nextScale = clampScale(plotViewportWidth(effectiveViewportW) / (durationMs / 60000));
    centerMsRef.current = centerMs;
    onZoomScaleChange(nextScale, nearestZoomForScale(nextScale, effectiveViewportW));
  };

  const svgXFromClientX = (clientX: number, el: SVGSVGElement) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return layout.gutter;
    const x = ((clientX - rect.left) / rect.width) * layout.width;
    return Math.max(layout.gutter, Math.min(layout.width - 40, x));
  };

  const msFromSvgX = (x: number) => (
    layout.fromMs + ((x - layout.gutter) / layout.pxPerMinute) * 60000
  );

  const handlePlotMouseDown = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!onZoomScaleChange || event.button !== 0) return;
    const el = event.currentTarget;
    const startX = svgXFromClientX(event.clientX, el);
    event.preventDefault();
    setTooltip(null);
    setHoveredRunId(null);
    setDragSelection({ anchorX: startX, currentX: startX });

    const move = (moveEvent: MouseEvent) => {
      setDragSelection((prev) => prev && {
        ...prev,
        currentX: svgXFromClientX(moveEvent.clientX, el),
      });
    };
    const up = (upEvent: MouseEvent) => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      const endX = svgXFromClientX(upEvent.clientX, el);
      setDragSelection(null);
      if (Math.abs(endX - startX) < 8) return;
      const fromMs = Math.min(msFromSvgX(startX), msFromSvgX(endX));
      const toMs = Math.max(msFromSvgX(startX), msFromSvgX(endX));
      updateVisibleRange(fromMs, toMs);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  const connectorHintForBar = (bar: PositionedBar): string | null => {
    const related = layout.connectors.filter((c) => c.sourceRunId === bar.span.runId || c.targetRunId === bar.span.runId);
    if (related.length === 0) return null;
    return related.some((c) => c.dashed)
      ? "dashed handoff: retry or changes requested"
      : "solid handoff: delegation or assignment";
  };

  const showTooltip = (evt: React.MouseEvent, bar: PositionedBar) => {
    setHoveredRunId(bar.span.runId);
    setTooltip({ x: evt.clientX, y: evt.clientY, bar, connectorHint: connectorHintForBar(bar) });
  };

  const handleWheel = (evt: React.WheelEvent<HTMLDivElement>) => {
    if (!onZoomScaleChange || !(evt.ctrlKey || evt.metaKey || evt.altKey)) return;
    evt.preventDefault();
    const el = scrollRef.current;
    if (el) {
      centerMsRef.current = scrollCenterMs(el);
    }
    const nextScale = clampScale(layout.pxPerMinute * Math.exp(-evt.deltaY * 0.001));
    onZoomScaleChange(nextScale, nearestZoomForScale(nextScale, el?.clientWidth ?? viewportW));
  };

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        className="max-h-[70vh] overflow-auto"
        data-testid="work-timeline-scroll"
        onScroll={(e) => {
          setScrollLeft(e.currentTarget.scrollLeft);
          centerMsRef.current = scrollCenterMs(e.currentTarget);
        }}
        onWheel={handleWheel}
      >
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <ActorGutter rows={layout.rows} height={layout.height} />

          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="absolute inset-0 block select-none"
            onMouseDown={handlePlotMouseDown}
            ref={(el) => {
              if (el && viewportW === 0 && scrollRef.current) setViewportW(scrollRef.current.clientWidth);
            }}
          >
          <defs>
            <linearGradient id="tl-fade" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--color-foreground)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--color-foreground)" stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* row backgrounds */}
          {layout.rows.map((row, i) => (
            <rect
              key={`bg-${row.actor.id}`}
              x={0}
              y={row.y + AXIS_H}
              width={layout.width}
              height={row.h}
              fill={i % 2 ? "var(--color-muted)" : "transparent"}
              opacity={i % 2 ? 0.35 : 1}
            />
          ))}

          {/* gridlines + time labels */}
          {ticks.map((ms) => {
            const gx = layout.gutter + ((ms - layout.fromMs) / 60000) * layout.pxPerMinute;
            return (
              <g key={`tick-${ms}`}>
                <line x1={gx} y1={AXIS_H} x2={gx} y2={layout.height} stroke="var(--color-border)" strokeWidth={1} />
                <text x={gx + 3} y={19} fontSize={11} fill="var(--color-muted-foreground)">
                  {fmtTick(ms, stepMs)}
                </text>
              </g>
            );
          })}

          {/* now line */}
          {now >= layout.fromMs && now <= layout.toMs && (
            <line
              x1={layout.gutter + ((now - layout.fromMs) / 60000) * layout.pxPerMinute}
              y1={AXIS_H}
              x2={layout.gutter + ((now - layout.fromMs) / 60000) * layout.pxPerMinute}
              y2={layout.height}
              stroke="var(--color-primary)"
              strokeWidth={1}
              strokeDasharray="2 3"
              opacity={0.7}
            />
          )}

          {/* gutter divider + axis baseline */}
          <line x1={layout.gutter} y1={0} x2={layout.gutter} y2={layout.height} stroke="var(--color-foreground)" strokeWidth={1.5} />
          <line x1={0} y1={AXIS_H} x2={layout.width} y2={AXIS_H} stroke="var(--color-foreground)" strokeWidth={1.5} />

          {/* connectors (behind bars): hover reveals the connected handoff graph. */}
          {visibleConnectors.map((c, i) => {
            const y1 = c.y1 + AXIS_H;
            const y2 = c.y2 + AXIS_H;
            const arrow =
              c.x2 >= c.x1
                ? `M${c.x2},${y2} l-10,-5 l0,10 z`
                : `M${c.x2},${y2} l10,-5 l0,10 z`;
            return (
              <g key={`edge-${c.sourceRunId}-${c.targetRunId}-${i}`} data-testid="timeline-connector" opacity={0.86}>
                <path
                  d={`M${c.x1},${y1} V${y2} H${c.x2}`}
                  fill="none"
                  stroke="var(--color-foreground)"
                  strokeWidth={2.2}
                  strokeDasharray={c.dashed ? "5 4" : undefined}
                />
                <circle cx={c.x1} cy={y1} r={3.2} fill="var(--color-foreground)" />
                <path d={arrow} fill="var(--color-foreground)" />
              </g>
            );
          })}

          {/* rows: gutter avatar/label, lane baselines, bars, human kickoff chips */}
          {layout.rows.map((row) => {
            const cy = row.y + AXIS_H + row.h / 2;
            return (
              <g key={`row-${row.actor.id}`}>
                <AvatarGlyph cx={26} cy={cy} r={AVATAR_R} label={shortLabel(row.actor.name)} type={row.actor.type} />
                <text x={26 + AVATAR_R + 10} y={cy - 2} fontSize={13} fill="var(--color-foreground)">
                  {truncate(row.actor.name, 18)}
                </text>
                <text x={26 + AVATAR_R + 10} y={cy + 12} fontSize={11} fill="var(--color-muted-foreground)">
                  {row.actor.type}
                </text>

                {Array.from({ length: row.laneCount }).map((_, ln) => {
                  const ly = row.y + AXIS_H + 6 + ln * (GEOM.barH + GEOM.laneGap) + GEOM.barH / 2;
                  return (
                    <line
                      key={`lane-${row.actor.id}-${ln}`}
                      x1={layout.gutter}
                      y1={ly}
                      x2={layout.width - 8}
                      y2={ly}
                      stroke="var(--color-border)"
                      strokeWidth={1}
                      strokeDasharray="2 4"
                      opacity={0.6}
                    />
                  );
                })}

                {row.bars.map((bar) => {
                  const yTop = bar.yTop + AXIS_H;
                  const w = bar.x2 - bar.x1;
                  const hue = issueColor(bar.span.issueId);
                  const connectedState =
                    connectedRunIds == null ? "idle" : connectedRunIds.has(bar.span.runId) ? "connected" : "faded";
                  const barOpacity =
                    connectedState === "idle"
                      ? 0.88
                      : connectedState === "connected"
                        ? 1
                        : 0.22;
                  return (
                    <g key={bar.span.runId} opacity={connectedState === "faded" ? 0.42 : 1}>
                      <g
                        className="cursor-pointer"
                        data-run-id={bar.span.runId}
                        data-connected-state={connectedState}
                        onMouseEnter={(e) => showTooltip(e, bar)}
                        onMouseOver={(e) => showTooltip(e, bar)}
                        onMouseMove={(e) => showTooltip(e, bar)}
                        onMouseLeave={() => {
                          setTooltip(null);
                          setHoveredRunId(null);
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => openIssue(bar.span.issueId)}
                      >
                        <rect
                          x={bar.x1}
                          y={yTop}
                          width={w}
                          height={bar.height}
                          rx={3}
                          fill={barFill(bar)}
                          stroke="var(--color-foreground)"
                          strokeWidth={1.5}
                          opacity={barOpacity}
                        />
                        {/* left colour tab = issue identity (no textual ID on the bar) */}
                        <rect x={bar.x1} y={yTop} width={3.5} height={bar.height} fill={hue} />
                        {/* in-progress fade to "now" */}
                        {bar.running && w > 8 && (
                          <rect x={bar.x2 - Math.min(w - 2, 26)} y={yTop + 1.5} width={Math.min(w - 2, 26)} height={bar.height - 3} fill="url(#tl-fade)" />
                        )}
                      </g>
                      {bar.kickoff && actorType(bar.kickoff) === "user" && (
                        <g className="pointer-events-none" data-testid="timeline-kickoff-chip">
                          <AvatarGlyph
                            cx={bar.x1}
                            cy={yTop + bar.height / 2}
                            r={CHIP_R}
                            label={shortLabel((bar.kickoff as WorkTimelineActor).name)}
                            type={actorType(bar.kickoff)}
                          />
                        </g>
                      )}
                    </g>
                  );
                })}

              </g>
            );
          })}
          {dragSelection && (
            <rect
              data-testid="timeline-drag-selection"
              x={Math.min(dragSelection.anchorX, dragSelection.currentX)}
              y={AXIS_H}
              width={Math.abs(dragSelection.currentX - dragSelection.anchorX)}
              height={layout.height - AXIS_H}
              fill="var(--color-primary)"
              opacity={0.16}
              stroke="var(--color-primary)"
              strokeWidth={1.5}
              pointerEvents="none"
            />
          )}
          </svg>
        </div>
      </div>

      <MiniMap
        layout={layout}
        scrollRef={scrollRef}
        viewportW={viewportW}
        scrollLeft={scrollLeft}
        onVisibleRangeChange={updateVisibleRange}
      />

      {tooltip && <Tooltip tooltip={tooltip} now={now} />}
    </div>
  );
}

function ActorGutter({ rows, height }: { rows: ReturnType<typeof computeLayout>["rows"]; height: number }) {
  return (
    <svg
      aria-hidden="true"
      data-testid="work-timeline-actor-gutter"
      width={GEOM.gutter}
      height={height}
      viewBox={`0 0 ${GEOM.gutter} ${height}`}
      className="sticky left-0 top-0 z-20 block bg-card"
    >
      <rect x={0} y={0} width={GEOM.gutter} height={height} fill="var(--color-card)" />
      {rows.map((row, i) => {
        const cy = row.y + AXIS_H + row.h / 2;
        return (
          <g key={`gutter-${row.actor.id}`}>
            <rect
              x={0}
              y={row.y + AXIS_H}
              width={GEOM.gutter}
              height={row.h}
              fill={i % 2 ? "var(--color-muted)" : "var(--color-card)"}
              opacity={i % 2 ? 0.35 : 1}
            />
            <AvatarGlyph cx={26} cy={cy} r={AVATAR_R} label={shortLabel(row.actor.name)} type={row.actor.type} />
            <text x={26 + AVATAR_R + 10} y={cy - 2} fontSize={13} fill="var(--color-foreground)">
              {truncate(row.actor.name, 18)}
            </text>
            <text x={26 + AVATAR_R + 10} y={cy + 12} fontSize={11} fill="var(--color-muted-foreground)">
              {row.actor.type}
            </text>
          </g>
        );
      })}
      <line x1={GEOM.gutter} y1={0} x2={GEOM.gutter} y2={height} stroke="var(--color-foreground)" strokeWidth={1.5} />
      <line x1={0} y1={AXIS_H} x2={GEOM.gutter} y2={AXIS_H} stroke="var(--color-foreground)" strokeWidth={1.5} />
    </svg>
  );
}

function Tooltip({ tooltip, now }: { tooltip: TooltipState; now: number }) {
  const { bar } = tooltip;
  const startMs = new Date(bar.span.start).getTime();
  const endMs = bar.span.end ? new Date(bar.span.end).getTime() : now;
  const title = bar.span.issueTitle ?? bar.span.issueIdentifier ?? "run";
  const left = Math.min(tooltip.x + 14, (typeof window !== "undefined" ? window.innerWidth : 1200) - 300);
  return (
    <div
      className="pointer-events-none fixed z-50 max-w-[280px] rounded-md border border-foreground bg-card px-2.5 py-2 text-xs shadow-md"
      style={{ left, top: tooltip.y + 14 }}
    >
      <div className="text-[13px] font-medium text-foreground">{truncate(title)}</div>
      <div className="mt-0.5 text-muted-foreground">
        {fmtClock(startMs)}–{bar.span.end ? fmtClock(endMs) : "now"} · {formatDuration(startMs, endMs)} ·{" "}
        <span className="font-medium text-foreground">{bar.span.status}</span>
      </div>
      {bar.kickoff && (
        <div className="text-muted-foreground">
          kicked off by: {(bar.kickoff as WorkTimelineActor).name}
          {bar.span.retryOfRunId ? " · retry" : ""}
        </div>
      )}
      {tooltip.connectorHint && (
        <div className="text-muted-foreground">{tooltip.connectorHint}</div>
      )}
    </div>
  );
}

function MiniMap({
  layout,
  scrollRef,
  viewportW,
  scrollLeft,
  onVisibleRangeChange,
}: {
  layout: ReturnType<typeof computeLayout>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  viewportW: number;
  scrollLeft: number;
  onVisibleRangeChange: (fromMs: number, toMs: number) => void;
}) {
  const W = Math.max(320, viewportW || 900);
  const H = 54;
  const pad = 8;
  const spanMs = layout.toMs - layout.fromMs || 1;
  const mx = (ms: number) => pad + ((ms - layout.fromMs) / spanMs) * (W - 2 * pad);

  // one thin tick per run, stacked by row order
  const rowIndex = new Map(layout.rows.map((r, i) => [r.actor.id, i]));
  const laneH = (H - 2 * pad) / Math.max(1, layout.rows.length);

  const timeAtX = (x: number) => {
    const ms = layout.fromMs + ((x - layout.gutter) / layout.pxPerMinute) * 60000;
    return Math.max(layout.fromMs, Math.min(layout.toMs, ms));
  };
  const visibleStartMs = timeAtX(scrollLeft);
  const visibleEndMs = timeAtX(scrollLeft + (viewportW || W));
  const brushX = mx(visibleStartMs);
  const brushW = Math.max(24, mx(visibleEndMs) - brushX);

  const msAtClientX = (clientX: number, el: SVGSVGElement) => {
    const rect = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - rect.left - pad) / (W - 2 * pad)));
    return layout.fromMs + f * spanMs;
  };

  const seek = (clientX: number, el: SVGSVGElement) => {
    const centerMs = msAtClientX(clientX, el);
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = layout.gutter + ((centerMs - layout.fromMs) / 60000) * layout.pxPerMinute - scrollRef.current.clientWidth / 2;
    }
  };

  const startRangeDrag = (mode: "left" | "right" | "move", event: React.MouseEvent<SVGElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const el = event.currentTarget.ownerSVGElement;
    if (!el) return;
    const startLeftMs = visibleStartMs;
    const startRightMs = visibleEndMs;
    const durationMs = Math.max(MIN_MINIMAP_SELECTION_MS, startRightMs - startLeftMs);

    const move = (ev: MouseEvent) => {
      const hitMs = msAtClientX(ev.clientX, el);
      if (mode === "left") {
        onVisibleRangeChange(Math.min(hitMs, startRightMs - MIN_MINIMAP_SELECTION_MS), startRightMs);
      } else if (mode === "right") {
        onVisibleRangeChange(startLeftMs, Math.max(hitMs, startLeftMs + MIN_MINIMAP_SELECTION_MS));
      } else {
        const nextFrom = Math.max(layout.fromMs, Math.min(layout.toMs - durationMs, hitMs - durationMs / 2));
        onVisibleRangeChange(nextFrom, nextFrom + durationMs);
      }
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  return (
    <div className="mt-2 border-t border-border bg-card px-3.5 py-2">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block cursor-ew-resize"
        onMouseDown={(e) => {
          const el = e.currentTarget;
          seek(e.clientX, el);
          const move = (ev: MouseEvent) => seek(ev.clientX, el);
          const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
          };
          document.addEventListener("mousemove", move);
          document.addEventListener("mouseup", up);
        }}
      >
        <rect x={0} y={0} width={W} height={H} fill="var(--color-card)" stroke="var(--color-foreground)" strokeWidth={1.5} />
        {layout.rows.flatMap((row) =>
          row.bars.map((bar) => {
            const startMs = new Date(bar.span.start).getTime();
            const endMs = bar.span.end ? new Date(bar.span.end).getTime() : layout.toMs;
            const yy = pad + (rowIndex.get(row.actor.id) ?? 0) * laneH;
            return (
              <rect
                key={`mm-${bar.span.runId}`}
                x={mx(startMs)}
                y={yy + 1}
                width={Math.max(2, mx(endMs) - mx(startMs))}
                height={Math.max(2, laneH - 2)}
                fill={issueColor(bar.span.issueId)}
              />
            );
          }),
        )}
        <rect
          x={brushX}
          y={1}
          width={brushW}
          height={H - 2}
          fill="var(--color-foreground)"
          opacity={0.12}
          stroke="var(--color-foreground)"
          strokeWidth={1.5}
          onMouseDown={(e) => startRangeDrag("move", e)}
        />
        <rect
          data-testid="timeline-minimap-left-handle"
          x={brushX - 3}
          y={1}
          width={6}
          height={H - 2}
          fill="var(--color-foreground)"
          opacity={0.55}
          onMouseDown={(e) => startRangeDrag("left", e)}
        />
        <rect
          data-testid="timeline-minimap-right-handle"
          x={brushX + brushW - 3}
          y={1}
          width={6}
          height={H - 2}
          fill="var(--color-foreground)"
          opacity={0.55}
          onMouseDown={(e) => startRangeDrag("right", e)}
        />
      </svg>
    </div>
  );
}
