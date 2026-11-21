import { memo, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RESPONSIBILITY_STATUS_REPORT_DETAIL_MAX,
  RESPONSIBILITY_STATUS_REPORT_LABEL,
  RESPONSIBILITY_STATUS_REPORT_MESSAGE_MAX,
  RESPONSIBILITY_STATUS_REPORT_STATUSES,
  type Agent,
  type ResponsibilityStatusReportsOverview,
  type ResponsibilityStatusReportStatus,
} from "@paperclipai/shared";
import { ChevronDown, Clock, Plus, UserRound } from "lucide-react";
import { authApi } from "@/api/auth";
import { describeError } from "@/api/errors";
import { responsibilitiesApi } from "@/api/responsibilities";
import { AgentAvatar } from "@/components/AgentAvatar";
import { QueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/lib/queryKeys";
import { responsibilityPath } from "@/lib/responsibilities";
import {
  AGENT_STATUS_HEALTH,
  AGENT_STATUS_TILE_LABEL,
  agentStatusAreaGroups,
  agentStatusAuthor,
  agentStatusMetricCell,
  agentStatusRows,
  agentStatusTiles,
  composeAgentStatusSummary,
  writtenAgo,
  type AgentStatusAreaGroup,
  type AgentStatusKind,
  type AgentStatusRow,
  type AgentStatusTile,
} from "@/lib/responsibility-agent-status";
import { activeResponsibilities } from "@/lib/responsibility-views";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { PersonHeading } from "./DashboardOutline";
import { ResponsibilitiesEmpty } from "./ResponsibilitiesEmpty";
import { HEALTH_ICON, HealthDot, ProposalsNotice } from "./ResponsibilityViewParts";
import { ViewSwitcher } from "./ViewSwitcher";
import type { DashboardViewProps } from "./view-props";

const AVATAR_LIMIT = 5;
const STATUS_OPTIONS = RESPONSIBILITY_STATUS_REPORT_STATUSES.map((value) => ({ value, label: RESPONSIBILITY_STATUS_REPORT_LABEL[value] }));

interface RowActions {
  agentName: (id: string) => string | undefined;
  agentsById: ReadonlyMap<string, Agent>;
  viewerUserId: string | null;
  now: Date;
  /** The responsibility whose update request is being sent. */
  asking: string | null;
  onAsk: (row: AgentStatusRow) => void;
  onEdit: (row: AgentStatusRow) => void;
}

/**
 * A status as a dot and its word on a neutral chip. A status from the number,
 * or a written one that is out of date, reads quieter, with a dashed edge (and
 * a clock when out of date), so neither passes for a fresh report.
 */
export function AgentStatusChip({ kind, label, quiet, outOfDate, className }: {
  kind: AgentStatusKind;
  label: string;
  quiet?: boolean;
  outOfDate?: boolean;
  className?: string;
}) {
  return (
    <span
      data-agent-status-chip={kind}
      data-quiet={quiet ? "true" : undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground",
        quiet && "border-dashed text-muted-foreground",
        className,
      )}
    >
      <HealthDot health={AGENT_STATUS_HEALTH[kind]} className="size-2" />
      {label}
      {outOfDate ? <Clock aria-hidden="true" className="size-3 shrink-0" /> : null}
      {outOfDate ? <span className="sr-only"> (out of date)</span> : null}
    </span>
  );
}

function Tile({ tile }: { tile: AgentStatusTile }) {
  const health = AGENT_STATUS_HEALTH[tile.kind];
  const Icon = HEALTH_ICON[health];
  return (
    <Card elevation="low" className="gap-1 px-5 py-4" data-agent-status-tile={tile.kind}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-3xl font-semibold tabular-nums text-foreground">{tile.value}</span>
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </div>
      <p className="flex items-center gap-2 text-sm text-foreground">
        <HealthDot health={health} className="size-2" />
        {tile.label}
      </p>
      <p className="text-xs text-muted-foreground">{tile.line}</p>
    </Card>
  );
}

