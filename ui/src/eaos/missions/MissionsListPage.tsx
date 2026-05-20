// LET-503 round-4 — `/eaos/missions` rebuilt to a Linear-style task
// product surface. Andrii's escalation rejected the previous bucketed
// card layout as too generic and too dashboard-like. The Telegram
// reference is a Paperclip/Linear issue tracker: a single flat list as
// the default view (compact rows with status icon + priority + id +
// title + project label + assignee avatar + updated time + open arrow)
// and a Board view toggle for Kanban columns with compact issue cards.
//
// What this page does NOT do anymore:
//   - No 6-tile KPI/summary strip at the top. Linear shows a count and
//     filter pills, not a wide dashboard band.
//   - No 5 separate bucket sections in the default view; the list is
//     flat with status-grouped chips per row.
//   - No mission "cards" with stacked field grids in the default view —
//     all fields collapse to a single compact row.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Circle,
  CircleDashed,
  CircleDot,
  CircleSlash,
  Eye,
  Folder,
  LayoutGrid,
  Loader2,
  Minus,
  Rows3,
} from "lucide-react";
import type { Agent, Issue, IssuePriority } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { issuesApi } from "@/api/issues";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { useEaosViewerRole } from "../useEaosViewerRole";
import { EaosPageHeader } from "../EaosPageHeader";
import { AgentAvatar } from "../agents/AgentAvatar";
import type { AvatarSubject } from "../agents/agent-avatar";
import {
  bucketMissions,
  resolveMissionRow,
  summarizeMissionList,
  type MissionPrimaryState,
  type MissionRow,
} from "./mission-resolver";

const MISSION_FETCH_LIMIT = 100;

type ViewMode = "list" | "board";

interface MissionsListPageProps {
  // Tests inject a fixed `now` so freshness chips are deterministic. In
  // production we let the resolver default to `new Date()` per call.
  now?: Date;
  // Tests + the targeted screenshot runner can pin the default view.
  initialMode?: ViewMode;
}

