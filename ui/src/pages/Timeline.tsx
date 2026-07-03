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
import type { WorkTimelineActor, WorkTimelineResult } from "@paperclipai/shared";
import { workTimelineApi, type WorkTimelineParams } from "@/api/workTimeline";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkTimelineChart, defaultZoomForWindow, type ZoomLevel } from "@/components/timeline/WorkTimelineChart";
import { issueColor, type ColorMode } from "@/lib/timeline/layout";
import { cn } from "@/lib/utils";

const EVERYONE = "__everyone__";

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
  const zoomTouched = useRef(false);
  const setZoomManual = (z: ZoomLevel) => {
    zoomTouched.current = true;
    setZoom(z);
  };
  const [colorMode, setColorMode] = useState<ColorMode>("issue");
  const [lensUserId, setLensUserId] = useState<string>(EVERYONE);
  // Union of users discovered across fetches so the lens list stays stable.
  const [knownUsers, setKnownUsers] = useState<WorkTimelineActor[]>([]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Timeline" }]);
  }, [setBreadcrumbs]);

  const params: WorkTimelineParams = useMemo(
    () => (lensUserId === EVERYONE ? {} : { userId: lensUserId.replace(/^user:/, "") }),
    [lensUserId],
  );

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.workTimeline(selectedCompanyId ?? "", lensUserId),
    queryFn: () => workTimelineApi.get(selectedCompanyId!, params),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    if (!data || zoomTouched.current) return;
    setZoom(defaultZoomForWindow(new Date(data.window.from).getTime(), new Date(data.window.to).getTime()));
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
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <GanttChartSquare className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-3xl font-semibold tracking-tight">Work Timeline</h1>
      </div>
      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
        A Gantt view of who did what, when. Rows are actors; bars are heartbeat runs colored by task;
        the avatar chip at a bar's leading edge is who kicked it off; straight lines are agent→agent
        delegation. Hover a bar for its task &amp; timing; click to open the task.
      </p>
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
            <Legend data={data} colorMode={colorMode} />
            <div className="rounded-lg border border-border bg-card">
              <WorkTimelineChart data={data} zoom={zoom} colorMode={colorMode} />
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

function Legend({ data, colorMode }: { data: WorkTimelineResult; colorMode: ColorMode }) {
  if (colorMode === "status") {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-4 border border-foreground bg-card" /> done
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-4 border border-foreground"
            style={{ background: "repeating-linear-gradient(90deg, var(--color-foreground) 0 2px, transparent 2px 5px)" }}
          />{" "}
          in&nbsp;progress
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-4 border border-foreground"
            style={{ background: "repeating-linear-gradient(45deg, var(--color-foreground) 0 2px, transparent 2px 6px)" }}
          />{" "}
          changes/blocked
        </span>
      </div>
    );
  }
  const issues = Array.from(
    new Map(data.spans.map((s) => [s.issueId, s.issueIdentifier ?? s.issueTitle ?? "task"])).entries(),
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {issues.slice(0, 12).map(([id, label]) => (
        <span key={id} className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-4 border border-foreground" style={{ borderLeft: `4px solid ${issueColor(id)}` }} />
          {label}
        </span>
      ))}
      {issues.length > 12 && <span>+{issues.length - 12} more</span>}
    </div>
  );
}
