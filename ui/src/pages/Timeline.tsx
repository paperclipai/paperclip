/**
 * Work Timeline page (PAP-12424 / Phase C of PAP-12405).
 *
 * A Gantt-style view of company actor activity built on the Phase B endpoint
 * (`GET /companies/:companyId/timeline`). Rendering is the board-locked
 * Direction C (PAP-12422): dense rows, mini-map brush, custom inline SVG.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GanttChartSquare, Minus, Plus, RotateCcw } from "lucide-react";
import { workTimelineApi, type WorkTimelineParams } from "@/api/workTimeline";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { RequestCollapsedSidebar } from "@/components/RequestCollapsedSidebar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  WorkTimelineChart,
  clampZoomScale,
  defaultZoomForWindow,
  nearestZoomForScale,
  type ZoomLevel,
  zoomScaleForLevel,
} from "@/components/timeline/WorkTimelineChart";
import { TIMELINE_COLORS } from "@/lib/timeline/layout";
import { cn } from "@/lib/utils";

type RangePreset = "today" | "7d" | "30d" | "custom";
interface DateRangeState {
  fromDate: string;
  toDate: string;
}

function dateInputValue(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function presetRange(preset: Exclude<RangePreset, "custom">, now = new Date()): DateRangeState {
  const from = new Date(now);
  const to = new Date(now);
  if (preset === "today") {
    return { fromDate: dateInputValue(from), toDate: dateInputValue(to) };
  } else {
    from.setDate(from.getDate() - (preset === "7d" ? 6 : 29));
  }
  return { fromDate: dateInputValue(from), toDate: dateInputValue(to) };
}

function rangeWindow(range: DateRangeState): Pick<WorkTimelineParams, "from" | "to"> | null {
  if (!range.fromDate || !range.toDate) return null;
  const from = new Date(`${range.fromDate}T00:00:00`);
  const to = new Date(`${range.toDate}T23:59:59.999`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return null;
  return { from: from.toISOString(), to: to.toISOString() };
}

function rangeError(range: DateRangeState): string | null {
  if (!range.fromDate || !range.toDate) return "Choose a start and end date.";
  if (!rangeWindow(range)) return "Start date must be before end date.";
  return null;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={cn(
            "px-3 py-1.5 text-xs transition-colors",
            i > 0 && "border-l border-border",
            value === opt.value
              ? "bg-primary text-primary-foreground"
              : "bg-card text-foreground hover:bg-muted",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Encoding key for the "Signal" timeline: colour = how each run started. */
function TimelineLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3.5 py-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-4 rounded-sm" style={{ backgroundColor: TIMELINE_COLORS.delegated }} />
        Delegated
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-4 rounded-sm" style={{ backgroundColor: TIMELINE_COLORS.automation }} />
        Automation
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="h-2.5 w-4 rounded-sm border border-dashed bg-transparent"
          style={{ borderColor: TIMELINE_COLORS.cancelled }}
        />
        Cancelled
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-3.5 w-0.5" style={{ backgroundColor: TIMELINE_COLORS.now }} />
        Now
      </span>
    </div>
  );
}

