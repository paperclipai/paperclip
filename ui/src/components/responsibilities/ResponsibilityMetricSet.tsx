import { useId, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  ResponsibilityMetricSet as MetricSet,
  ResponsibilityMetricSummary,
  ResponsibilityMetricView,
} from "@paperclipai/shared";
import { Info, X } from "lucide-react";
import { describeError } from "@/api/errors";
import { responsibilityMetricsApi } from "@/api/responsibility-metrics";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { describeMetricTarget, formatMetricViewValue } from "@/lib/metric-charts";
import { queryKeys } from "@/lib/queryKeys";
import { describeMetricReading, describeReadingAge, describeStale } from "@/lib/responsibilities";
import { cn } from "@/lib/utils";
import { MetricBarChart, MetricLineChart, MetricRing } from "./MetricCharts";
import { MetricMeter } from "./MetricGlance";
import { StaleFlag } from "./ResponsibilityHealthBadge";

/** The label over a set nobody chose yet. */
export const STARTER_METRICS_LABEL = "Starter metrics from your work so far";

/** A responsibility's metric set; loads beside the page, never in front of it. */
export function useResponsibilityMetrics(responsibilityId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.responsibilities.metrics(responsibilityId),
    queryFn: () => responsibilityMetricsApi.metrics(responsibilityId),
    enabled,
    staleTime: 30_000,
  });
}

/** When the newest reading was taken, in words. */
export function describeMetricReadLine(metric: Pick<ResponsibilityMetricView, "starter" | "latest" | "period">, now: Date): string {
  if (metric.starter === "tasks_finished") return "Counted from the work, week by week";
  if (metric.starter && metric.starter !== "bar_metric") return "Counted from the work just now";
  if (!metric.latest) return "No readings yet";
  return `Read ${describeReadingAge(metric.latest.recordedAt, now)}`;
}

/** The big value and what it aims for. The primary reads through the bar's own words ("9 of 20"). */
function Headline({ metric, primary }: { metric: ResponsibilityMetricView; primary: ResponsibilityMetricSummary | null }) {
  const reading = metric.role === "primary" && primary ? describeMetricReading(primary) : null;
  const value = reading ? reading.current : metric.latest ? formatMetricViewValue(metric, metric.latest.value) : null;
  const target = reading ? reading.targetLabel : describeMetricTarget(metric);
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 tabular-nums" data-metric-value="">
      <span className={cn("font-semibold text-foreground", value ? "text-2xl" : "text-sm text-muted-foreground")}>
        {value ?? "No reading yet"}
      </span>
      {target ? <span className="text-sm text-muted-foreground">{target}</span> : null}
      {metric.note ? <span className="text-xs text-muted-foreground">· {metric.note}</span> : null}
    </p>
  );
}

/** The metric drawn in its form. */
function MetricForm({ metric, primary }: { metric: ResponsibilityMetricView; primary: ResponsibilityMetricSummary | null }) {
  switch (metric.display) {
    case "line":
      return <MetricLineChart metric={metric} />;
    case "bar":
      return <MetricBarChart metric={metric} />;
    case "percent":
    case "number": {
      // A number shows the bar's own meter toward its target; a percent shows its ring beside the value.
      if (metric.role !== "primary" || !primary || metric.display === "percent") return null;
      const reading = describeMetricReading(primary);
      return <MetricMeter reading={reading} health={metric.health ?? "not_measured"} label={`${metric.title}, toward its bar`} />;
    }
  }
}

/** The value (with its ring for a percent) and the metric drawn in its form. */
function MetricVisual({ metric, primary }: { metric: ResponsibilityMetricView; primary: ResponsibilityMetricSummary | null }) {
  const percentValue = metric.display === "percent" ? metric.latest?.value ?? null : null;
  return (
    <>
      {metric.display === "percent" ? (
        <div className="flex items-center gap-3">
          <MetricRing metric={metric} value={percentValue} />
          <Headline metric={metric} primary={primary} />
        </div>
      ) : (
        <Headline metric={metric} primary={primary} />
      )}
      <MetricForm metric={metric} primary={primary} />
    </>
  );
}

