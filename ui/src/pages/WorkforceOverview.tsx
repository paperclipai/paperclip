import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { RadioTower } from "lucide-react";
import {
  WORKFORCE_OVERVIEW_POLL_MS,
  formatWorkforceTimestamp,
  workforceConnection,
  type WorkforceAgentCard,
  type WorkforceConnection,
  type WorkforceCount,
  type WorkforceOverview,
  type WorkforceProjectCard,
} from "@paperclipai/shared/workforce-overview";
import { Link, useSearchParams } from "@/lib/router";
import { workforceOverviewApi } from "../api/workforceOverview";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompanyLiveEvent } from "../context/LiveUpdatesProvider";
import { useCompany } from "../context/CompanyContext";
import { usePageVisibility } from "../lib/page-visibility";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

const LIVE_EVENT_REFETCH_FLOOR_MS = 2_000;

export function WorkforceOverview() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const initiative = searchParams.get("initiative");
  const visibility = usePageVisibility();
  const lastEventRefetch = useRef(0);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Activity", href: "/activity" },
      { label: "Workforce" },
    ]);
  }, [setBreadcrumbs]);

  const query = useQuery({
    queryKey: queryKeys.workforceOverview(selectedCompanyId ?? "", initiative),
    queryFn: () => workforceOverviewApi.get(selectedCompanyId!, initiative),
    enabled: !!selectedCompanyId,
    refetchInterval: visibility.visible ? WORKFORCE_OVERVIEW_POLL_MS : false,
    refetchIntervalInBackground: false,
  });

  useCompanyLiveEvent(() => {
    if (!visibility.visible || !selectedCompanyId) return;
    const now = Date.now();
    if (now - lastEventRefetch.current < LIVE_EVENT_REFETCH_FLOOR_MS) return;
    lastEventRefetch.current = now;
    void query.refetch();
  });

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={RadioTower}
        message={companies.length === 0 ? "Create an organization to view the workforce." : "Select an organization to view the workforce."}
      />
    );
  }

  const lastSuccessAt = query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt).toISOString() : null;
  const connection = workforceConnection({
    hasSnapshot: Boolean(query.data),
    lastSuccessAt,
    now: new Date().toISOString(),
    lastFetchFailed: query.isError,
    visible: visibility.visible,
  });

  return (
    <WorkforceOverviewBody
      overview={query.data ?? null}
      loading={query.isLoading && !query.data}
      connection={connection.connection}
      lastSuccessAt={lastSuccessAt}
      fetchError={query.isError ? "The latest refresh failed. Counts below are the last successful snapshot." : null}
      refreshing={query.isFetching}
      initiative={initiative}
      onInitiativeChange={(next) => {
        setSearchParams((current) => {
          const params = new URLSearchParams(current);
          if (next) params.set("initiative", next);
          else params.delete("initiative");
          return params;
        }, { replace: true });
      }}
      onRefresh={() => {
        void query.refetch();
      }}
    />
  );
}

