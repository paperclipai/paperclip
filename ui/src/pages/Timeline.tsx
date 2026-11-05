import { useTranslation, t, i18n } from "@/i18n";
/**
 * Work Timeline page (PAP-12424 / Phase C of PAP-12405).
 *
 * A Gantt-style view of company actor activity built on the Phase B endpoint
 * (`GET /companies/:companyId/timeline`). Rendering is the board-locked
 * Direction C (PAP-12422): dense rows, mini-map brush, custom inline SVG.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Clock3, Coins, GanttChartSquare, Minus, Plus, RotateCcw, type LucideIcon } from "lucide-react";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { workTimelineApi, type WorkTimelineParams } from "@/api/workTimeline";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { RequestCollapsedSidebar } from "@/components/RequestCollapsedSidebar";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  WorkTimelineChart,
  clampZoomScale,
  defaultZoomForWindow,
  nearestZoomForScale,
  type VisibleTimelineWindow,
  type ZoomLevel,
  zoomScaleForLevel,
} from "@/components/timeline/WorkTimelineChart";
import { formatDuration, TIMELINE_COLORS } from "@/lib/timeline/layout";
import { cn } from "@/lib/utils";
import { useLocation } from "@/lib/router";
import { useStreamlinedUiEnabled } from "@/hooks/useStreamlinedUiEnabled";

type RangePreset = "today" | "7d" | "30d" | "custom";
const TIMELINE_PAGE_LIMIT = 500;

interface DateRangeState {
  fromDate: string;
  toDate: string;
}

function timelineEventKey(event: WorkTimelineResult["events"][number]) {
  return `${event.actorId}\0${event.kind}\0${event.issueId}\0${event.at}`;
}

function timelineEdgeKey(edge: WorkTimelineResult["edges"][number]) {
  return `${edge.fromActorId}\0${edge.toActorId}\0${edge.issueId}\0${edge.at}\0${edge.kind}`;
}

export async function loadTimelineWindow(
  companyId: string,
  params: WorkTimelineParams,
  signal?: AbortSignal,
): Promise<WorkTimelineResult> {
  const actors = new Map<string, WorkTimelineResult["actors"][number]>();
  const spans = new Map<string, WorkTimelineResult["spans"][number]>();
  const events = new Map<string, WorkTimelineResult["events"][number]>();
  const edges = new Map<string, WorkTimelineResult["edges"][number]>();
  let offset = 0;
  let firstPage: WorkTimelineResult | null = null;
  let totalIssues = 0;
  let capped = false;

  while (true) {
    const page = await workTimelineApi.get(companyId, {
      ...params,
      limit: TIMELINE_PAGE_LIMIT,
      offset,
    }, { signal });
    firstPage ??= page;
    totalIssues = Math.max(totalIssues, page.pagination.totalIssues);
    capped ||= page.window.capped;

    for (const actor of page.actors) actors.set(actor.id, actor);
    for (const span of page.spans) spans.set(span.runId, span);
    for (const event of page.events) events.set(timelineEventKey(event), event);
    for (const edge of page.edges) edges.set(timelineEdgeKey(edge), edge);

    if (!page.pagination.hasMore) break;
    const nextOffset = page.pagination.offset + page.pagination.limit;
    if (nextOffset <= offset) throw new Error(t("work:copy.timelinePaginationDidNotAdvance_b10b95"));
    offset = nextOffset;
  }

  if (!firstPage) throw new Error(t("work:copy.timelineResponseWasEmpty_224138"));
  return {
    actors: Array.from(actors.values()),
    spans: Array.from(spans.values()),
    events: Array.from(events.values()),
    edges: Array.from(edges.values()),
    pagination: {
      limit: TIMELINE_PAGE_LIMIT,
      offset: 0,
      totalIssues,
      hasMore: false,
    },
    window: {
      ...firstPage.window,
      capped,
    },
  };
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
  if (!range.fromDate || !range.toDate) return t("work:copy.chooseAStartAndEndDate_f288de");
  if (!rangeWindow(range)) return t("work:copy.startDateMustBeBeforeEndDate_cf85d5");
  return null;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat(i18n.resolvedLanguage).format(value);
}

function formatCompactInteger(value: number): string {
  return new Intl.NumberFormat(i18n.resolvedLanguage, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function spanStartMs(span: WorkTimelineResult["spans"][number]) {
  return new Date(span.start).getTime();
}

function spanEndMs(span: WorkTimelineResult["spans"][number], fallbackEndMs: number) {
  return span.end ? new Date(span.end).getTime() : fallbackEndMs;
}

function spanWindowOverlap(
  span: WorkTimelineResult["spans"][number],
  rawFallbackEndMs: number,
  windowFromMs: number,
  windowToMs: number,
) {
  const rawStartMs = spanStartMs(span);
  const rawEndMs = spanEndMs(span, rawFallbackEndMs);
  const startMs = Math.max(rawStartMs, windowFromMs);
  const endMs = Math.min(rawEndMs, windowToMs);
  return {
    clippedMs: Math.max(0, endMs - startMs),
    rawMs: Math.max(0, rawEndMs - rawStartMs),
  };
}

function spanWindowTokens(span: WorkTimelineResult["spans"][number], rawMs: number, clippedMs: number) {
  const totalTokens = span.usage?.totalTokens ?? 0;
  if (totalTokens <= 0 || clippedMs <= 0) return 0;
  if (rawMs <= 0 || clippedMs >= rawMs) return totalTokens;
  return Math.round(totalTokens * (clippedMs / rawMs));
}

function dataWindow(data: WorkTimelineResult): VisibleTimelineWindow {
  return {
    fromMs: new Date(data.window.from).getTime(),
    toMs: new Date(data.window.to).getTime(),
  };
}

export function timelineSummary(data: WorkTimelineResult, visibleWindow: VisibleTimelineWindow = dataWindow(data)) {
  const actorById = new Map(data.actors.map((actor) => [actor.id, actor]));
  const activeAgentIds = new Set<string>();
  const fullWindow = dataWindow(data);
  const windowFromMs = Math.max(fullWindow.fromMs, Math.min(fullWindow.toMs, visibleWindow.fromMs));
  const windowToMs = Math.max(windowFromMs, Math.min(fullWindow.toMs, visibleWindow.toMs));
  let activeMs = 0;
  let totalTokens = 0;
  let runs = 0;

  for (const span of data.spans) {
    const overlap = spanWindowOverlap(span, fullWindow.toMs, windowFromMs, windowToMs);
    if (overlap.clippedMs <= 0) continue;
    runs += 1;
    if (actorById.get(span.actorId)?.type === "agent") activeAgentIds.add(span.actorId);
    activeMs += overlap.clippedMs;
    totalTokens += spanWindowTokens(span, overlap.rawMs, overlap.clippedMs);
  }

  return {
    runs,
    agents: activeAgentIds.size,
    activeMs,
    totalTokens,
  };
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
  const { t } = useTranslation("work");
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
  const { t } = useTranslation("work");
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3.5 py-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-4 rounded-sm" style={{ backgroundColor: TIMELINE_COLORS.delegated }} />{t("work:copy.delegated_dd341e")}</span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-4 rounded-sm" style={{ backgroundColor: TIMELINE_COLORS.automation }} />{t("work:copy.automation_d90975")}</span>
      <span className="flex items-center gap-1.5">
        <span
          className="h-2.5 w-4 rounded-sm border border-dashed bg-transparent"
          style={{ borderColor: TIMELINE_COLORS.cancelled }}
        />{t("work:copy.cancelled_d353a9")}</span>
      <span className="flex items-center gap-1.5">
        <span className="h-3.5 w-0.5" style={{ backgroundColor: TIMELINE_COLORS.now }} />{t("work:copy.now_fe1801")}</span>
    </div>
  );
}

function TimelineSummaryStats({
  summary,
}: {
  summary: ReturnType<typeof timelineSummary>;
}) {
  const { t } = useTranslation("work");
  const stats: { label: string; value: string; icon: LucideIcon }[] = [
    { label: t("work:copy.runs_848f54"), value: formatInteger(summary.runs), icon: GanttChartSquare },
    { label: t("work:copy.agents_279b44"), value: formatInteger(summary.agents), icon: Bot },
    { label: t("work:copy.runTime_40349a"), value: formatDuration(0, summary.activeMs), icon: Clock3 },
    {
      label: t("work:copy.tokensUsed_d2252f"),
      value: summary.totalTokens > 0 ? formatCompactInteger(summary.totalTokens) : t("work:copy.notTracked_4367a6"),
      icon: Coins,
    },
  ];

  return (
    <dl className="grid flex-1 grid-cols-2 gap-3 border-y border-border py-3 md:grid-cols-4">
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <div key={stat.label} className="min-w-0">
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span>{stat.label}</span>
            </dt>
            <dd className="mt-1 truncate text-lg font-semibold tabular-nums text-foreground">{stat.value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Timeline({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation("work");
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const scopedProjectId = useMemo(
    () => streamlinedUiEnabled ? new URLSearchParams(location.search).get("projectId") || undefined : undefined,
    [location.search, streamlinedUiEnabled, t],
  );
  const [zoom, setZoom] = useState<ZoomLevel>("day");
  const [zoomScale, setZoomScale] = useState<number | undefined>(undefined);
  const zoomTouched = useRef(false);
  const [rangePreset, setRangePreset] = useState<RangePreset>("7d");
  const [dateRange, setDateRange] = useState<DateRangeState>(() => presetRange("7d"));
  const [visibleWindow, setVisibleWindow] = useState<VisibleTimelineWindow | null>(null);

  useEffect(() => {
    if (!embedded) {
      setBreadcrumbs([{ label: scopedProjectId ? t("work:copy.projectTimeline_da2fd0") : t("work:copy.timeline_9dcff9") }]);
    }
  }, [embedded, scopedProjectId, setBreadcrumbs, t]);

  const dateRangeError = rangeError(dateRange);
  const params: WorkTimelineParams | null = useMemo(() => {
    const window = rangeWindow(dateRange);
    if (!window) return null;
    return scopedProjectId ? { ...window, projectId: scopedProjectId } : window;
  }, [dateRange, scopedProjectId, t]);

  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKeys.workTimeline(selectedCompanyId ?? ""), dateRange.fromDate, dateRange.toDate, scopedProjectId ?? null],
    queryFn: ({ signal }) => loadTimelineWindow(selectedCompanyId!, params!, signal),
    enabled: !!selectedCompanyId && !!params,
  });

  useEffect(() => {
    if (!data || zoomTouched.current) return;
    const defaultZoom = defaultZoomForWindow(new Date(data.window.from).getTime(), new Date(data.window.to).getTime());
    setZoom(defaultZoom);
    setZoomScale(undefined);
  }, [data]);

  useEffect(() => {
    setVisibleWindow(null);
  }, [data?.window.from, data?.window.to]);

  const handleVisibleWindowChange = useCallback((nextWindow: VisibleTimelineWindow) => {
    setVisibleWindow((current) => (
      current?.fromMs === nextWindow.fromMs && current.toMs === nextWindow.toMs
        ? current
        : nextWindow
    ));
  }, [t]);

  if (!selectedCompanyId) {
    return (
      <>
        {!embedded && <RequestCollapsedSidebar />}
        <EmptyState icon={GanttChartSquare} message={t("work:copy.selectAnOrganizationToViewItsWorkTimeline_fc69c7")} />
      </>
    );
  }

  const header = (
    <div className="flex items-center gap-2">
      <GanttChartSquare className="h-6 w-6 text-muted-foreground" />
      <h1 className="text-3xl font-semibold tracking-tight">
        {scopedProjectId ? t("work:copy.projectTimeline_da2fd0") : t("work:copy.workTimeline_38973f")}
      </h1>
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

  const summary = data ? timelineSummary(data, visibleWindow ?? dataWindow(data)) : null;

  const rangeControls = (
    <label className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">{t("work:copy.range_5de74a")}<Segmented
        value={rangePreset}
        onChange={(preset) => {
          if (preset === "custom") return;
          setRangePreset(preset);
          setDateRange(presetRange(preset));
        }}
        options={[
          { value: "today", label: t("work:copy.today_2b065c") },
          { value: "7d", label: t("work:extra.message_7f920bb639") },
          { value: "30d", label: t("work:extra.message_ffd7280513") },
        ]}
      />
      <Input
        type="date"
        value={dateRange.fromDate}
        onChange={(event) => {
          setRangePreset("custom");
          setDateRange((prev) => ({ ...prev, fromDate: event.target.value }));
        }}
        className="h-8 w-(--sz-150px) text-xs"
        aria-label={t("work:copy.timelineStartDate_881e64")}
      />
      <span>{t("work:copy.to_663ea1")}</span>
      <Input
        type="date"
        value={dateRange.toDate}
        onChange={(event) => {
          setRangePreset("custom");
          setDateRange((prev) => ({ ...prev, toDate: event.target.value }));
        }}
        className="h-8 w-(--sz-150px) text-xs"
        aria-label={t("work:copy.timelineEndDate_0f6126")}
      />
    </label>
  );

  const toolbar = (
    <div className="flex flex-wrap items-start gap-3">
      {summary && <TimelineSummaryStats summary={summary} />}
      <div className="ml-auto flex items-center gap-1 pt-3" aria-label={t("work:copy.timelineZoomControls_4c7cc9")}>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={() => adjustZoom(0.8)}
          aria-label={t("work:copy.zoomOut_bc7b63")}
          title={t("work:copy.zoomOut_bc7b63")}
        >
          <Minus className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={() => adjustZoom(1.25)}
          aria-label={t("work:copy.zoomIn_0e47f0")}
          title={t("work:copy.zoomIn_0e47f0")}
        >
          <Plus className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={resetZoom}
          aria-label={t("work:copy.resetZoom_91a661")}
          title={t("work:copy.resetZoom_91a661")}
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {!embedded && <RequestCollapsedSidebar />}
      {header}
      {toolbar}

      {isLoading && <PageSkeleton />}

      {dateRangeError && (
        <div className="space-y-3">
          <EmptyState
            icon={GanttChartSquare}
            message={dateRangeError}
          />
          <div className="flex flex-wrap items-center justify-end gap-3">
            {rangeControls}
          </div>
        </div>
      )}

      {error && (
        <EmptyState
          icon={GanttChartSquare}
          message={t("work:copy.couldnTLoadTheTimelineTheAggregationEndpointMay_fa6922")}
        />
      )}

      {data && !isLoading && !dateRangeError && (
        data.spans.length === 0 ? (
          <div className="space-y-3">
            <EmptyState
              icon={GanttChartSquare}
              message={scopedProjectId ? t("work:copy.noProjectActivityInThisWindow_536e6b") : t("work:copy.noActivityInThisWindow_885e0c")}
            />
            <div className="flex flex-wrap items-center justify-end gap-3">
              {rangeControls}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Card className="block py-0">
              <TimelineLegend />
              <WorkTimelineChart
                data={data}
                zoom={zoom}
                zoomScale={zoomScale}
                onVisibleWindowChange={handleVisibleWindowChange}
                onZoomScaleChange={(nextScale, nextZoom = nearestZoomForScale(nextScale)) => {
                  zoomTouched.current = true;
                  setZoomScale(nextScale);
                  setZoom(nextZoom);
                }}
              />
            </Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {t("work:counts.runs", { count: data.spans.length })} ·{" "}
                {new Date(data.window.from).toLocaleString(i18n.resolvedLanguage)}{" "}{t("work:copy.to_663ea1")}{" "}{new Date(data.window.to).toLocaleString(i18n.resolvedLanguage)}
                {data.window.capped ? t("work:copy.windowCapped_f20754") : ""}
              </p>
              {rangeControls}
            </div>
          </div>
        )
      )}
    </div>
  );
}
