/**
 * Work Timeline page (PAP-12424 / Phase C of PAP-12405).
 *
 * A Gantt-style view of company actor activity built on the Phase B endpoint
 * (`GET /companies/:companyId/timeline`). Rendering is the board-locked
 * Direction C (PAP-12422): dense rows, mini-map brush, custom inline SVG.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GanttChartSquare } from "lucide-react";
import type { WorkTimelineActor } from "@paperclipai/shared";
import { workTimelineApi, type WorkTimelineParams } from "@/api/workTimeline";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  WorkTimelineChart,
  defaultZoomForWindow,
  nearestZoomForScale,
  zoomScaleForLevel,
  type ZoomLevel,
} from "@/components/timeline/WorkTimelineChart";
import type { ColorMode } from "@/lib/timeline/layout";
import { cn } from "@/lib/utils";

const EVERYONE = "__everyone__";
type RangePreset = "today" | "7d" | "30d";

function rangeWindow(preset: RangePreset, now = new Date()): Pick<WorkTimelineParams, "from" | "to"> {
  const to = new Date(now);
  const from = new Date(now);
  if (preset === "today") {
    from.setHours(0, 0, 0, 0);
  } else {
    from.setDate(from.getDate() - (preset === "7d" ? 7 : 30));
  }
  return { from: from.toISOString(), to: to.toISOString() };
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

export function Timeline() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [zoom, setZoom] = useState<ZoomLevel>("day");
  const [zoomScale, setZoomScale] = useState(zoomScaleForLevel("day"));
  const zoomTouched = useRef(false);
  const setZoomManual = (z: ZoomLevel) => {
    zoomTouched.current = true;
    setZoom(z);
    setZoomScale(zoomScaleForLevel(z));
  };
  const [colorMode, setColorMode] = useState<ColorMode>("issue");
  const [lensUserId, setLensUserId] = useState<string>(EVERYONE);
  const [rangePreset, setRangePreset] = useState<RangePreset>("7d");
  // Union of users discovered across fetches so the lens list stays stable.
  const [knownUsers, setKnownUsers] = useState<WorkTimelineActor[]>([]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Timeline" }]);
  }, [setBreadcrumbs]);

  const params: WorkTimelineParams = useMemo(
    () => ({
      ...rangeWindow(rangePreset),
      ...(lensUserId === EVERYONE ? {} : { userId: lensUserId.replace(/^user:/, "") }),
    }),
    [lensUserId, rangePreset],
  );

  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKeys.workTimeline(selectedCompanyId ?? "", lensUserId), rangePreset],
    queryFn: () => workTimelineApi.get(selectedCompanyId!, params),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    if (!data || zoomTouched.current) return;
    const defaultZoom = defaultZoomForWindow(new Date(data.window.from).getTime(), new Date(data.window.to).getTime());
    setZoom(defaultZoom);
    setZoomScale(zoomScaleForLevel(defaultZoom));
  }, [data]);

  useEffect(() => {
    if (!data) return;
    setKnownUsers((prev) => {
      const byId = new Map(prev.map((u) => [u.id, u]));
      for (const a of data.actors) if (a.type === "user") byId.set(a.id, a);
      return Array.from(byId.values());
    });
  }, [data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={GanttChartSquare} message="Select a company to view its work timeline." />;
  }

  const header = (
    <div className="flex items-center gap-2">
      <GanttChartSquare className="h-6 w-6 text-muted-foreground" />
      <h1 className="text-3xl font-semibold tracking-tight">Work Timeline</h1>
    </div>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Zoom
        <Segmented
          value={zoom}
          onChange={setZoomManual}
          options={[
            { value: "hour", label: "Hour" },
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
          ]}
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Report for
        <Select value={lensUserId} onValueChange={setLensUserId}>
          <SelectTrigger className="h-8 w-[220px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={EVERYONE}>Everyone (company)</SelectItem>
            {knownUsers.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name} — work kicked off
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Range
        <Segmented
          value={rangePreset}
          onChange={setRangePreset}
          options={[
            { value: "today", label: "Today" },
            { value: "7d", label: "7 days" },
            { value: "30d", label: "30 days" },
          ]}
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Color
        <Segmented
          value={colorMode}
          onChange={setColorMode}
          options={[
            { value: "issue", label: "By task" },
            { value: "status", label: "By status" },
          ]}
        />
      </label>
    </div>
  );

  return (
    <div className="space-y-6">
      {header}
      {toolbar}

      {isLoading && <PageSkeleton />}

      {error && (
        <EmptyState
          icon={GanttChartSquare}
          message="Couldn't load the timeline. The aggregation endpoint may be unavailable."
        />
      )}

      {data && !isLoading && (
        data.spans.length === 0 ? (
          <EmptyState icon={GanttChartSquare} message="No activity in this window for the selected lens." />
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-card">
              <WorkTimelineChart
                data={data}
                zoom={zoom}
                zoomScale={zoomScale}
                colorMode={colorMode}
                onZoomScaleChange={(nextScale) => {
                  zoomTouched.current = true;
                  setZoomScale(nextScale);
                  setZoom(nearestZoomForScale(nextScale));
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