/**
 * One metric: its title (with how it is measured, on demand), the latest
 * value and its target, the metric drawn in its form, and when it was last
 * read. `onRemove` puts a remove button on a chosen supporting metric.
 * `details="on_demand"` prints only the title and the visual: how it is
 * measured and when it was read show on hovering or focusing the title, and
 * `menu` takes the place of the title's buttons.
 */
export function MetricTile({
  metric,
  now,
  primary = null,
  onRemove,
  caption,
  showReadLine = true,
  details = "inline",
  menu,
  className,
}: {
  metric: ResponsibilityMetricView;
  now: Date;
  /** The bar's own metric summary, for the primary's words and meter. */
  primary?: ResponsibilityMetricSummary | null;
  onRemove?: () => void;
  /** A quiet line under the title ("Line over time" on a proposal). */
  caption?: string;
  /** False where "when it was read" means nothing yet (a proposal's preview). */
  showReadLine?: boolean;
  /** `inline`: an info button and the read line; `on_demand`: both behind the title. */
  details?: "inline" | "on_demand";
  /** Controls at the right of the title (in place of the info and remove buttons). */
  menu?: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const [explained, setExplained] = useState(false);
  if (details === "on_demand") {
    const facts = [metric.description, showReadLine ? describeMetricReadLine(metric, now) : null].filter(Boolean);
    const title = <h3 id={titleId} className="min-w-0 text-sm font-medium text-foreground" tabIndex={facts.length > 0 ? 0 : undefined}>{metric.title}</h3>;
    return (
      <article
        aria-labelledby={titleId}
        className={cn("flex min-w-0 flex-col gap-2", className)}
        data-metric-key={metric.key}
        data-metric-display={metric.display}
        data-metric-role={metric.role}
      >
        <div className="flex min-w-0 items-start justify-between gap-1">
          <div className="flex min-w-0 flex-col">
            {facts.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>{title}</TooltipTrigger>
                <TooltipContent className="max-w-xs" data-metric-details="">
                  {facts.map((fact) => <p key={fact}>{fact}</p>)}
                </TooltipContent>
              </Tooltip>
            ) : title}
            {caption ? <span className="text-xs text-muted-foreground">{caption}</span> : null}
          </div>
          {menu ? <span className="-mr-1.5 -mt-1 flex shrink-0 items-center">{menu}</span> : null}
        </div>
        <MetricVisual metric={metric} primary={primary} />
      </article>
    );
  }
  return (
    <article
      aria-labelledby={titleId}
      className={cn("flex min-w-0 flex-col gap-2", className)}
      data-metric-key={metric.key}
      data-metric-display={metric.display}
      data-metric-role={metric.role}
    >
      <div className="flex min-w-0 items-start justify-between gap-1">
        <div className="flex min-w-0 flex-col">
          <h3 id={titleId} className="min-w-0 text-sm font-medium text-foreground">{metric.title}</h3>
          {caption ? <span className="text-xs text-muted-foreground">{caption}</span> : null}
        </div>
        <span className="-mr-1.5 -mt-1 flex shrink-0 items-center">
          {metric.description ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground"
              aria-expanded={explained}
              aria-controls={descriptionId}
              aria-label={`How “${metric.title}” is measured`}
              title="How it is measured"
              onClick={() => setExplained((value) => !value)}
            >
              <Info aria-hidden="true" />
            </Button>
          ) : null}
          {onRemove ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground"
              aria-label={`Remove “${metric.title}”`}
              title="Remove this metric"
              onClick={onRemove}
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
        </span>
      </div>
      {explained && metric.description ? (
        <p id={descriptionId} className="text-xs text-muted-foreground" data-metric-description="">{metric.description}</p>
      ) : null}
      <MetricVisual metric={metric} primary={primary} />
      {showReadLine ? (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground" data-metric-read="">
          <span>{describeMetricReadLine(metric, now)}</span>
          {metric.stale && metric.latest ? <StaleFlag label={describeStale(metric.latest.recordedAt, now)} /> : null}
        </p>
      ) : null}
    </article>
  );
}

/** "Chosen with Ada" or "Set by hand": who picked a chosen set. */
function chosenByLine(set: MetricSet, agentsById: ReadonlyMap<string, Agent>): string | null {
  if (set.source !== "chosen" || !set.chosenBy) return null;
  if (set.chosenBy.agentId) return `Chosen with ${agentsById.get(set.chosenBy.agentId)?.name ?? "an agent"}`;
  if (set.chosenBy.userId) return "Set by hand";
  return null;
}

