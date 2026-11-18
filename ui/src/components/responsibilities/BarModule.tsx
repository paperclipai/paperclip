import { useId, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  RESPONSIBILITY_VISUALIZATION_LABEL,
  defaultPrimaryDisplay,
  responsibilityVisualizationDisplay,
  responsibilityVisualizationOf,
  responsibilityVisualizationsFor,
  type Agent,
  type ProposeResponsibilityBarInteraction,
  type ProposeResponsibilityBarPayload,
  type ResponsibilityDetail,
  type ResponsibilityMetricDisplay,
  type ResponsibilityMetricSet,
  type ResponsibilityMetricView,
} from "@paperclipai/shared";
import { Loader2, MessageSquare, MoreHorizontal, X } from "lucide-react";
import { describeError } from "@/api/errors";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
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
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { proposalMetricPreview } from "@/lib/metric-charts";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { NotRightForm, useBarProposalActions } from "./BarProposalCard";
import { MetricGlance } from "./MetricGlance";
import { EditBarDialog, RecordReading, useBarConversation } from "./ResponsibilityBarCard";
import { MetricTile, useResponsibilityMetrics } from "./ResponsibilityMetricSet";

/**
 * The bar module of the spare "One screen v2" layout. A bar is up to three
 * visualizations, each one of five a person would name (Number, Percent,
 * Yes / No, Trend, Per week); it is set and changed by talking it through
 * with an agent, and by hand only from the module's menu.
 *
 * - Empty (no metric): one line and one button that opens the conversation.
 *   Without an agent to hold it, the button is the by-hand path and says why.
 * - Talking it through: a line with the way into the conversation.
 * - A proposal waiting: the visualizations exactly as they will look, each
 *   supporting one droppable before accepting.
 * - Set: the visualizations side by side (stacked when narrow), each with
 *   its title and visual only; how it is measured and when it was read show
 *   on the title. Each has a small menu: Show as (the forms its data allows)
 *   and Remove (supporting ones).
 */

/** The proposal's visualizations, always including the bar's own (drawn by its default when the agent named no form). */
export function proposalVisualizations(payload: ProposeResponsibilityBarPayload, now: Date) {
  return proposalMetricPreview(payload, now)
    ?? proposalMetricPreview({ ...payload, primaryDisplay: defaultPrimaryDisplay(payload.bar.metricKind, payload.metricCurrent === null ? 0 : 1) }, now)!;
}

/** Indexes of the supporting metrics to apply; undefined when nothing was dropped (apply them all). */
export function keptMetricIndexes(supporting: number, dropped: ReadonlySet<number>): number[] | undefined {
  if (dropped.size === 0) return undefined;
  return Array.from({ length: supporting }, (_, index) => index).filter((index) => !dropped.has(index));
}

/** This layout carries no status: the bar's own metric is drawn in the plain series colour, like the others. */
function withoutStatus(metric: ResponsibilityMetricView): ResponsibilityMetricView {
  return metric.health === null ? metric : { ...metric, health: null };
}

function tileGrid(count: number) {
  return cn("grid gap-x-6 gap-y-5", count > 1 && "sm:grid-cols-2", count > 2 && "lg:grid-cols-3");
}