export function Timeline() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [zoom, setZoom] = useState<ZoomLevel>("day");
  const [zoomScale, setZoomScale] = useState<number | undefined>(undefined);
  const zoomTouched = useRef(false);
  const [rangePreset, setRangePreset] = useState<RangePreset>("7d");
  const [dateRange, setDateRange] = useState<DateRangeState>(() => presetRange("7d"));

  useEffect(() => {
    setBreadcrumbs([{ label: "Timeline" }]);
  }, [setBreadcrumbs]);

  const dateRangeError = rangeError(dateRange);
  const params: WorkTimelineParams | null = useMemo(() => {
    const window = rangeWindow(dateRange);
    if (!window) return null;
    return window;
  }, [dateRange]);

  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKeys.workTimeline(selectedCompanyId ?? ""), dateRange.fromDate, dateRange.toDate],
    queryFn: () => workTimelineApi.get(selectedCompanyId!, params!),
    enabled: !!selectedCompanyId && !!params,
  });

  useEffect(() => {
    if (!data || zoomTouched.current) return;
    const defaultZoom = defaultZoomForWindow(new Date(data.window.from).getTime(), new Date(data.window.to).getTime());
    setZoom(defaultZoom);
    setZoomScale(undefined);
  }, [data]);

  if (!selectedCompanyId) {
    return (
      <>
        <RequestCollapsedSidebar />
        <EmptyState icon={GanttChartSquare} message="Select a company to view its work timeline." />
      </>
    );
  }

  const header = (
    <div className="flex items-center gap-2">
      <GanttChartSquare className="h-6 w-6 text-muted-foreground" />
      <h1 className="text-3xl font-semibold tracking-tight">Work Timeline</h1>
    </div>
  );

  const adjustZoom = (factor: number) => {
    zoomTouched.current = true;
    const nextScale = clampZoomScale((zoomScale ?? zoomScaleForLevel(zoom)) * factor);
    setZoomScale(nextScale);
    setZoom(nearestZoomForScale(nextScale));
  };

  const resetZoom = () => {
    zoomTouched.current = true;
    if (data) {
      setZoom(defaultZoomForWindow(new Date(data.window.from).getTime(), new Date(data.window.to).getTime()));
    } else {
      setZoom("day");
    }
    setZoomScale(undefined);
  };

  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <label className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        Range
        <Segmented
          value={rangePreset}
          onChange={(preset) => {
            if (preset === "custom") return;
            setRangePreset(preset);
            setDateRange(presetRange(preset));
          }}
          options={[
            { value: "today", label: "Today" },
            { value: "7d", label: "7 days" },
            { value: "30d", label: "30 days" },
          ]}
        />
        <Input
          type="date"
          value={dateRange.fromDate}
          onChange={(event) => {
            setRangePreset("custom");
            setDateRange((prev) => ({ ...prev, fromDate: event.target.value }));
          }}
          className="h-8 w-[150px] text-xs"
          aria-label="Timeline start date"
        />
        <span>to</span>
        <Input
          type="date"
          value={dateRange.toDate}
          onChange={(event) => {
            setRangePreset("custom");
            setDateRange((prev) => ({ ...prev, toDate: event.target.value }));
          }}
          className="h-8 w-[150px] text-xs"
          aria-label="Timeline end date"
        />
      </label>
      <div className="ml-auto flex items-center gap-1" aria-label="Timeline zoom controls">
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={() => adjustZoom(0.8)}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Minus className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={() => adjustZoom(1.25)}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <Plus className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={resetZoom}
          aria-label="Reset zoom"
          title="Reset zoom"
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <RequestCollapsedSidebar />
      {header}
      {toolbar}

      {isLoading && <PageSkeleton />}

      {dateRangeError && (
        <EmptyState
          icon={GanttChartSquare}
          message={dateRangeError}
        />
      )}

      {error && (
        <EmptyState
          icon={GanttChartSquare}
          message="Couldn't load the timeline. The aggregation endpoint may be unavailable."
        />
      )}

      {data && !isLoading && !dateRangeError && (
        data.spans.length === 0 ? (
          <EmptyState icon={GanttChartSquare} message="No activity in this window." />
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-card">
              <TimelineLegend />
              <WorkTimelineChart
                data={data}
                zoom={zoom}
                zoomScale={zoomScale}
                onZoomScaleChange={(nextScale, nextZoom = nearestZoomForScale(nextScale)) => {
                  zoomTouched.current = true;
                  setZoomScale(nextScale);
                  setZoom(nextZoom);
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {data.spans.length} run{data.spans.length === 1 ? "" : "s"} ·{" "}
              {new Date(data.window.from).toLocaleString()} → {new Date(data.window.to).toLocaleString()}
              {data.window.capped ? " · window capped" : ""}
            </p>
          </div>
        )
      )}
    </div>
  );
}
