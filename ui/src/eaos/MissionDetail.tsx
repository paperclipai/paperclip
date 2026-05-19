// LET-467 — read-only EAOS Mission detail page mounted at
// `/<companyPrefix>/eaos/missions/:missionRef` inside `EaosShell`.
//
// Implements the LET-465 design contract thin slice: a header summarizing
// state/owner/blocker/activity/live posture, an inspector rail with mission
// properties and a Kernel/Admin escape hatch, an evidence board normalized
// across documents/work products/validation/approvals/runs/comments/tree
// events, and a replay feed merging runs/activity/comments/validation.
//
// First slice is strictly read-only — no approval decisions, deploy/release,
// service or runtime mutations, spend, secret handling, external writes, or
// social/live campaign actions. The `missionRef` parameter accepts either a
// UUID or a `LET-460`-style identifier; the resolution path is the same
// `/issues/:id` endpoint Kernel/Admin uses.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "@/lib/router";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { agentsApi } from "@/api/agents";
import { activityApi } from "@/api/activity";
import { heartbeatsApi } from "@/api/heartbeats";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { EaosStateChip } from "./EaosStateChip";
import {
  NOT_CONNECTED_DATA_LABEL,
  NOT_CONNECTED_DATA_NOTE,
  NOT_CONNECTED_DATA_PREFIX,
  SHELL_POSTURE_LABEL,
  SHELL_POSTURE_PREFIX,
} from "./state-labels";
import { describeOwner, MissionDetailHeader } from "./mission-detail/MissionDetailHeader";
import { MissionDetailInspector } from "./mission-detail/MissionDetailInspector";
import { MissionEvidenceBoard } from "./mission-detail/MissionEvidenceBoard";
import { MissionReplayFeed } from "./mission-detail/MissionReplayFeed";
import { buildEvidenceItems } from "./mission-detail/build-evidence";
import { buildReplayItems } from "./mission-detail/build-replay";

type DetailTab = "overview" | "evidence" | "replay" | "graph";

const TABS: ReadonlyArray<{ id: DetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "evidence", label: "Evidence" },
  { id: "replay", label: "Replay" },
  { id: "graph", label: "Graph & discussion" },
];

function missionListHrefFromPathname(pathname: string): string {
  const missionRoute = "/eaos/missions";
  const routeIndex = pathname.indexOf(missionRoute);
  if (routeIndex === -1) {
    return missionRoute;
  }

  const prefix = pathname.slice(0, routeIndex);
  return `${prefix}${missionRoute}`;
}

