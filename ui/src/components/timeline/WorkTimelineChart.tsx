/**
 * Work Timeline — custom-SVG Gantt (board-locked Direction C, PAP-12422).
 *
 * Renders actor rows with concurrency sub-lanes, run bars (no issue IDs on the
 * bar — identity is the thin left colour tab; truncated title shows on hover),
 * kickoff avatar chips at each bar's leading edge (incl. humans), straight
 * agent→agent delegation connectors (dashed for retries), an in-progress fade to
 * "now", a hover tooltip, and a full-window mini-map with a draggable brush.
 */
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "@/lib/router";
import type {
  TimelineEventKind,
  WorkTimelineActor,
  WorkTimelineResult,
} from "@paperclipai/shared";
import {
  AXIS_H,
  actorType,
  chooseTickStepMs,
  computeLayout,
  formatDuration,
  issueColor,
  shortLabel,
  type ColorMode,
  type LayoutOptions,
  type PositionedBar,
  type PositionedMarker,
} from "@/lib/timeline/layout";

export type ZoomLevel = "hour" | "day" | "week";

const ZOOM_PX_PER_MIN: Record<ZoomLevel, number> = {
  hour: 8,
  day: 1.6,
  week: 0.32,
};

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
const MARKER_R = 5.5;

/**
 * Per-kind styling for instant event markers (diamonds). Each kind gets a
 * distinct fill + verb so created / commented / approved / delegated / assigned
 * read apart at a glance; the hues sit mid-lightness so they hold on light+dark.
 */
const EVENT_STYLE: Record<TimelineEventKind, { fill: string; verb: string }> = {
  created: { fill: "hsl(145 55% 42%)", verb: "created" },
  commented: { fill: "hsl(212 62% 54%)", verb: "commented on" },
  approved: { fill: "hsl(265 52% 60%)", verb: "approved" },
  delegated: { fill: "hsl(28 78% 52%)", verb: "delegated" },
  assigned: { fill: "hsl(190 58% 44%)", verb: "assigned" },
};

interface TooltipState {
  x: number;
  y: number;
  bar: PositionedBar;
}

interface MarkerTooltipState {
  x: number;
  y: number;
  marker: PositionedMarker;
  /** resolved issue label (identifier/title) or the raw id as a fallback. */
  issueLabel: string;
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtTick(ms: number, stepMs: number): string {
  const d = new Date(ms);
  if (stepMs >= 24 * 60 * 60 * 1000) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return fmtClock(ms);
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
  colorMode: ColorMode;
  /** override "now" (tests / stories); defaults to Date.now(). */
  nowMs?: number;
}

export function WorkTimelineChart({ data, zoom, colorMode, nowMs }: WorkTimelineChartProps) {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [markerTooltip, setMarkerTooltip] = useState<MarkerTooltipState | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportW, setViewportW] = useState(0);

  const now = nowMs ?? Date.now();
  const layout = useMemo(
    () => computeLayout(data, { ...GEOM, pxPerMinute: ZOOM_PX_PER_MIN[zoom], nowMs: now }),
    [data, zoom, now],
  );

  // Resolve an event's issue to its human label (identifier/title) via the legend
  // hue map, falling back to the raw id for issues that have no run in-window.
  const issueLabelById = useMemo(
    () => new Map(layout.issues.map((i) => [i.key, i.label])),
    [layout.issues],
  );

  const stepMs = chooseTickStepMs(layout.pxPerMinute);
  const ticks: number[] = [];
  const startTick = Math.ceil(layout.fromMs / stepMs) * stepMs;
  for (let ms = startTick; ms <= layout.toMs; ms += stepMs) ticks.push(ms);

  const barFill = (bar: PositionedBar): string => {
    if (colorMode === "status") {
      if (bar.running) return "url(#tl-hatchV)";
      if (bar.span.status.includes("change") || bar.span.status.includes("fail") || bar.span.status === "blocked")
        return "url(#tl-hatchD)";
      return "var(--color-card)";
    }
    return "var(--color-card)";
  };

  const openIssue = (issueId: string) => navigate(`/issues/${issueId}`);

  const showTooltip = (evt: React.MouseEvent, bar: PositionedBar) => {
    setTooltip({ x: evt.clientX, y: evt.clientY, bar });
  };

  const showMarkerTooltip = (evt: React.MouseEvent, marker: PositionedMarker) => {
    const issueLabel = issueLabelById.get(marker.event.issueId) ?? marker.event.issueId;
    setMarkerTooltip({ x: evt.clientX, y: evt.clientY, marker, issueLabel });
  };

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        className="overflow-x-auto overflow-y-hidden"
        data-testid="work-timeline-scroll"
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      >
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <ActorGutter rows={layout.rows} height={layout.height} />

          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="absolute inset-0 block select-none"
            ref={(el) => {
              if (el && viewportW === 0 && scrollRef.current) setViewportW(scrollRef.current.clientWidth);
            }}
          >
          <defs>
            <pattern id="tl-hatchV" width={5} height={6} patternUnits="userSpaceOnUse">
              <rect width={5} height={6} fill="var(--color-card)" />
              <line x1={0} y1={0} x2={0} y2={6} stroke="var(--color-foreground)" strokeWidth={2} />
            </pattern>
            <pattern id="tl-hatchD" width={6} height={6} patternUnits="userSpaceOnUse">
              <rect width={6} height={6} fill="var(--color-card)" />
              <path d="M0,6 l6,-6" stroke="var(--color-foreground)" strokeWidth={1.5} />
            </pattern>
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
                <text x={gx + 3} y={14} fontSize={11} fill="var(--color-muted-foreground)">
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