export function MissionsListPage({ now, initialMode = "list" }: MissionsListPageProps = {}) {
  const { selectedCompanyId } = useCompany();
  const { isOperator } = useEaosViewerRole();
  const [mode, setMode] = useState<ViewMode>(initialMode);

  const issuesQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.issues.list(selectedCompanyId), "eaos-missions", MISSION_FETCH_LIMIT]
      : ["issues", "__no-company__", "eaos-missions"],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        limit: MISSION_FETCH_LIMIT,
        includeBlockedBy: true,
      }),
    enabled: Boolean(selectedCompanyId),
  });

  const agentsQuery = useQuery<Agent[]>({
    queryKey: selectedCompanyId
      ? [...queryKeys.agents.list(selectedCompanyId), "eaos-missions-owner-lookup"]
      : ["agents", "__no-company__", "eaos-missions-owner-lookup"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    staleTime: 60_000,
  });

  const agentLookup = useMemo(() => {
    const list: Agent[] = agentsQuery.data ?? [];
    const map = new Map<string, { name: string; role: string | null }>();
    for (const agent of list) {
      map.set(agent.id, { name: agent.name ?? "", role: agent.role ?? null });
      // execution-agent-name-key (e.g. "engineer") is sometimes the only
      // pointer to a role-based agent; key off urlKey/name so the resolver
      // can still produce real initials in that path.
      const urlKey = (agent as { urlKey?: string | null }).urlKey;
      if (urlKey) {
        map.set(urlKey, { name: agent.name ?? urlKey, role: agent.role ?? null });
      }
    }
    return map;
  }, [agentsQuery.data]);

  const rows = useMemo<MissionRow[]>(() => {
    const issues: Issue[] = issuesQuery.data ?? [];
    const resolveAt = now ?? new Date();
    return issues.map((issue) => resolveMissionRow(issue, resolveAt));
  }, [issuesQuery.data, now]);

  const buckets = useMemo(() => bucketMissions(rows), [rows]);
  const summary = useMemo(() => summarizeMissionList(rows), [rows]);

  const isLoading = Boolean(selectedCompanyId) && issuesQuery.isLoading;
  const isError = Boolean(selectedCompanyId) && issuesQuery.isError;
  const hasData = !isLoading && !isError && issuesQuery.isSuccess;
  const dataConnected = hasData;

  return (
    <section
      aria-labelledby="eaos-missions-title"
      className="-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8"
      data-testid="eaos-missions-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
      data-eaos-missions-mode={mode}
    >
      <EaosPageHeader
        title="Missions"
        testId="eaos-missions-page-header"
        actions={
          <>
            {rows.length > 0 ? (
              <span
                className="text-xs font-normal tabular-nums text-muted-foreground"
                data-testid="eaos-missions-count"
              >
                {rows.length}
              </span>
            ) : null}
            <ViewModeToggle mode={mode} onChange={setMode} />
          </>
        }
      />
      <h1 id="eaos-missions-title" className="sr-only" data-testid="eaos-missions-title">
        Missions
      </h1>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4 sm:px-6 lg:px-8">

      {!selectedCompanyId ? (
        <NoCompanyState />
      ) : isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState message={readErrorMessage(issuesQuery.error)} />
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : mode === "list" ? (
        <MissionList buckets={buckets} isOperator={isOperator} agentLookup={agentLookup} />
      ) : (
        <MissionBoard buckets={buckets} isOperator={isOperator} agentLookup={agentLookup} />
      )}

      {hasData && rows.length > 0 ? <FilterSummary summary={summary} /> : null}
      </div>
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to load missions.";
}

function NoCompanyState() {
  return (
    <p
      role="status"
      className="rounded-md border border-dashed border-border bg-card px-3 py-2 text-xs text-muted-foreground"
      data-testid="eaos-missions-no-company"
    >
      Select a company scope in the top bar to load missions.
    </p>
  );
}

function LoadingState() {
  return (
    <p
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground"
      data-testid="eaos-missions-loading"
    >
      Loading missions…
    </p>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
      data-testid="eaos-missions-error"
    >
      <p className="font-medium">Could not load missions.</p>
      <p className="mt-1">{message}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <p
      role="status"
      className="rounded-md border border-dashed border-border bg-card px-3 py-2 text-xs text-muted-foreground"
      data-testid="eaos-missions-empty"
    >
      No missions in this scope yet.
    </p>
  );
}

function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (next: ViewMode) => void }) {
  return (
    <div
      role="tablist"
      aria-label="View mode"
      data-testid="eaos-missions-view-toggle"
      className="inline-flex items-center rounded-md border border-border bg-card p-0.5 text-xs"
    >
      <ViewModeButton mode={mode} active="list" onChange={onChange} icon={Rows3} label="List" />
      <ViewModeButton mode={mode} active="board" onChange={onChange} icon={LayoutGrid} label="Board" />
    </div>
  );
}

function ViewModeButton({
  mode,
  active,
  onChange,
  icon: Icon,
  label,
}: {
  mode: ViewMode;
  active: ViewMode;
  onChange: (next: ViewMode) => void;
  icon: typeof Rows3;
  label: string;
}) {
  const selected = mode === active;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      data-testid={`eaos-missions-view-${active}`}
      onClick={() => onChange(active)}
      className={
        "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
        (selected
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground")
      }
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </button>
  );
}

// ---- Linear-style flat list ----

type AgentLookup = Map<string, { name: string; role: string | null }>;