/** A proposal on the page: the sentence, then each visualization as it will look; drop supporting ones, then accept. */
function ProposalPreview({ interaction, agentsById }: { interaction: ProposeResponsibilityBarInteraction; agentsById: ReadonlyMap<string, Agent> }) {
  const now = useMemo(() => new Date(), []);
  const preview = useMemo(() => proposalVisualizations(interaction.payload, now), [interaction.payload, now]);
  const [dropped, setDropped] = useState<ReadonlySet<number>>(new Set());
  const [notRight, setNotRight] = useState(false);
  const { accept, decline, busy, error } = useBarProposalActions(interaction);
  const agentName = (interaction.createdByAgentId ? agentsById.get(interaction.createdByAgentId)?.name : null) ?? "Your agent";
  const supporting = preview.metrics.length - 1;
  const toggle = (index: number) => setDropped((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    return next;
  });
  return (
    <div className="flex flex-col gap-4" data-bar-proposal="" data-testid="bar-proposal">
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">{agentName} proposes</p>
        <p className="text-sm text-foreground">{interaction.payload.bar.standard}</p>
      </div>
      <div className={tileGrid(preview.metrics.length)}>
        {preview.metrics.map((metric, position) => {
          const index = position - 1;
          if (metric.role === "supporting" && dropped.has(index)) {
            return (
              <div
                key={metric.key}
                className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-dashed border-border px-3 py-2.5"
                data-metric-key={metric.key}
                data-dropped=""
              >
                <span className="truncate text-sm text-muted-foreground line-through">{metric.title}</span>
                <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => toggle(index)}>Keep</Button>
              </div>
            );
          }
          return (
            <MetricTile
              key={metric.key}
              metric={withoutStatus(metric)}
              now={now}
              primary={metric.role === "primary" ? preview.primary : null}
              details="on_demand"
              showReadLine={false}
              className="rounded-md border border-border px-3 py-2.5"
              menu={metric.role === "primary"
                ? supporting > 0 ? <span className="pr-1.5 pt-1 text-xs text-muted-foreground" data-always-kept="">Always kept</span> : null
                : (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground"
                    aria-label={`Drop “${metric.title}”`}
                    title="Drop"
                    disabled={busy}
                    onClick={() => toggle(index)}
                    data-drop-metric=""
                  >
                    <X aria-hidden="true" />
                  </Button>
                )}
            />
          );
        })}
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{describeError(error).body}</p> : null}
      {notRight ? (
        <NotRightForm
          busy={busy}
          sending={decline.isPending}
          onSend={(text) => decline.mutate(text, { onSuccess: () => setNotRight(false) })}
          onBack={() => setNotRight(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setNotRight(true)}>
            Not right
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => accept.mutate(keptMetricIndexes(supporting, dropped))}>
            {accept.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            Use this bar
          </Button>
        </div>
      )}
    </div>
  );
}