export function MissionDetail() {
  const { missionRef } = useParams<{ missionRef?: string }>();
  const { pathname } = useLocation();
  const { selectedCompanyId } = useCompany();
  const [tab, setTab] = useState<DetailTab>("overview");
  const missionListHref = missionListHrefFromPathname(pathname);

  const trimmedRef = missionRef ? missionRef.trim() : "";
  const isResolvable = trimmedRef.length > 0;

  const issueQuery = useQuery({
    queryKey: ["issues", "detail", trimmedRef.toUpperCase()],
    queryFn: () => issuesApi.get(trimmedRef),
    enabled: isResolvable,
    retry: false,
    staleTime: 15_000,
  });

  const issue = issueQuery.data ?? null;
  const issueId = issue?.id ?? null;

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "__no-company__"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const commentsQuery = useQuery({
    queryKey: issueId ? [...queryKeys.issues.comments(issueId), "eaos-detail"] : ["issues", "comments", "__none__"],
    queryFn: () => issuesApi.listComments(issueId!, { order: "desc", limit: 50 }),
    enabled: !!issueId,
    staleTime: 15_000,
  });

  const interactionsQuery = useQuery({
    queryKey: issueId ? queryKeys.issues.interactions(issueId) : ["issues", "interactions", "__none__"],
    queryFn: () => issuesApi.listInteractions(issueId!),
    enabled: !!issueId,
    staleTime: 30_000,
  });

  const documentsQuery = useQuery({
    queryKey: issueId ? queryKeys.issues.documentsWithSystem(issueId) : ["issues", "documents", "__none__"],
    queryFn: () => issuesApi.listDocuments(issueId!, { includeSystem: true }),
    enabled: !!issueId,
    staleTime: 60_000,
  });

  const validationQuery = useQuery({
    queryKey: issueId ? queryKeys.issues.validationHistory(issueId) : ["issues", "validation-history", "__none__"],
    queryFn: () => issuesApi.listValidationHistory(issueId!),
    enabled: !!issueId,
    staleTime: 30_000,
  });

  const approvalsQuery = useQuery({
    queryKey: issueId ? queryKeys.issues.approvals(issueId) : ["issues", "approvals", "__none__"],
    queryFn: () => issuesApi.listApprovals(issueId!),
    enabled: !!issueId,
    staleTime: 30_000,
  });

  const workProductsQuery = useQuery({
    queryKey: issueId ? queryKeys.issues.workProducts(issueId) : ["issues", "work-products", "__none__"],
    queryFn: () => issuesApi.listWorkProducts(issueId!),
    enabled: !!issueId,
    staleTime: 60_000,
  });

  const runsQuery = useQuery({
    queryKey: issueId ? queryKeys.issues.runs(issueId) : ["issues", "runs", "__none__"],
    queryFn: () => activityApi.runsForIssue(issueId!),
    enabled: !!issueId,
    staleTime: 30_000,
  });

  const activityQuery = useQuery({
    queryKey: issueId ? queryKeys.issues.activity(issueId) : ["issues", "activity", "__none__"],
    queryFn: () => activityApi.forIssue(issueId!),
    enabled: !!issueId,
    staleTime: 30_000,
  });

  const treeQuery = useQuery({
    queryKey: issueId ? queryKeys.issues.treeObservability(issueId) : ["issues", "tree-observability", "__none__"],
    queryFn: () => issuesApi.getTreeObservability(issueId!, { limit: 24 }),
    enabled: !!issueId,
    staleTime: 30_000,
  });

  const liveStatuses = new Set<Issue["status"]>(["in_progress", "in_review", "todo", "blocked"]);
  const isLiveCandidate = !!issue && liveStatuses.has(issue.status);
  const liveRunsQuery = useQuery({
    queryKey: issueId ? queryKeys.issues.liveRuns(issueId) : ["issues", "live-runs", "__none__"],
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId!),
    enabled: !!issueId && isLiveCandidate,
    staleTime: 5_000,
  });
  const activeRunQuery = useQuery({
    queryKey: issueId ? queryKeys.issues.activeRun(issueId) : ["issues", "active-run", "__none__"],
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId!),
    enabled: !!issueId && isLiveCandidate,
    staleTime: 5_000,
  });

  const agents = agentsQuery.data ?? [];
  const owner = useMemo(() => (issue ? describeOwner(issue, agents) : "—"), [issue, agents]);

  const evidenceItems = useMemo(
    () =>
      buildEvidenceItems({
        documents: documentsQuery.data ?? null,
        workProducts: workProductsQuery.data ?? null,
        validation: validationQuery.data ?? null,
        approvals: approvalsQuery.data ?? null,
        interactions: interactionsQuery.data ?? null,
        runs: runsQuery.data ?? null,
        liveRuns: liveRunsQuery.data ?? null,
        activeRun: activeRunQuery.data ?? null,
        comments: commentsQuery.data ?? null,
        treeObservability: treeQuery.data ?? null,
      }),
    [
      documentsQuery.data,
      workProductsQuery.data,
      validationQuery.data,
      approvalsQuery.data,
      interactionsQuery.data,
      runsQuery.data,
      liveRunsQuery.data,
      activeRunQuery.data,
      commentsQuery.data,
      treeQuery.data,
    ],
  );

  const replayItems = useMemo(
    () =>
      buildReplayItems({
        runs: runsQuery.data ?? null,
        liveRuns: liveRunsQuery.data ?? null,
        activeRun: activeRunQuery.data ?? null,
        comments: commentsQuery.data ?? null,
        documents: documentsQuery.data ?? null,
        workProducts: workProductsQuery.data ?? null,
        validation: validationQuery.data ?? null,
        approvals: approvalsQuery.data ?? null,
        interactions: interactionsQuery.data ?? null,
        activity: activityQuery.data ?? null,
        treeObservability: treeQuery.data ?? null,
      }),
    [
      runsQuery.data,
      liveRunsQuery.data,
      activeRunQuery.data,
      commentsQuery.data,
      documentsQuery.data,
      workProductsQuery.data,
      validationQuery.data,
      approvalsQuery.data,
      interactionsQuery.data,
      activityQuery.data,
      treeQuery.data,
    ],
  );

  if (!selectedCompanyId) {
    return (
      <DetailEmptyShell
        missionListHref={missionListHref}
        testId="eaos-mission-detail-no-company"
        title="No company scope selected"
        body="Select a company in the workspace switcher to load this mission."
      />
    );
  }

  if (!isResolvable) {
    return (
      <DetailEmptyShell
        missionListHref={missionListHref}
        testId="eaos-mission-detail-invalid-ref"
        title="Mission reference is missing"
        body="The route did not provide an issue identifier or UUID."
      />
    );
  }

  if (issueQuery.isLoading) {
    return <DetailLoading />;
  }

  if (issueQuery.isError || !issue) {
    return (
      <DetailNotFound
        missionListHref={missionListHref}
        missionRef={trimmedRef}
        onRetry={() => issueQuery.refetch()}
      />
    );
  }

  return (
    <article
      aria-labelledby="eaos-mission-title"
      className="flex flex-col gap-4"
      data-testid="eaos-mission-detail"
      data-mission-ref={trimmedRef}
      data-mission-id={issue.id}
    >
      <MissionDetailHeader
        issue={issue}
        owner={owner}
        liveRunCount={liveRunsQuery.data?.length ?? 0}
        hasActiveRun={!!activeRunQuery.data}
      />

      <div
        role="tablist"
        aria-label="Mission workbench tabs"
        data-testid="eaos-mission-detail-tablist"
        className="flex flex-wrap items-center gap-1.5"
      >
        {TABS.map((option) => {
          const isActive = tab === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="tab"
              id={`eaos-mission-tab-${option.id}`}
              aria-selected={isActive}
              aria-controls={`eaos-mission-panel-${option.id}`}
              tabIndex={isActive ? 0 : -1}
              data-testid={`eaos-mission-detail-tab-${option.id}`}
              onClick={() => setTab(option.id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const idx = TABS.findIndex((t) => t.id === tab);
                const delta = event.key === "ArrowLeft" ? -1 : 1;
                const next = TABS[(idx + delta + TABS.length) % TABS.length];
                if (next) setTab(next.id);
              }}
              className={
                "inline-flex items-center rounded-md border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background "
                + (isActive
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground")
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div
          className="flex flex-col gap-3 lg:col-span-8"
          role="tabpanel"
          id={`eaos-mission-panel-${tab}`}
          aria-labelledby={`eaos-mission-tab-${tab}`}
          data-testid={`eaos-mission-detail-panel-${tab}`}
        >
          {tab === "overview" ? (
            <MissionOverview
              issue={issue}
              evidenceCount={evidenceItems.length}
              replayCount={replayItems.length}
              liveRunCount={liveRunsQuery.data?.length ?? 0}
              hasActiveRun={!!activeRunQuery.data}
              owner={owner}
            />
          ) : null}

          {tab === "evidence" ? <MissionEvidenceBoard items={evidenceItems} /> : null}

          {tab === "replay" ? <MissionReplayFeed items={replayItems} /> : null}

          {tab === "graph" ? (
            <MissionGraphAndDiscussion
              issue={issue}
              comments={commentsQuery.data ?? []}
              treeEventCount={treeQuery.data?.timeline.length ?? 0}
              hasTreeData={!!treeQuery.data}
            />
          ) : null}
        </div>

        <div className="lg:col-span-4">
          <MissionDetailInspector
            issue={issue}
            owner={owner}
            approvals={approvalsQuery.data ?? []}
            activeRun={activeRunQuery.data ?? null}
            liveRuns={liveRunsQuery.data ?? []}
          />
        </div>
      </div>
    </article>
  );
}

function MissionOverview({
  issue,
  evidenceCount,
  replayCount,
  liveRunCount,
  hasActiveRun,
  owner,
}: {
  issue: Issue;
  evidenceCount: number;
  replayCount: number;
  liveRunCount: number;
  hasActiveRun: boolean;
  owner: string;
}) {
  return (
    <section
      aria-labelledby="eaos-mission-overview-title"
      data-testid="eaos-mission-overview"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 id="eaos-mission-overview-title" className="text-base font-semibold tracking-tight text-foreground">
          Overview
        </h2>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Mission command summary
        </p>
      </header>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
        <OverviewItem label="Status" value={issue.status} />
        <OverviewItem label="Owner" value={owner} />
        <OverviewItem label="Priority" value={issue.priority} />
        <OverviewItem
          label="Live run"
          value={hasActiveRun ? "Active run in progress" : liveRunCount > 0 ? `${liveRunCount} live` : "None"}
        />
        <OverviewItem
          label="Blockers"
          value={
            !issue.blockerAttention || issue.blockerAttention.unresolvedBlockerCount === 0
              ? "None"
              : `${issue.blockerAttention.unresolvedBlockerCount} unresolved`
          }
        />
        <OverviewItem label="Evidence collected" value={String(evidenceCount)} />
        <OverviewItem label="Replay events" value={String(replayCount)} />
        <OverviewItem
          label="Last activity"
          value={issue.lastActivityAt ? new Date(issue.lastActivityAt as unknown as string).toISOString().slice(0, 16) + " UTC" : "—"}
        />
      </dl>
      {issue.description ? (
        <details className="rounded-md border border-border bg-background p-3 text-xs">
          <summary className="cursor-pointer text-xs font-medium text-foreground">Mission description</summary>
          <p className="mt-2 whitespace-pre-line text-xs text-foreground">{issue.description}</p>
        </details>
      ) : null}
    </section>
  );
}

function OverviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-xs text-foreground">{value}</dd>
    </div>
  );
}

function MissionGraphAndDiscussion({
  issue,
  comments,
  treeEventCount,
  hasTreeData,
}: {
  issue: Issue;
  comments: ReadonlyArray<{ id: string }>;
  treeEventCount: number;
  hasTreeData: boolean;
}) {
  const blockerCount = issue.blockerAttention?.unresolvedBlockerCount ?? 0;
  const childCount = issue.relatedWork?.outbound?.length ?? 0;
  return (
    <section
      aria-labelledby="eaos-mission-graph-title"
      data-testid="eaos-mission-graph"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="eaos-mission-graph-title" className="text-base font-semibold tracking-tight text-foreground">
          Graph & discussion
        </h2>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Tree, blockers, related work, comments
        </p>
      </header>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        <OverviewItem label="Unresolved blockers" value={String(blockerCount)} />
        <OverviewItem label="Related work links" value={String(childCount)} />
        <OverviewItem
          label="Tree events"
          value={hasTreeData ? String(treeEventCount) : "—"}
        />
      </dl>
      <p className="text-xs text-muted-foreground">
        Comments and discussion are read-only in this slice. The full conversation composer and
        write surfaces remain in Kernel/Admin until EAOS comment-write UX is explicitly designed.
      </p>
      <p
        className="text-xs text-foreground"
        data-testid="eaos-mission-graph-comment-count"
      >
        {comments.length === 0
          ? "No discussion entries yet."
          : `${comments.length} comment${comments.length === 1 ? "" : "s"} recorded.`}
      </p>
    </section>
  );
}

function DetailLoading() {
  return (
    <section
      aria-labelledby="eaos-mission-detail-loading-title"
      className="flex flex-col gap-3"
      data-testid="eaos-mission-detail-loading"
    >
      <div className="flex flex-wrap items-center gap-2">
        <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
        <EaosStateChip
          label={NOT_CONNECTED_DATA_LABEL}
          prefix={NOT_CONNECTED_DATA_PREFIX}
          title={NOT_CONNECTED_DATA_NOTE}
        />
      </div>
      <h1
        id="eaos-mission-detail-loading-title"
        className="text-2xl font-semibold tracking-tight text-foreground"
      >
        Mission detail
      </h1>
      <div
        role="status"
        aria-live="polite"
        className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
      >
        Loading mission details…
      </div>
    </section>
  );
}

function DetailEmptyShell({
  title,
  body,
  testId,
  missionListHref,
}: {
  title: string;
  body: string;
  testId: string;
  missionListHref: string;
}) {
  return (
    <section
      aria-labelledby="eaos-mission-detail-empty-title"
      className="flex flex-col gap-3"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center gap-2">
        <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
        <EaosStateChip
          label={NOT_CONNECTED_DATA_LABEL}
          prefix={NOT_CONNECTED_DATA_PREFIX}
          title={NOT_CONNECTED_DATA_NOTE}
        />
      </div>
      <h1
        id="eaos-mission-detail-empty-title"
        className="text-2xl font-semibold tracking-tight text-foreground"
      >
        {title}
      </h1>
      <p className="max-w-2xl text-sm text-muted-foreground">{body}</p>
      <p className="text-xs text-muted-foreground">
        <Link
          to={missionListHref}
          data-testid="eaos-mission-detail-back-to-missions"
          className="underline-offset-2 hover:underline"
        >
          Back to mission list
        </Link>
      </p>
    </section>
  );
}

function DetailNotFound({
  missionRef,
  missionListHref,
  onRetry,
}: {
  missionRef: string;
  missionListHref: string;
  onRetry: () => void;
}) {
  return (
    <section
      aria-labelledby="eaos-mission-detail-not-found-title"
      data-testid="eaos-mission-detail-not-found"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
        <EaosStateChip
          label={NOT_CONNECTED_DATA_LABEL}
          prefix={NOT_CONNECTED_DATA_PREFIX}
          title={NOT_CONNECTED_DATA_NOTE}
        />
      </div>
      <h1
        id="eaos-mission-detail-not-found-title"
        className="text-2xl font-semibold tracking-tight text-foreground"
      >
        Mission not found
      </h1>
      <p className="max-w-2xl text-sm text-muted-foreground">
        We could not load <span className="font-mono">{missionRef}</span> in the current company
        scope. The mission may be hidden, may not exist, or the data layer may be unreachable.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          data-testid="eaos-mission-detail-not-found-retry"
          className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Retry
        </button>
        <Link
          to={missionListHref}
          data-testid="eaos-mission-detail-not-found-back"
          className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Back to missions
        </Link>
        <Link
          to={`/issues/${missionRef}`}
          data-testid="eaos-mission-detail-not-found-kernel"
          className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Try Kernel/Admin view
        </Link>
      </div>
    </section>
  );
}