/**
 * Up to three metrics, the bar's own first: in a row of up to three
 * (`layout="grid"`) or one under another (`layout="stack"`). A set nobody
 * chose yet is labelled plainly as starters. Chosen supporting metrics can be
 * removed when `canRemove`.
 */
export function ResponsibilityMetricSetView({
  set,
  now,
  primary = null,
  agentsById,
  layout = "grid",
  canRemove = false,
  onRemove,
  footer,
}: {
  set: MetricSet;
  now: Date;
  primary?: ResponsibilityMetricSummary | null;
  agentsById: ReadonlyMap<string, Agent>;
  layout?: "grid" | "stack";
  canRemove?: boolean;
  onRemove?: (metric: ResponsibilityMetricView) => void;
  footer?: ReactNode;
}) {
  const label = set.source === "starter" ? STARTER_METRICS_LABEL : chosenByLine(set, agentsById);
  return (
    <section aria-label="Metrics" className="flex flex-col gap-3" data-metric-set={set.source}>
      {label ? <p className="text-xs text-muted-foreground" data-metric-set-label="">{label}</p> : null}
      {set.metrics.length === 0 ? (
        <p className="text-sm text-muted-foreground">No metrics yet.</p>
      ) : (
        <div
          className={cn(
            "grid gap-x-6 gap-y-5",
            layout === "grid" && set.metrics.length > 1 && "sm:grid-cols-2",
            layout === "grid" && set.metrics.length > 2 && "lg:grid-cols-3",
          )}
          data-metric-layout={layout}
        >
          {set.metrics.map((metric, index) => (
            <MetricTile
              key={metric.key}
              metric={metric}
              now={now}
              primary={metric.role === "primary" ? primary : null}
              onRemove={canRemove && metric.id && onRemove ? () => onRemove(metric) : undefined}
              className={cn(layout === "stack" && index > 0 && "border-t border-border pt-4")}
            />
          ))}
        </div>
      )}
      {footer}
    </section>
  );
}

/**
 * The bar module's metrics for one responsibility: reads the set beside the
 * page and draws it, with removal for the owner. While it loads, or if it
 * fails, `fallback` (the bar's own number, as before) stands in, so the page
 * never waits on it or breaks because of it.
 */
export function ResponsibilityMetrics({
  responsibilityId,
  primary,
  now,
  agentsById,
  layout,
  editable,
  fallback,
}: {
  responsibilityId: string;
  primary: ResponsibilityMetricSummary | null;
  now: Date;
  agentsById: ReadonlyMap<string, Agent>;
  layout: "grid" | "stack";
  editable: boolean;
  fallback: ReactNode;
}) {
  const queryClient = useQueryClient();
  const query = useResponsibilityMetrics(responsibilityId);
  const [removing, setRemoving] = useState<ResponsibilityMetricView | null>(null);
  const remove = useMutation({
    mutationFn: (metric: ResponsibilityMetricView) => responsibilityMetricsApi.removeMetric(responsibilityId, metric.id!),
    onSuccess: (set) => {
      queryClient.setQueryData(queryKeys.responsibilities.metrics(responsibilityId), set);
      setRemoving(null);
    },
  });
  if (!query.data) return <>{fallback}</>;
  return (
    <>
      <ResponsibilityMetricSetView
        set={query.data}
        now={now}
        primary={primary}
        agentsById={agentsById}
        layout={layout}
        canRemove={editable && query.data.source === "chosen"}
        onRemove={(metric) => {
          remove.reset();
          setRemoving(metric);
        }}
      />
      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removing?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops showing on this responsibility, and agents stop recording it. Its readings are kept. To choose other
              metrics, talk the bar through with an agent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {remove.error ? (
            <p role="alert" className="text-sm text-destructive">Couldn’t remove it. {describeError(remove.error).body}</p>
          ) : null}
          <AlertDialogFooter className="items-center sm:justify-between">
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <Button variant="destructive" disabled={remove.isPending || !removing} onClick={() => removing && remove.mutate(removing)}>
              {remove.isPending ? "Removing…" : "Remove metric"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