export function WorkforceOverviewBody({
  overview,
  loading,
  connection,
  lastSuccessAt,
  fetchError,
  refreshing,
  initiative,
  onInitiativeChange,
  onRefresh,
}: {
  overview: WorkforceOverview | null;
  loading: boolean;
  connection: WorkforceConnection;
  lastSuccessAt: string | null;
  fetchError: string | null;
  refreshing: boolean;
  initiative: string | null;
  onInitiativeChange: (initiative: string | null) => void;
  onRefresh: () => void;
}) {
  if (loading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading the workforce snapshot…</p>;
  }

  if (!overview) {
    return (
      <EmptyState
        icon={RadioTower}
        title="Not connected"
        message="The workforce snapshot is unavailable. Counts are not shown as zero."
      />
    );
  }

  const selectedInitiative = overview.initiatives.find((item) => item.id === overview.selectedInitiativeId);
  const selectedOptionValue = selectedInitiative?.identifier ?? selectedInitiative?.id ?? "";
  // Option values are public identifiers. A URL that still holds the issue id must select that same option.
  const initiativeValue =
    !initiative || initiative === selectedInitiative?.id || initiative === selectedOptionValue
      ? selectedOptionValue
      : initiative;

  const counts: WorkforceCount[] = [
    overview.counts.activeProjects,
    overview.counts.executingAgents,
    overview.counts.waitingEligible,
    overview.counts.blocked,
    overview.counts.pendingReviews,
    overview.counts.marcDecisions,
    overview.counts.recentlyAccepted,
    overview.counts.pausedAgents,
    overview.counts.security,
  ];

  return (
    <div className="space-y-8 p-4 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Live workforce</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only. Refresh loads the latest snapshot and does not resume, reassign, or dispatch work.
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <ConnectionChip connection={connection} />
          <p className="text-xs text-muted-foreground">
            Last refresh {formatWorkforceTimestamp(lastSuccessAt)} · {overview.timeZone}
          </p>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded-lg border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-60"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {connection !== "live" ? (
        <p className="rounded-lg border bg-muted px-4 py-3 text-sm text-foreground" role="status">
          {fetchError ?? "This snapshot is stale. The numbers are the last successful read, not zeros."}
          {connection === "stale" && !fetchError ? " The tab is hidden or the last refresh is older than 30 seconds." : null}
        </p>
      ) : null}

      {overview.truncated ? (
        <p className="text-sm text-muted-foreground">
          This snapshot hit a read limit. Older tasks, runs, or deliverables may be absent.
        </p>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Overview</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {counts.map((count) => (
            <article key={count.label} className="rounded-lg border bg-card px-4 py-4" data-testid={`workforce-count-${count.label}`}>
              <p className="text-2xl font-semibold tabular-nums">{count.value}</p>
              <p className="mt-1 text-sm font-medium text-muted-foreground">{count.label}</p>
              <p className="mt-2 text-xs text-muted-foreground">{count.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Projects</h2>
        {overview.projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects in this snapshot.</p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {overview.projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Agents</h2>
        {overview.agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agents in this snapshot.</p>
        ) : (
          <div className="space-y-3">
            {overview.agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <h2 className="text-lg font-semibold">Handoff timeline</h2>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Initiative
            <select
              className="rounded-lg border bg-card px-2 py-1.5 text-sm text-foreground"
              value={initiativeValue}
              onChange={(event) => onInitiativeChange(event.target.value || null)}
            >
              <option value="">Latest initiative with child tasks</option>
              {overview.initiatives.map((item) => (
                <option key={item.id} value={item.identifier ?? item.id}>
                  {item.identifier ? `${item.identifier} · ` : ""}{item.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        {overview.timelineNote ? <p className="text-sm text-muted-foreground">{overview.timelineNote}</p> : null}
        {overview.timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity-log evidence for this initiative.</p>
        ) : (
          <ol className="space-y-3">
            {overview.timeline.map((entry) => (
              <li key={entry.id} className="rounded-lg border bg-card px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">{entry.summary}</p>
                  <time className="text-xs text-muted-foreground" dateTime={entry.at}>
                    {formatWorkforceTimestamp(entry.at)}
                  </time>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {entry.action} · {entry.actorLabel} · {entry.provenanceLabel}
                  {entry.issueHref ? (
                    <>
                      {" · "}
                      <WorkforceHref href={entry.issueHref}>{entry.issueIdentifier ?? "Task"}</WorkforceHref>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ol>
        )}
        <p className="text-xs text-muted-foreground">
          Events come from the activity log. <Link to="/activity" className="text-primary hover:underline">Open Activity</Link>
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Deliverables</h2>
        {overview.deliverables.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deliverables in this snapshot.</p>
        ) : (
          <ul className="space-y-2">
            {overview.deliverables.map((item) => (
              <li key={item.id} className="flex flex-col gap-1 rounded-lg border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.type}
                    {" · "}
                    <WorkforceHref href={item.issueHref}>{item.issueIdentifier ?? "Task"}</WorkforceHref>
                  </p>
                </div>
                {item.href ? (
                  <WorkforceHref href={item.href}>{item.linkLabel}</WorkforceHref>
                ) : (
                  <span className="text-xs text-muted-foreground">{item.linkLabel}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Blockers and decisions</h2>
        <p className="text-sm text-muted-foreground">
          Security {overview.counts.security.value}. Security items stay labeled and are not folded into executing agents.
        </p>
        {overview.blockers.length === 0 && overview.decisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No blocked tasks or open decisions in this snapshot.</p>
        ) : null}
        <ul className="space-y-2">
          {overview.blockers.map((item) => (
            <li key={item.id} className="rounded-lg border bg-card px-4 py-3">
              <p className="text-sm font-medium">
                <WorkforceHref href={item.href}>{item.identifier ? `${item.identifier} · ` : ""}{item.title}</WorkforceHref>
                {item.security ? <span className="ml-2 text-xs font-medium text-foreground">Security</span> : null}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {item.owner} · {item.releaseCondition}
              </p>
            </li>
          ))}
          {overview.decisions.map((item) => (
            <li key={`${item.kind}-${item.id}`} className="rounded-lg border bg-card px-4 py-3">
              <p className="text-sm font-medium">
                {item.href ? <WorkforceHref href={item.href}>{item.title}</WorkforceHref> : item.title}
                {item.marc ? <span className="ml-2 text-xs font-medium text-foreground">Marc</span> : null}
                {item.security ? <span className="ml-2 text-xs font-medium text-foreground">Security</span> : null}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {item.owner} · {item.releaseCondition}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ProjectCard({ project }: { project: WorkforceProjectCard }) {
  return (
    <article className="rounded-lg border bg-card px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold">
          <WorkforceHref href={project.projectHref}>{project.name}</WorkforceHref>
        </h3>
        <span className="text-xs text-muted-foreground">{project.stage}</span>
      </div>
      <dl className="mt-3 space-y-1 text-sm">
        <Row label="Owner" value={project.owner} />
        <Row
          label="Current task"
          value={
            project.currentTask ? (
              <>
                <WorkforceHref href={project.currentTask.href}>
                  {project.currentTask.identifier ? `${project.currentTask.identifier} · ` : ""}
                  {project.currentTask.title}
                </WorkforceHref>
                {` · ${project.currentTask.assignee}`}
                {project.currentTask.assigneePaused ? " · Paused" : ""}
                {` · ${project.currentTask.statusLabel}`}
              </>
            ) : (
              "None recorded"
            )
          }
        />
        <Row label="Last accepted output" value={project.lastAcceptedOutput} />
        <Row label="Next action" value={project.nextAction} />
      </dl>
      {project.blockers.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {project.blockers.map((blocker) => (
            <li key={blocker.id}>
              <WorkforceHref href={blocker.href}>{blocker.identifier ?? blocker.title}</WorkforceHref>
              {blocker.security ? " · Security" : ""} · {blocker.releaseCondition}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">No blockers recorded.</p>
      )}
    </article>
  );
}

function AgentCard({ agent }: { agent: WorkforceAgentCard }) {
  const reporting = agent.reporting.length
    ? agent.reporting.map((hop) => `${hop.name}${hop.xo ? " (XO)" : ""}${hop.unknown ? "" : ` · ${hop.role}`}`).join(" → ")
    : "No manager recorded";
  return (
    <article className="rounded-lg border bg-card px-4 py-4" data-testid={`workforce-agent-${agent.name}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">
          <WorkforceHref href={agent.href}>{agent.name}</WorkforceHref>
          <span className="ml-2 font-normal text-muted-foreground">{agent.roleLabel}{agent.title ? ` · ${agent.title}` : ""}</span>
        </h3>
        <span
          className={cn(
            "rounded-lg border px-2 py-0.5 text-xs font-medium",
            agent.disposition === "paused" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {agent.dispositionLabel}
        </span>
      </div>
      <dl className="mt-3 space-y-1 text-sm">
        <Row label="Reports to" value={reporting} />
        <Row label="Adapter" value={agent.adapterType} />
        <Row label="Model" value={agent.model ?? "Not recorded"} />
        <Row label="Host" value={agent.host ?? "Not recorded"} />
        <Row
          label="Current task"
          value={
            agent.currentIssue ? (
              <WorkforceHref href={agent.currentIssue.href}>
                {agent.currentIssue.identifier ? `${agent.currentIssue.identifier} · ` : ""}
                {agent.currentIssue.title}
              </WorkforceHref>
            ) : (
              "None recorded"
            )
          }
        />
        <Row
          label="Run"
          value={
            agent.currentRun ? (
              <WorkforceHref href={agent.currentRun.href}>{agent.currentRun.status}</WorkforceHref>
            ) : (
              "None recorded"
            )
          }
        />
        <Row label="Outcome" value={agent.outcomeNote} />
        <Row
          label="Last activity"
          value={agent.lastActivityAt ? `${formatWorkforceTimestamp(agent.lastActivityAt)} · ${agent.lastActivitySource}` : agent.lastActivitySource}
        />
        <Row label="Reasons" value={agent.reasons.length > 0 ? agent.reasons.join(" · ") : "None recorded"} />
      </dl>
    </article>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
      <dt className="text-muted-foreground sm:w-44">{label}</dt>
      <dd className="min-w-0">{value}</dd>
    </div>
  );
}

function ConnectionChip({ connection }: { connection: WorkforceConnection }) {
  const label = connection === "live" ? "Connected" : connection === "stale" ? "Stale" : "Disconnected";
  return (
    <span className="rounded-lg border bg-card px-2 py-0.5 text-xs font-medium text-foreground" data-testid="workforce-connection">
      {label}
    </span>
  );
}

function WorkforceHref({ href, children }: { href: string; children: ReactNode }) {
  const className = "text-primary hover:underline";
  if (href.startsWith("/api/") || href.startsWith("https://")) {
    return (
      <a
        href={href}
        className={className}
        {...(href.startsWith("https://") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </a>
    );
  }
  return (
    <Link to={href} className={className}>
      {children}
    </Link>
  );
}