/** Each visualization's menu: Show as (only the forms its data allows) and Remove (supporting ones). */
function VisualizationMenu({
  metric,
  onShowAs,
  onRemove,
  busy,
}: {
  metric: ResponsibilityMetricView;
  onShowAs: (display: ResponsibilityMetricDisplay) => void;
  onRemove?: () => void;
  busy: boolean;
}) {
  const kind = metric.role === "primary" ? metric.kind : null;
  const forms = responsibilityVisualizationsFor({ role: metric.role, kind, display: metric.display, unit: metric.unit });
  const current = responsibilityVisualizationOf({ display: metric.display, kind });
  if (forms.length <= 1 && !onRemove) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label={`Options for “${metric.title}”`} disabled={busy}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {forms.length > 1 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Show as</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={current}
                onValueChange={(next) => {
                  if (next !== current) onShowAs(responsibilityVisualizationDisplay(next as typeof current));
                }}
              >
                {forms.map((form) => (
                  <DropdownMenuRadioItem key={form} value={form}>{RESPONSIBILITY_VISUALIZATION_LABEL[form]}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {onRemove ? <DropdownMenuItem variant="destructive" onSelect={onRemove}>Remove</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The set as it is: switching a form shows at once, then settles to what the server saved. */
function useVisualizationWrites(responsibilityId: string) {
  const queryClient = useQueryClient();
  const key = queryKeys.responsibilities.metrics(responsibilityId);
  const showAs = useMutation({
    mutationFn: ({ metric, display }: { metric: ResponsibilityMetricView; display: ResponsibilityMetricDisplay }) =>
      responsibilityMetricsApi.setDisplay(responsibilityId, metric.role === "primary" ? "primary" : metric.id!, display),
    onMutate: async ({ metric, display }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<ResponsibilityMetricSet>(key);
      queryClient.setQueryData<ResponsibilityMetricSet>(key, (set) => set ? {
        ...set,
        metrics: set.metrics.map((entry) => entry.key === metric.key ? { ...entry, display, period: display === "bar" ? "week" : null } : entry),
      } : set);
      return { before };
    },
    onError: (_error, _input, context) => {
      if (context?.before) queryClient.setQueryData(key, context.before);
    },
    onSuccess: (set) => queryClient.setQueryData(key, set),
  });
  const remove = useMutation({
    mutationFn: (metric: ResponsibilityMetricView) => responsibilityMetricsApi.removeMetric(responsibilityId, metric.id!),
    onSuccess: (set) => queryClient.setQueryData(key, set),
  });
  return { showAs, remove };
}

/** The visualizations a responsibility shows now, each with its menu while the set is one somebody chose. */
function SetVisualizations({
  responsibility,
  now,
  editable,
}: {
  responsibility: ResponsibilityDetail;
  now: Date;
  editable: boolean;
}) {
  const query = useResponsibilityMetrics(responsibility.id);
  const metricsView = useQueryView(query);
  const { showAs, remove } = useVisualizationWrites(responsibility.id);
  const [removing, setRemoving] = useState<ResponsibilityMetricView | null>(null);
  const primary = responsibility.rollup.metric;
  if (!query.data || metricsView.kind === "error") {
    return (
      <>
        <MetricGlance metric={primary} health={responsibility.rollup.health} now={now} size="hero" className="max-w-sm" />
        {metricsView.kind === "error" ? (
          <QueryErrorState error={metricsView.error} size="inline" action="load the measures"
            onRetry={metricsView.retry} retrying={metricsView.isFetching} />
        ) : null}
      </>
    );
  }
  const set = query.data;
  // A set nobody chose is computed from the work: there is nothing to switch or remove.
  const changeable = editable && set.source === "chosen";
  return (
    <>
      <div className={tileGrid(set.metrics.length)} data-bar-visualizations={set.source}>
        {set.metrics.map((metric) => (
          <MetricTile
            key={metric.key}
            metric={withoutStatus(metric)}
            now={now}
            primary={metric.role === "primary" ? primary : null}
            details="on_demand"
            menu={changeable ? (
              <VisualizationMenu
                metric={metric}
                busy={showAs.isPending || remove.isPending}
                onShowAs={(display) => showAs.mutate({ metric, display })}
                onRemove={metric.role === "supporting" && metric.id ? () => {
                  remove.reset();
                  setRemoving(metric);
                } : undefined}
              />
            ) : undefined}
          />
        ))}
      </div>
      {showAs.error ? (
        <p role="alert" className="text-xs text-destructive">Couldn’t change how it is shown. {describeError(showAs.error).body}</p>
      ) : null}
      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removing?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>Its readings are kept.</AlertDialogDescription>
          </AlertDialogHeader>
          {remove.error ? (
            <p role="alert" className="text-sm text-destructive">Couldn’t remove it. {describeError(remove.error).body}</p>
          ) : null}
          <AlertDialogFooter className="items-center sm:justify-between">
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending || !removing}
              onClick={() => removing && remove.mutate(removing, { onSuccess: () => setRemoving(null) })}
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function BarModule({
  responsibility,
  agentsById,
  now,
  editable,
}: {
  responsibility: ResponsibilityDetail;
  agentsById: ReadonlyMap<string, Agent>;
  now: Date;
  /** False once it is let go or dismissed: shown for the record only. */
  editable: boolean;
}) {
  const headingId = useId();
  const conversation = useBarConversation(responsibility, editable);
  const [editing, setEditing] = useState(false);
  const [recording, setRecording] = useState(false);
  const hasMetric = !!responsibility.rollup.metric;
  const state = conversation.state;
  const nameOf = (agentId: string | null | undefined) => (agentId ? agentsById.get(agentId)?.name : undefined);
  const talkingWith = nameOf(state?.conversation?.agentId) ?? "an agent";
  const defaultAgent = nameOf(state?.defaultAgentId) ?? "your agent";
  const proposal = editable ? state?.proposal ?? null : null;
  const talking = editable && !proposal && state?.state === "discussing" && state.conversation ? state.conversation : null;
  const loaded = !!state;
  const noAgent = loaded && !conversation.canTalk;
  const startTalking = () => conversation.start.mutate();
  const starting = conversation.start.isPending;

  // The by-hand path: the primary button only when no agent can hold the conversation and nothing is set.
  const byHandIsPrimary = editable && !hasMetric && !proposal && !talking && (noAgent || conversation.start.isError);
  const menu = editable && !byHandIsPrimary ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label="More for the bar">
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setEditing(true)}>{hasMetric ? "Edit by hand" : "Set it by hand"}</DropdownMenuItem>
        {hasMetric ? <DropdownMenuItem onSelect={() => setRecording(true)}>Record a reading</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;
  const changeButton = editable && hasMetric && !proposal && !talking && conversation.canTalk ? (
    <Button size="xs" variant="ghost" disabled={starting} onClick={startTalking} data-bar-edit-primary="">
      {starting ? <Loader2 aria-hidden="true" className="animate-spin" /> : <MessageSquare aria-hidden="true" />}
      Change it with {defaultAgent}
    </Button>
  ) : null;

  let body;
  if (proposal) {
    body = <ProposalPreview interaction={proposal} agentsById={agentsById} />;
  } else if (!hasMetric) {
    body = !editable ? (
      <p className="text-sm text-muted-foreground">No bar.</p>
    ) : talking ? null : (
      <div className="flex flex-col items-start gap-3" data-bar-empty="">
        <p className="text-sm text-muted-foreground">How will you know this is going well?</p>
        {byHandIsPrimary ? (
          <>
            <Button size="sm" onClick={() => setEditing(true)} data-bar-edit-primary="">Set it by hand</Button>
            {noAgent ? <p className="text-xs text-muted-foreground">No agent is free to talk it through.</p> : null}
          </>
        ) : (
          <Button size="sm" disabled={!loaded || starting} onClick={startTalking} data-bar-edit-primary="">
            {starting ? <Loader2 aria-hidden="true" className="animate-spin" /> : <MessageSquare aria-hidden="true" />}
            {loaded ? `Set it with ${defaultAgent}` : "Set it with an agent"}
          </Button>
        )}
      </div>
    );
  } else {
    body = <SetVisualizations responsibility={responsibility} now={now} editable={editable} />;
  }

  return (
    <Card id="responsibility-bar" elevation="low" className="gap-4 px-5 py-4" aria-labelledby={headingId} data-bar-module="">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm font-semibold text-foreground">The bar</h2>
        <div className="flex items-center gap-1">
          {changeButton}
          {menu}
        </div>
      </div>
      {talking ? (
        <p className="text-sm text-muted-foreground" data-bar-talking="">
          Talking it through with {talkingWith}.{" "}
          <Link to={`/issues/${talking.identifier ?? talking.issueId}`} className="font-medium text-foreground underline-offset-4 hover:underline">
            Open the conversation
          </Link>
        </p>
      ) : null}
      {conversation.start.error ? (
        <p role="alert" className="text-sm text-destructive">Couldn’t start the conversation. {describeError(conversation.start.error).body}</p>
      ) : null}
      {conversation.loadError ? (
        <QueryErrorState error={conversation.loadError} size="inline" action="load the bar conversation"
          onRetry={conversation.retry} retrying={conversation.retrying} />
      ) : null}
      {body}
      {editable ? <EditBarDialog responsibility={responsibility} open={editing} onOpenChange={setEditing} /> : null}
      {editable && hasMetric ? (
        <Dialog open={recording} onOpenChange={setRecording}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Record a reading</DialogTitle>
              <DialogDescription className="sr-only">{responsibility.rollup.metric?.name}</DialogDescription>
            </DialogHeader>
            <RecordReading responsibility={responsibility} />
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}