          {/* connectors (behind bars) */}
          {layout.connectors.map((c, i) => {
            const ang = (Math.atan2(c.y2 - c.y1, c.x2 - c.x1) * 180) / Math.PI;
            return (
              <g key={`edge-${i}`} opacity={0.55}>
                <line
                  x1={c.x1}
                  y1={c.y1 + AXIS_H}
                  x2={c.x2}
                  y2={c.y2 + AXIS_H}
                  stroke="var(--color-foreground)"
                  strokeWidth={1.6}
                  strokeDasharray={c.dashed ? "5 4" : undefined}
                />
                <circle cx={c.x1} cy={c.y1 + AXIS_H} r={2.2} fill="var(--color-foreground)" />
                <path
                  d={`M${c.x2},${c.y2 + AXIS_H} l-8,-4 l0,8 z`}
                  fill="var(--color-foreground)"
                  transform={`rotate(${ang} ${c.x2} ${c.y2 + AXIS_H})`}
                />
              </g>
            );
          })}

          {/* rows: gutter avatar/label, lane baselines, bars, chips */}
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
                  return (
                    <g key={bar.span.runId}>
                      <g
                        className="cursor-pointer"
                        onMouseMove={(e) => showTooltip(e, bar)}
                        onMouseLeave={() => setTooltip(null)}
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
                        />
                        {/* left colour tab = issue identity (no textual ID on the bar) */}
                        <rect x={bar.x1} y={yTop} width={3.5} height={bar.height} fill={hue} />
                        {/* in-progress fade to "now" */}
                        {bar.running && w > 8 && (
                          <rect x={bar.x2 - Math.min(w - 2, 26)} y={yTop + 1.5} width={Math.min(w - 2, 26)} height={bar.height - 3} fill="url(#tl-fade)" />
                        )}
                      </g>
                      {bar.kickoff && (
                        <g className="pointer-events-none">
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

                {/* instant event markers — diamonds at x(event.at) on this row */}
                {row.markers.map((marker) => {
                  const style = EVENT_STYLE[marker.event.kind];
                  const mx = marker.x;
                  const my = marker.yc + AXIS_H;
                  return (
                    <path
                      key={`ev-${row.actor.id}-${marker.event.kind}-${marker.event.issueId}-${marker.event.at}`}
                      className="cursor-pointer"
                      d={`M ${mx} ${my - MARKER_R} L ${mx + MARKER_R} ${my} L ${mx} ${my + MARKER_R} L ${mx - MARKER_R} ${my} Z`}
                      fill={style?.fill ?? "var(--color-primary)"}
                      stroke="var(--color-foreground)"
                      strokeWidth={1.2}
                      onMouseMove={(e) => showMarkerTooltip(e, marker)}
                      onMouseLeave={() => setMarkerTooltip(null)}
                    />
                  );
                })}
              </g>
            );
          })}
          </svg>
        </div>
      </div>

      <MiniMap layout={layout} scrollRef={scrollRef} viewportW={viewportW} scrollLeft={scrollLeft} />

      {tooltip && <Tooltip tooltip={tooltip} now={now} />}
      {markerTooltip && <MarkerTooltip tooltip={markerTooltip} />}
    </div>
  );
}

function MarkerTooltip({ tooltip }: { tooltip: MarkerTooltipState }) {
  const { marker, issueLabel } = tooltip;
  const style = EVENT_STYLE[marker.event.kind];
  const atMs = new Date(marker.event.at).getTime();
  const left = Math.min(tooltip.x + 14, (typeof window !== "undefined" ? window.innerWidth : 1200) - 300);
  return (
    <div
      className="pointer-events-none fixed z-50 max-w-[280px] rounded-md border border-foreground bg-card px-2.5 py-2 text-xs shadow-md"
      style={{ left, top: tooltip.y + 14 }}
    >
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        <span
          className="inline-block h-2.5 w-2.5 rotate-45 border border-foreground"
          style={{ backgroundColor: style?.fill ?? "var(--color-primary)" }}
        />
        <span className="capitalize">{style?.verb ?? marker.event.kind}</span>
        <span className="font-normal text-muted-foreground">{truncate(issueLabel, 28)}</span>
      </div>
      <div className="mt-0.5 text-muted-foreground">{fmtClock(atMs)}</div>
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
      <div className="mt-1 text-foreground">click → open task</div>
    </div>
  );
}

function MiniMap({
  layout,
  scrollRef,
  viewportW,
  scrollLeft,
}: {
  layout: ReturnType<typeof computeLayout>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  viewportW: number;
  scrollLeft: number;
}) {
  const W = Math.max(320, viewportW || 900);
  const H = 54;
  const pad = 8;
  const spanMs = layout.toMs - layout.fromMs || 1;
  const mx = (ms: number) => pad + ((ms - layout.fromMs) / spanMs) * (W - 2 * pad);

  // one thin tick per run, stacked by row order
  const rowIndex = new Map(layout.rows.map((r, i) => [r.actor.id, i]));
  const laneH = (H - 2 * pad) / Math.max(1, layout.rows.length);

  const frac = layout.width > 0 ? (viewportW || W) / layout.width : 1;
  const brushW = Math.max(24, Math.min(1, frac) * (W - 2 * pad));
  const brushX = pad + (layout.width > 0 ? scrollLeft / layout.width : 0) * (W - 2 * pad);

  const seek = (clientX: number, el: SVGSVGElement) => {
    const rect = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - rect.left - pad) / (W - 2 * pad)));
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = f * layout.width - scrollRef.current.clientWidth / 2;
    }
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
        />
      </svg>
    </div>
  );
}
