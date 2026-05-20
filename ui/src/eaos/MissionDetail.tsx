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
import { describeOwner, MissionDetailHeader } from "./mission-detail/MissionDetailHeader";
import { MissionDetailInspector } from "./mission-detail/MissionDetailInspector";
import { MissionEvidenceBoard } from "./mission-detail/MissionEvidenceBoard";
import { MissionReplayFeed } from "./mission-detail/MissionReplayFeed";
import { buildEvidenceItems } from "./mission-detail/build-evidence";
import { buildReplayItems } from "./mission-detail/build-replay";
import { safeDisplayText } from "./secret-redact";

// LET-503 round-5 — Mission detail is a Linear-style document workbench.
// The page is split into a primary document column (description + activity
// + evidence) and a right-hand properties rail (MissionDetailInspector).
// The 4-tab strip from LET-467 is replaced by a single scrollable document
// with collapsible activity/evidence sections so the surface reads as a
// task page, not a dashboard.

function missionListHrefFromPathname(pathname: string): string {
  const missionRoute = "/eaos/missions";
  const routeIndex = pathname.indexOf(missionRoute);
  if (routeIndex === -1) {
    return missionRoute;
  }

  const prefix = pathname.slice(0, routeIndex);
  return `${prefix}${missionRoute}`;
}

type SecondaryPanel = "activity" | "evidence" | "discussion";

export function MissionDetail() {
  const { missionRef } = useParams<{ missionRef?: string }>();
  const { pathname } = useLocation();
  const { selectedCompanyId } = useCompany();
  const [panel, setPanel] = useState<SecondaryPanel>("activity");
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div
          className="flex min-w-0 flex-col gap-4 lg:col-span-8"
          data-testid="eaos-mission-detail-document"
        >
          <MissionDocument issue={issue} />
          <SecondaryPanelSwitch
            panel={panel}
            onChange={setPanel}
            counts={{
              activity: replayItems.length,
              evidence: evidenceItems.length,
              discussion: commentsQuery.data?.length ?? 0,
            }}
          />
          {panel === "activity" ? <MissionReplayFeed items={replayItems} /> : null}
          {panel === "evidence" ? <MissionEvidenceBoard items={evidenceItems} /> : null}
          {panel === "discussion" ? (
            <MissionDiscussion
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

function MissionDocument({ issue }: { issue: Issue }) {
  const description = issue.description ? safeDisplayText(issue.description, 4000) : null;
  const safeTitle = safeDisplayText(issue.title, 240);
  return (
    <section
      aria-labelledby="eaos-mission-document-title"
      data-testid="eaos-mission-document"
      className="flex flex-col gap-3 rounded-md border border-border bg-card px-5 py-4"
    >
      <header className="flex flex-col gap-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Mission</p>
        <h2
          id="eaos-mission-document-title"
          className="text-lg font-semibold tracking-tight text-foreground"
        >
          {safeTitle}
        </h2>
      </header>
      {description ? (
        <p
          className="whitespace-pre-line text-sm leading-relaxed text-foreground/90"
          data-testid="eaos-mission-document-description"
        >
          {description}
        </p>
      ) : (
        <p
          data-testid="eaos-mission-document-description-empty"
          className="rounded border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground"
        >
          No description on this mission yet.
        </p>
      )}
    </section>
  );
}

function SecondaryPanelSwitch({
  panel,
  onChange,
  counts,
}: {
  panel: SecondaryPanel;
  onChange: (next: SecondaryPanel) => void;
  counts: { activity: number; evidence: number; discussion: number };
}) {
  const options: Array<{ id: SecondaryPanel; label: string; count: number }> = [
    { id: "activity", label: "Activity", count: counts.activity },
    { id: "evidence", label: "Evidence", count: counts.evidence },
    { id: "discussion", label: "Discussion", count: counts.discussion },
  ];
  return (
    <div
      role="tablist"
      aria-label="Mission activity sections"
      data-testid="eaos-mission-detail-secondary-tablist"
      className="inline-flex items-center self-start rounded-md border border-border bg-card p-0.5 text-xs"
    >
      {options.map((option) => {
        const selected = panel === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={selected}
            data-testid={`eaos-mission-detail-section-${option.id}`}
            onClick={() => onChange(option.id)}
            className={
              "inline-flex items-center gap-1.5 rounded px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
              (selected
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground")
            }
          >
            <span>{option.label}</span>
            <span
              className={
                "rounded px-1 text-[10px] tabular-nums " +
                (selected ? "bg-background/20 text-background" : "bg-muted text-muted-foreground")
              }
            >
              {option.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MissionDiscussion({
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
      aria-labelledby="eaos-mission-discussion-title"
      data-testid="eaos-mission-discussion"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="eaos-mission-discussion-title"
          className="text-sm font-semibold tracking-tight text-foreground"
        >
          Discussion
        </h2>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {comments.length} comment{comments.length === 1 ? "" : "s"}
        </span>
      </header>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-3">
        <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-start">
          <dt>Unresolved blockers</dt>
          <dd className="text-foreground tabular-nums">{blockerCount}</dd>
        </div>
        <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-start">
          <dt>Related work</dt>
          <dd className="text-foreground tabular-nums">{childCount}</dd>
        </div>
        <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-start">
          <dt>Tree events</dt>
          <dd className="text-foreground tabular-nums">{hasTreeData ? treeEventCount : "—"}</dd>
        </div>
      </dl>
      <p
        className="text-xs text-foreground"
        data-testid="eaos-mission-discussion-comment-count"
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