function enrichAvatar(
  avatar: MissionRow["ownerSummary"]["avatar"],
  agentLookup: AgentLookup,
): { subject: AvatarSubject; displayName: string } | null {
  if (!avatar) return null;
  if (avatar.kind === "agent") {
    const meta = agentLookup.get(avatar.agentId);
    const name = meta?.name ?? "";
    const role = meta?.role ?? avatar.role ?? null;
    return {
      subject: { kind: "agent", agentId: avatar.agentId, name, role },
      displayName: name || (role ? capitalize(role) : "Agent"),
    };
  }
  if (avatar.kind === "user") {
    return {
      subject: { kind: "user", userId: avatar.userId, name: null },
      displayName: "Teammate",
    };
  }
  return { subject: { kind: "system" }, displayName: "System" };
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function MissionList({
  buckets,
  isOperator,
  agentLookup,
}: {
  buckets: ReturnType<typeof bucketMissions>;
  isOperator: boolean;
  agentLookup: AgentLookup;
}) {
  // LET-506 phase-2 — adapt Multica's `ListView` status grouping. List
  // rows live under a single scroller, but each status group carries a
  // sticky-ish heading so the row column stays readable even when the
  // count gets long. Empty buckets are intentionally omitted so the
  // surface stays calm.
  const sections: Array<{ id: string; title: string; rows: readonly MissionRow[] }> = [
    { id: "active", title: "Active", rows: buckets.active },
    { id: "blocked", title: "Blocked", rows: buckets.blocked },
    { id: "in-review", title: "In review", rows: buckets.inReview },
    { id: "done", title: "Done", rows: buckets.done },
    { id: "cancelled", title: "Cancelled", rows: buckets.cancelled },
  ].filter((section) => section.rows.length > 0);

  return (
    <div
      data-testid="eaos-missions-list"
      className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card"
    >
      {sections.map((section) => (
        <section
          key={section.id}
          aria-label={section.title}
          data-testid={`eaos-missions-list-group-${section.id}`}
          data-mission-group={section.id}
        >
          <header
            className="sticky top-0 z-[1] flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-muted/30"
            data-testid={`eaos-missions-list-group-${section.id}-header`}
          >
            <span>{section.title}</span>
            <span className="tabular-nums">{section.rows.length}</span>
          </header>
          <ul role="list" className="divide-y divide-border">
            {section.rows.map((row) => (
              <MissionListRow
                key={row.id}
                row={row}
                isOperator={isOperator}
                agentLookup={agentLookup}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MissionListRow({
  row,
  isOperator,
  agentLookup,
}: {
  row: MissionRow;
  isOperator: boolean;
  agentLookup: AgentLookup;
}) {
  const owner = enrichAvatar(row.ownerSummary.avatar, agentLookup);
  return (
    <li
      data-testid="eaos-missions-row"
      data-mission-id={row.id}
      data-mission-primary-state={row.primaryState}
      data-mission-priority={row.priority}
      data-mission-freshness={row.freshness}
      className="group flex items-center gap-2 px-3 py-2 hover:bg-accent/30"
    >
      <StatusCell state={row.primaryState} />
      <PriorityCell priority={row.priority} />
      {row.identifier ? (
        <span
          data-testid="eaos-missions-row-identifier"
          className="hidden w-20 shrink-0 truncate font-mono text-[11px] text-muted-foreground tabular-nums sm:inline"
        >
          {row.identifier}
        </span>
      ) : null}
      <Link
        to={`/eaos/missions/${row.identifier ?? row.id}`}
        className="min-w-0 flex-1 truncate text-sm text-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:underline"
        data-testid="eaos-missions-row-title"
      >
        {row.title}
      </Link>
      {row.projectLabel ? (
        <ProjectChip label={row.projectLabel} urlKey={row.projectUrlKey} />
      ) : null}
      {owner ? (
        <OwnerCell subject={owner.subject} displayName={owner.displayName} reason={row.ownerSummary.currentReason} />
      ) : (
        <UnassignedDot />
      )}
      <RelativeTimeCell at={row.updatedAt} />
      {row.riskSummary.liveActionMentioned && isOperator ? (
        <AlertTriangle
          className="h-3.5 w-3.5 text-amber-600"
          aria-label="Live-action risk"
          data-testid="eaos-missions-row-risk"
        />
      ) : null}
      <Link
        to={`/eaos/missions/${row.identifier ?? row.id}`}
        aria-label={`Open ${row.identifier ?? row.title}`}
        className="invisible text-muted-foreground transition-opacity hover:text-foreground group-hover:visible focus-visible:visible focus-visible:outline-none focus-visible:underline"
        data-testid="eaos-missions-row-open"
      >
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </li>
  );
}

// ---- Board (Kanban) ----

function MissionBoard({
  buckets,
  isOperator,
  agentLookup,
}: {
  buckets: { active: MissionRow[]; blocked: MissionRow[]; inReview: MissionRow[]; done: MissionRow[]; cancelled: MissionRow[] };
  isOperator: boolean;
  agentLookup: AgentLookup;
}) {
  // LET-503 round-6: render Cancelled only when it has rows so the empty
  // column does not show on the typical, non-cancelled board, but the sum
  // of column counts is always equal to the header `Missions {N}` count.
  const columns: Array<{ id: string; title: string; rows: MissionRow[] }> = [
    { id: "active", title: "Active", rows: buckets.active },
    { id: "blocked", title: "Blocked", rows: buckets.blocked },
    { id: "in-review", title: "In review", rows: buckets.inReview },
    { id: "done", title: "Done", rows: buckets.done },
  ];
  if (buckets.cancelled.length > 0) {
    columns.push({ id: "cancelled", title: "Cancelled", rows: buckets.cancelled });
  }
  const gridCols =
    columns.length >= 5
      ? "sm:grid-cols-2 lg:grid-cols-5"
      : "sm:grid-cols-2 lg:grid-cols-4";
  return (
    <div
      data-testid="eaos-missions-board"
      className={`grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto ${gridCols}`}
    >
      {columns.map((column) => (
        <BoardColumn key={column.id} {...column} isOperator={isOperator} agentLookup={agentLookup} />
      ))}
    </div>
  );
}

function BoardColumn({
  id,
  title,
  rows,
  isOperator,
  agentLookup,
}: {
  id: string;
  title: string;
  rows: MissionRow[];
  isOperator: boolean;
  agentLookup: AgentLookup;
}) {
  return (
    <section
      aria-label={title}
      data-testid={`eaos-missions-board-column-${id}`}
      className="flex min-h-0 flex-col gap-2 rounded-md border border-border bg-card p-2"
    >
      <header className="flex items-center justify-between px-1">
        <h3 className="text-xs font-semibold tracking-wide text-foreground">{title}</h3>
        <span className="text-[11px] tabular-nums text-muted-foreground">{rows.length}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        {rows.length === 0 ? (
          <p
            className="rounded border border-dashed border-border bg-background px-2 py-1.5 text-[11px] text-muted-foreground"
            data-testid={`eaos-missions-board-column-${id}-empty`}
          >
            None.
          </p>
        ) : (
          rows.map((row) => (
            <BoardCard key={row.id} row={row} isOperator={isOperator} agentLookup={agentLookup} />
          ))
        )}
      </div>
    </section>
  );
}

function BoardCard({
  row,
  isOperator,
  agentLookup,
}: {
  row: MissionRow;
  isOperator: boolean;
  agentLookup: AgentLookup;
}) {
  const owner = enrichAvatar(row.ownerSummary.avatar, agentLookup);
  return (
    <Link
      to={`/eaos/missions/${row.identifier ?? row.id}`}
      data-testid="eaos-missions-board-card"
      data-mission-id={row.id}
      data-mission-priority={row.priority}
      className="block rounded-md border border-border bg-background p-2.5 transition-colors hover:border-foreground/30 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <PriorityCell priority={row.priority} compact />
        {row.identifier ? <span className="font-mono tabular-nums">{row.identifier}</span> : null}
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm text-foreground">{row.title}</p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {owner ? (
            <span className="flex min-w-0 items-center gap-1" title={owner.displayName}>
              <AgentAvatar
                size="xs"
                variant="initials"
                subject={owner.subject}
                ariaLabel={owner.displayName}
                testId="eaos-missions-board-card-owner-avatar"
              />
              <span className="hidden max-w-[80px] truncate sm:inline">{owner.displayName}</span>
            </span>
          ) : (
            <UnassignedDot small />
          )}
          {row.projectLabel ? <ProjectChip label={row.projectLabel} urlKey={row.projectUrlKey} compact /> : null}
        </div>
        <RelativeTimeCell at={row.updatedAt} compact />
        {row.riskSummary.liveActionMentioned && isOperator ? (
          <AlertTriangle className="h-3 w-3 text-amber-600" aria-label="Live-action risk" />
        ) : null}
      </div>
    </Link>
  );
}

// ---- Small leaf components ----

const STATUS_LABEL: Record<MissionPrimaryState, string> = {
  active: "In progress",
  blocked: "Blocked",
  "in-review": "In review",
  "release-held": "Release held",
  "done-with-evidence": "Done",
  "done-evidence-incomplete": "Done",
  cancelled: "Cancelled",
  stale: "Stale",
  "needs-next-owner": "Needs owner",
};

function StatusCell({ state }: { state: MissionPrimaryState }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      data-testid="eaos-missions-row-status"
      data-state={state}
    >
      <StatusIcon state={state} />
      <span className="hidden text-[11px] font-medium text-muted-foreground sm:inline">
        {STATUS_LABEL[state]}
      </span>
    </span>
  );
}

const PRIORITY_SHORTHAND: Record<IssuePriority, { code: string; label: string; tone: string }> = {
  critical: { code: "P0", label: "Critical", tone: "text-red-600 bg-red-50 border-red-200" },
  high: { code: "P1", label: "High", tone: "text-orange-600 bg-orange-50 border-orange-200" },
  medium: { code: "P2", label: "Medium", tone: "text-muted-foreground bg-background border-border" },
  low: { code: "P3", label: "Low", tone: "text-muted-foreground bg-background border-border" },
};

function PriorityCell({ priority, compact }: { priority: IssuePriority; compact?: boolean }) {
  const meta = PRIORITY_SHORTHAND[priority];
  return (
    <span
      aria-label={`Priority: ${meta.label}`}
      title={meta.label}
      data-testid="eaos-missions-row-priority"
      data-priority={priority}
      className={
        "inline-flex shrink-0 items-center gap-0.5 rounded border font-mono text-[10px] font-semibold tabular-nums " +
        meta.tone +
        " " +
        (compact ? "px-1 py-0" : "px-1.5 py-0.5")
      }
    >
      <PriorityIcon priority={priority} />
      <span>{meta.code}</span>
    </span>
  );
}

function OwnerCell({
  subject,
  displayName,
  reason,
}: {
  subject: AvatarSubject;
  displayName: string;
  reason: string;
}) {
  return (
    <span
      data-testid="eaos-missions-row-owner"
      className="inline-flex min-w-0 shrink-0 items-center gap-1.5"
      title={`${displayName} — ${reason}`}
    >
      <AgentAvatar
        size="sm"
        variant="initials"
        subject={subject}
        ariaLabel={`${displayName} — ${reason}`}
        testId="eaos-missions-row-owner-avatar"
      />
      <span className="hidden max-w-[120px] truncate text-[11px] text-muted-foreground md:inline">
        {displayName}
      </span>
    </span>
  );
}

function StatusIcon({ state }: { state: MissionPrimaryState }) {
  switch (state) {
    case "active":
      return (
        <Loader2
          className="h-3.5 w-3.5 shrink-0 text-blue-600 animate-[spin_3s_linear_infinite]"
          aria-label="Active"
          data-testid="eaos-missions-row-status-icon"
          data-state="active"
        />
      );
    case "blocked":
      return (
        <AlertCircle
          className="h-3.5 w-3.5 shrink-0 text-amber-600"
          aria-label="Blocked"
          data-testid="eaos-missions-row-status-icon"
          data-state="blocked"
        />
      );
    case "in-review":
      return (
        <Eye
          className="h-3.5 w-3.5 shrink-0 text-violet-600"
          aria-label="In review"
          data-testid="eaos-missions-row-status-icon"
          data-state="in-review"
        />
      );
    case "release-held":
      return (
        <Eye
          className="h-3.5 w-3.5 shrink-0 text-amber-600"
          aria-label="Release held"
          data-testid="eaos-missions-row-status-icon"
          data-state="release-held"
        />
      );
    case "done-with-evidence":
      return (
        <CircleDot
          className="h-3.5 w-3.5 shrink-0 text-emerald-600"
          aria-label="Done"
          data-testid="eaos-missions-row-status-icon"
          data-state="done"
        />
      );
    case "done-evidence-incomplete":
      return (
        <CircleDot
          className="h-3.5 w-3.5 shrink-0 text-emerald-500/60"
          aria-label="Done — evidence light"
          data-testid="eaos-missions-row-status-icon"
          data-state="done-evidence-incomplete"
        />
      );
    case "cancelled":
      return (
        <CircleSlash
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-label="Cancelled"
          data-testid="eaos-missions-row-status-icon"
          data-state="cancelled"
        />
      );
    case "stale":
      return (
        <CircleDashed
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-label="Stale"
          data-testid="eaos-missions-row-status-icon"
          data-state="stale"
        />
      );
    case "needs-next-owner":
      return (
        <Circle
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-label="Needs an owner"
          data-testid="eaos-missions-row-status-icon"
          data-state="needs-next-owner"
        />
      );
  }
}

function PriorityIcon({ priority }: { priority: IssuePriority }) {
  const Icon = priority === "critical"
    ? AlertTriangle
    : priority === "high"
      ? ArrowUp
      : priority === "medium"
        ? ArrowRight
        : priority === "low"
          ? ArrowDown
          : Minus;
  const tone = priority === "critical"
    ? "text-red-600"
    : priority === "high"
      ? "text-orange-500"
      : priority === "medium"
        ? "text-muted-foreground"
        : "text-muted-foreground/70";
  return (
    <Icon
      className={"h-3.5 w-3.5 shrink-0 " + tone}
      aria-label={`Priority: ${priority}`}
      data-testid="eaos-missions-row-priority"
      data-priority={priority}
    />
  );
}

function ProjectChip({ label, urlKey, compact }: { label: string; urlKey: string | null; compact?: boolean }) {
  const inner = (
    <span
      className={
        "inline-flex shrink-0 items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground " +
        (compact ? "max-w-[120px] truncate" : "max-w-[160px] truncate")
      }
      data-testid="eaos-missions-row-project"
    >
      <Folder className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
  return urlKey ? <Link to={`/eaos/projects/${urlKey}`}>{inner}</Link> : inner;
}

function UnassignedDot({ small }: { small?: boolean } = {}) {
  return (
    <span
      data-testid="eaos-missions-row-owner-unassigned"
      aria-label="Unassigned"
      className={
        "inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-border bg-background " +
        (small ? "h-4 w-4" : "h-[22px] w-[22px]")
      }
    />
  );
}

function RelativeTimeCell({ at, compact }: { at: Date | null; compact?: boolean }) {
  const label = formatRelative(at);
  return (
    <span
      className={
        "shrink-0 tabular-nums text-muted-foreground " + (compact ? "text-[10px]" : "text-[11px]")
      }
      data-testid="eaos-missions-row-updated"
      title={at ? at.toISOString() : undefined}
    >
      {label}
    </span>
  );
}

function formatRelative(at: Date | null): string {
  if (!at) return "—";
  const ms = Date.now() - at.getTime();
  if (ms < 60_000) return "now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d`;
  return at.toISOString().slice(0, 10);
}

function FilterSummary({ summary }: { summary: ReturnType<typeof summarizeMissionList> }) {
  return (
    <p
      data-testid="eaos-missions-filter-summary"
      className="px-1 text-[11px] text-muted-foreground"
    >
      {summary.active} active · {summary.blocked} blocked · {summary.inReview} in review · {summary.done} done
      {summary.cancelled > 0 ? ` · ${summary.cancelled} cancelled` : ""}
      {summary.stale > 0 ? ` · ${summary.stale} stale` : ""}
    </p>
  );
}