function AgentStack({ agentIds, agentsById }: { agentIds: readonly string[]; agentsById: ReadonlyMap<string, Agent> }) {
  if (agentIds.length === 0) return null;
  const shown = agentIds.slice(0, AVATAR_LIMIT);
  const names = agentIds.map((id) => agentsById.get(id)?.name ?? "An agent");
  return (
    <span className="flex shrink-0 items-center gap-1" aria-label={`Reporting here: ${names.join(", ")}`} role="img">
      <span className="flex -space-x-1">
        {shown.map((id) => (
          <AgentAvatar key={id} agent={agentsById.get(id) ?? { id }} name={agentsById.get(id)?.name} size={20} />
        ))}
      </span>
      {agentIds.length > shown.length ? (
        <span className="text-xs text-muted-foreground">+{agentIds.length - shown.length}</span>
      ) : null}
    </span>
  );
}

/** Who wrote the status (an agent or a person, and when), or whose view it is waiting for. */
function ReporterCell({ row, actions }: { row: AgentStatusRow; actions: RowActions }) {
  const author = agentStatusAuthor(row, actions.agentName, actions.viewerUserId);
  const reporter = row.reporterAgentId ? actions.agentsById.get(row.reporterAgentId) : undefined;
  const reporterName = row.reporterAgentId ? actions.agentName(row.reporterAgentId) ?? "An agent" : null;
  if (author && row.writtenAt) {
    const agent = row.authorAgentId ? actions.agentsById.get(row.authorAgentId) : undefined;
    return (
      <div className="flex min-w-0 flex-col items-start gap-1">
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs text-foreground">
          {row.source === "agent" ? (
            <AgentAvatar agent={agent ?? (row.authorAgentId ? { id: row.authorAgentId } : null)} name={author} size={16} />
          ) : (
            <UserRound aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{author}</span>
        </span>
        <span className={cn("text-xs", row.outOfDate ? "text-(--status-task-icon-todo)" : "text-muted-foreground")}>
          {row.outOfDate ? `Out of date · written ${writtenAgo(row.writtenAt, actions.now)}` : `Written ${writtenAgo(row.writtenAt, actions.now)}`}
        </span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {reporterName ? (
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground">
          <AgentAvatar agent={reporter ?? { id: row.reporterAgentId! }} name={reporterName} size={16} muted />
          <span className="truncate">{reporterName}</span>
        </span>
      ) : null}
      <span className="text-xs text-muted-foreground">
        {!reporterName ? "No agent can report yet" : row.updateRequested ? "Asked for an update" : "No report yet"}
      </span>
    </div>
  );
}

const AgentStatusRowItem = memo(function AgentStatusRowItem({ row, actions }: { row: AgentStatusRow; actions: RowActions }) {
  const { responsibility } = row;
  const standard = responsibility.standard?.trim();
  const metric = agentStatusMetricCell(responsibility.rollup.metric);
  const reporterName = row.reporterAgentId ? actions.agentName(row.reporterAgentId) ?? "the agent" : null;
  const asking = actions.asking === responsibility.id;
  return (
    <li
      data-responsibility-id={responsibility.id}
      data-status-source={row.source}
      data-out-of-date={row.outOfDate ? "true" : undefined}
      className="relative flex flex-col gap-3 px-5 py-3 transition-colors hover:bg-accent/50 @4xl:flex-row @4xl:items-center @4xl:gap-6"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {standard ? <span className="text-xs text-muted-foreground">{responsibility.title}</span> : null}
        <Link
          to={responsibilityPath(responsibility.id)}
          className="text-sm text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
        >
          {standard ?? responsibility.title}
        </Link>
        <p className="text-xs text-muted-foreground" data-status-message="">
          {row.message}
          {row.source === "number" ? <span className="text-muted-foreground"> · From the number, not from an agent</span> : null}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 @4xl:w-40 @4xl:shrink-0" data-status-metric="">
        {metric ? (
          <>
            <span className="truncate text-xs text-muted-foreground">{metric.label}</span>
            <span className="text-sm text-foreground">
              <span className="font-medium tabular-nums">{metric.value}</span>
              <span className="text-xs text-muted-foreground"> · {metric.target}</span>
            </span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">No metric yet</span>
        )}
      </div>
      <div className="@4xl:w-32 @4xl:shrink-0">
        <AgentStatusChip kind={row.kind} label={row.label} quiet={row.source === "number" || row.outOfDate} outOfDate={row.outOfDate} />
        {row.source === "number" ? <span className="sr-only"> (from the number)</span> : null}
      </div>
      <div className="relative z-10 flex flex-col items-start gap-2 @4xl:w-48 @4xl:shrink-0">
        <ReporterCell row={row} actions={actions} />
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            disabled={!reporterName || row.updateRequested || asking}
            data-ask-update=""
            aria-label={reporterName && !row.updateRequested ? `Ask ${reporterName} for an update on ${responsibility.title}` : undefined}
            onClick={() => actions.onAsk(row)}
          >
            {!reporterName ? "No agent to ask" : row.updateRequested ? `Waiting for ${reporterName}` : asking ? "Asking…" : "Ask for an update"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            data-edit-status=""
            aria-label={`Edit the status of ${responsibility.title}`}
            onClick={() => actions.onEdit(row)}
          >
            Edit
          </Button>
        </div>
      </div>
    </li>
  );
});

function AreaTable({
  group,
  expanded,
  onToggle,
  onAddResponsibility,
  actions,
}: {
  group: AgentStatusAreaGroup;
  expanded: boolean;
  onToggle: () => void;
  onAddResponsibility: (areaId: string | null) => void;
  actions: RowActions;
}) {
  const key = group.area?.id ?? "none";
  const listId = `agent-status-area-${key}`;
  const headline = group.headline;
  return (
    <div className="flex flex-col gap-1" data-agent-status-area={key}>
      <Card elevation="low" className="gap-0 overflow-hidden py-0">
        <h3>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={onToggle}
            className="flex w-full flex-col gap-3 px-5 py-4 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @3xl:flex-row @3xl:items-center @3xl:gap-6"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-base font-semibold text-foreground">
                {group.area?.title ?? "Not in an area"}
                {group.area?.status === "archived" ? <span className="font-normal text-muted-foreground"> · Archived</span> : null}
              </span>
              <span className="line-clamp-2 text-sm font-normal text-muted-foreground" data-area-headline="">
                {headline
                  ? `${headline.text}${headline.by ? ` (${headline.by})` : headline.fromNumber ? " (from the number)" : ""}`
                  : "Nothing you own is filed here yet."}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-4 @3xl:flex-nowrap">
              {group.kind ? (
                <AgentStatusChip kind={group.kind} label={AGENT_STATUS_TILE_LABEL[group.kind]} />
              ) : null}
              {group.rows.length > 0 ? (
                <span className="flex w-44 flex-col gap-1">
                  <span className="text-xs font-normal text-muted-foreground">{group.onTrackLabel}</span>
                  <span className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span className="block h-full rounded-full bg-foreground" style={{ width: `${group.onTrackPercent}%` }} />
                  </span>
                </span>
              ) : null}
              <AgentStack agentIds={group.agentIds} agentsById={actions.agentsById} />
              <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} />
            </span>
          </button>
        </h3>
        {expanded && group.rows.length > 0 ? (
          <ul id={listId} className="flex flex-col divide-y divide-border border-t border-border">
            {group.rows.map((row) => (
              <AgentStatusRowItem key={row.responsibility.id} row={row} actions={actions} />
            ))}
          </ul>
        ) : null}
      </Card>
      {group.area?.status === "archived" ? null : (
        <div className="flex justify-end">
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => onAddResponsibility(group.area?.id ?? null)}>
            <Plus aria-hidden="true" />
            New responsibility
          </Button>
        </div>
      )}
    </div>
  );
}

/** A person writes or corrects the status. The record says a person wrote it. */
export function StatusReportDialog({
  row,
  onOpenChange,
  onSaved,
}: {
  row: AgentStatusRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ResponsibilityStatusReportStatus>("on_track");
  const [message, setMessage] = useState("");
  const [detail, setDetail] = useState("");
  const save = useMutation({
    mutationFn: () => responsibilitiesApi.writeStatusReport(row!.responsibility.id, {
      status,
      message: message.trim(),
      detail: detail.trim() ? detail.trim() : null,
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["responsibilities", "status-reports"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.statusReport(row!.responsibility.id) }),
      ]);
      onSaved?.();
      onOpenChange(false);
    },
  });
  const reset = save.reset;
  const rowId = row?.responsibility.id ?? null;
  useEffect(() => {
    if (!row) return;
    setStatus(row.kind === "unclear" ? "unknown" : row.kind);
    setMessage(row.source === "number" ? "" : row.message);
    setDetail(row.detail ?? "");
    reset();
    // Prefill once per opened responsibility.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId, reset]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim() || save.isPending) return;
    save.mutate();
  };

  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Edit the status</DialogTitle>
            <DialogDescription>
              {row ? `${row.responsibility.title}: ` : ""}say where it stands and why. It shows as written by you until an agent writes a newer one.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">Status</span>
            <ViewSwitcher label="Status" options={STATUS_OPTIONS} value={status} onChange={setStatus} className="self-start" />
          </div>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">Why, in one line</span>
            <Input
              autoFocus
              value={message}
              maxLength={RESPONSIBILITY_STATUS_REPORT_MESSAGE_MAX}
              placeholder="e.g. Holding at 1.3 MB with the font cleanup still to land."
              onChange={(event) => setMessage(event.target.value.replace(/[\r\n]+/g, " "))}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">More detail <span className="font-normal text-muted-foreground">(optional)</span></span>
            <Textarea
              value={detail}
              rows={3}
              maxLength={RESPONSIBILITY_STATUS_REPORT_DETAIL_MAX}
              onChange={(event) => setDetail(event.target.value)}
            />
          </label>
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              Couldn’t save the status. {describeError(save.error).body}
            </p>
          ) : null}
          <DialogFooter className="items-center sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!message.trim() || save.isPending}>
              {save.isPending ? "Saving…" : "Save status"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentStatusSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-28 w-full" />)}
      </div>
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function AgentStatusBody({
  props,
  read,
  viewerUserId,
}: {
  props: DashboardViewProps;
  read: ResponsibilityStatusReportsOverview;
  viewerUserId: string | null;
}) {
  const { companyId, overview, agentsById, now, keepEmptyAreas, onAddResponsibility, onAddArea } = props;
  const queryClient = useQueryClient();
  const agentName = useCallback((id: string) => agentsById.get(id)?.name, [agentsById]);
  const rows = useMemo(() => agentStatusRows(overview.responsibilities, read), [overview.responsibilities, read]);
  const tiles = useMemo(() => agentStatusTiles(rows), [rows]);
  const summary = useMemo(() => composeAgentStatusSummary(rows, agentName, viewerUserId), [rows, agentName, viewerUserId]);
  const groups = useMemo(
    () => agentStatusAreaGroups(overview.areas, rows, agentName, viewerUserId, keepEmptyAreas),
    [overview.areas, rows, agentName, viewerUserId, keepEmptyAreas],
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<AgentStatusRow | null>(null);
  const ask = useMutation({
    mutationFn: (row: AgentStatusRow) => responsibilitiesApi.requestStatusUpdate(row.responsibility.id),
    onSuccess: async (_state, row) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["responsibilities", "status-reports", companyId] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.statusReport(row.responsibility.id) }),
      ]);
    },
  });
  const askMutate = ask.mutate;
  const asking = ask.isPending ? ask.variables?.responsibility.id ?? null : null;
  const actions = useMemo<RowActions>(() => ({
    agentName,
    agentsById,
    viewerUserId,
    now,
    asking,
    onAsk: (row) => askMutate(row),
    onEdit: setEditing,
  }), [agentName, agentsById, viewerUserId, now, asking, askMutate]);
  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <>
      <section aria-labelledby="agent-status-counts-heading" className="flex flex-col gap-3">
        <h2 id="agent-status-counts-heading" className="sr-only">Where your responsibilities stand</h2>
        <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4" data-agent-status-tiles="">
          {tiles.tiles.map((tile) => <Tile key={tile.kind} tile={tile} />)}
        </div>
        <p className="text-xs text-muted-foreground" data-agent-status-provenance="">{tiles.provenance}</p>
      </section>

      <Card elevation="low" className="gap-3 px-5 py-4" data-agent-status-summary="">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Summary</h2>
          <span className="text-xs text-muted-foreground">Composed from what agents wrote</span>
        </div>
        <p className="text-sm text-foreground">{summary.lead}</p>
        {summary.lines.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {summary.lines.map(({ row, by }) => (
              <li key={row.responsibility.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                <AgentStatusChip kind={row.kind} label={row.label} quiet={row.outOfDate} outOfDate={row.outOfDate} />
                <span className="text-muted-foreground">{row.responsibility.title}:</span>
                <span className="text-foreground">{row.message}</span>
                <span className="text-xs text-muted-foreground">{by}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {summary.waiting ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Waiting on: </span>
            <span className="text-foreground">{summary.waiting}</span>
          </p>
        ) : null}
      </Card>

      {ask.error ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t ask for an update. {describeError(ask.error).body}
        </p>
      ) : null}

      <section aria-labelledby="agent-status-areas-heading" className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h2 id="agent-status-areas-heading" className="text-lg font-semibold text-foreground">Areas</h2>
            <p className="text-sm text-muted-foreground">Each status as the agent closest to the work wrote it.</p>
          </div>
          <Button size="sm" onClick={onAddArea}>
            <Plus aria-hidden="true" />
            New area
          </Button>
        </div>
        {groups.length > 0 ? (
          <div className="flex flex-col gap-6">
            {groups.map((group) => {
              const key = group.area?.id ?? "__no_area__";
              return (
                <AreaTable
                  key={key}
                  group={group}
                  expanded={!collapsed.has(key)}
                  onToggle={() => toggle(key)}
                  onAddResponsibility={onAddResponsibility}
                  actions={actions}
                />
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing you own yet. Review what was proposed for you, or add a new responsibility.</p>
        )}
      </section>

      <StatusReportDialog row={editing} onOpenChange={(open) => { if (!open) setEditing(null); }} />
    </>
  );
}

/**
 * "Agent status": the Outline's structure in a table style, with each
 * responsibility's status as the agent with the best view of it wrote it
 * (or, where none has, the status from the number, said plainly). The person,
 * four counts, a summary composed from the reports, then each area as a
 * table: a header row with its line, status, share on track and the agents
 * reporting in it, over one row per responsibility. A row opens the
 * responsibility; the owner can ask the agent for an update or correct the
 * status by hand.
 */
export function DashboardAgentStatus(props: DashboardViewProps) {
  const { companyId, overview, onAddResponsibility, onReviewProposals } = props;
  const active = useMemo(() => activeResponsibilities(overview.responsibilities), [overview.responsibilities]);
  const { data: session } = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const query = useQuery({
    queryKey: queryKeys.responsibilities.statusReports(companyId, props.overview.ownerUserId),
    queryFn: () => responsibilitiesApi.statusReports(companyId),
    enabled: active.length > 0,
  });

  if (active.length === 0 && overview.proposed.length === 0 && (props.keepEmptyAreas?.size ?? 0) === 0) {
    return <ResponsibilitiesEmpty companyId={companyId} onAdd={() => onAddResponsibility(null)} />;
  }

  return (
    <div className="@container flex flex-col gap-8" data-dashboard-view="agent_status">
      <PersonHeading />
      <ProposalsNotice count={overview.proposed.length} onReview={onReviewProposals} />
      {active.length > 0 ? (
        <QueryView query={query} action="load what your agents wrote" loading={<AgentStatusSkeleton />}>
          {(read) => <AgentStatusBody props={props} read={read} viewerUserId={session?.user?.id ?? null} />}
        </QueryView>
      ) : (
        <AgentStatusBody
          props={props}
          read={{ ownerUserId: overview.ownerUserId, freshDays: 0, reports: [] }}
          viewerUserId={session?.user?.id ?? null}
        />
      )}
    </div>
  );
}
