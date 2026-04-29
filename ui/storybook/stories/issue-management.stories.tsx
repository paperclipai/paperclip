import { useEffect, useMemo, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Issue } from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownAZ,
  ArrowUpDown,
  Check,
  Columns3,
  Filter,
  GitBranch,
  LayoutList,
  Link2,
  PanelRight,
  Rows3,
} from "lucide-react";
import { IssueColumnPicker, InboxIssueMetaLeading, InboxIssueTrailingColumns } from "@/components/IssueColumns";
import { IssueContinuationHandoff } from "@/components/IssueContinuationHandoff";
import { IssueDocumentsSection } from "@/components/IssueDocumentsSection";
import { IssueFiltersPopover } from "@/components/IssueFiltersPopover";
import { IssueGroupHeader } from "@/components/IssueGroupHeader";
import { IssueLinkQuicklook, IssueQuicklookCard } from "@/components/IssueLinkQuicklook";
import { IssueProperties } from "@/components/IssueProperties";
import { IssueRunLedgerContent } from "@/components/IssueRunLedger";
import { IssuesList } from "@/components/IssuesList";
import { IssuesQuicklook } from "@/components/IssuesQuicklook";
import { IssueWorkspaceCard } from "@/components/IssueWorkspaceCard";
import { Identity } from "@/components/Identity";
import { PriorityIcon } from "@/components/PriorityIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { countActiveIssueFilters, defaultIssueFilterState, type IssueFilterState } from "@/lib/issue-filters";
import { DEFAULT_INBOX_ISSUE_COLUMNS, type InboxIssueColumn } from "@/lib/inbox";
import { queryKeys } from "@/lib/queryKeys";
import {
  storybookAgentMap,
  storybookAgents,
  storybookAuthSession,
  storybookCompanies,
  storybookContinuationHandoff,
  storybookExecutionWorkspaces,
  storybookIssueDocuments,
  storybookIssueLabels,
  storybookIssueRuns,
  storybookIssues,
  storybookProjects,
} from "../fixtures/paperclipData";

const companyId = "company-storybook";
const issueListViewKey = "storybook:issue-management:list";
const scopedIssueListViewKey = `${issueListViewKey}:${companyId}`;
const visibleColumns: InboxIssueColumn[] = ["status", "id", "assignee", "project", "workspace", "labels", "updated"];

const issueDocumentSummaries = storybookIssueDocuments.map(({ body: _body, ...summary }) => summary);
const primaryIssue: Issue = {
  ...storybookIssues[0]!,
  planDocument: storybookIssueDocuments.find((document) => document.key === "plan") ?? null,
  documentSummaries: issueDocumentSummaries,
  currentExecutionWorkspace: storybookExecutionWorkspaces[0]!,
};
const childIssues = storybookIssues.filter((issue) => issue.parentId === primaryIssue.id);

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="paperclip-story__frame overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="paperclip-story__label">{eyebrow}</div>
        <h2 className="mt-1 text-xl font-semibold">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function hydrateStorybookQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.setQueryData(queryKeys.companies.all, storybookCompanies);
  queryClient.setQueryData(queryKeys.auth.session, storybookAuthSession);
  queryClient.setQueryData(queryKeys.agents.list(companyId), storybookAgents);
  queryClient.setQueryData(queryKeys.projects.list(companyId), storybookProjects);
  queryClient.setQueryData(queryKeys.issues.list(companyId), storybookIssues);
  queryClient.setQueryData(queryKeys.issues.labels(companyId), storybookIssueLabels);
  queryClient.setQueryData(queryKeys.issues.documents(primaryIssue.id), storybookIssueDocuments);
  queryClient.setQueryData(queryKeys.issues.runs(primaryIssue.id), storybookIssueRuns);
  queryClient.setQueryData(queryKeys.issues.liveRuns(primaryIssue.id), []);
  queryClient.setQueryData(queryKeys.issues.activeRun(primaryIssue.id), null);
  queryClient.setQueryData(queryKeys.instance.experimentalSettings, {
    enableIsolatedWorkspaces: true,
    enableRoutineTriggers: true,
  });
  queryClient.setQueryData(queryKeys.access.companyUserDirectory(companyId), {
    users: [
      {
        principalId: "user-board",
        status: "active",
        user: {
          id: "user-board",
          email: "riley@paperclip.local",
          name: "Riley Board",
          image: null,
        },
      },
    ],
  });
  queryClient.setQueryData(
    queryKeys.sidebarPreferences.projectOrder(companyId, storybookAuthSession.user.id),
    { orderedIds: storybookProjects.map((project) => project.id), updatedAt: null },
  );
  queryClient.setQueryData(
    queryKeys.executionWorkspaces.summaryList(companyId),
    storybookExecutionWorkspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      mode: workspace.mode,
      projectWorkspaceId: workspace.projectWorkspaceId,
    })),
  );
  queryClient.setQueryData(
    queryKeys.executionWorkspaces.list(companyId, {
      projectId: primaryIssue.projectId ?? undefined,
      projectWorkspaceId: primaryIssue.projectWorkspaceId ?? undefined,
      reuseEligible: true,
    }),
    storybookExecutionWorkspaces,
  );
}

function seedIssueListLocalStorage() {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    scopedIssueListViewKey,
    JSON.stringify({
      ...defaultIssueFilterState,
      sortField: "priority",
      sortDir: "desc",
      groupBy: "status",
      viewMode: "list",
      nestingEnabled: true,
      collapsedGroups: [],
      collapsedParents: [],
    }),
  );
  window.localStorage.setItem(`${scopedIssueListViewKey}:issue-columns`, JSON.stringify(visibleColumns));
}

function StorybookData({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [ready] = useState(() => {
    hydrateStorybookQueries(queryClient);
    seedIssueListLocalStorage();
    return true;
  });

  return ready ? children : null;
}

function ColumnConfigurationMatrix() {
  const [columns, setColumns] = useState<InboxIssueColumn[]>(visibleColumns);
  const visibleColumnSet = useMemo(() => new Set(columns), [columns]);
  const triggerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      triggerRef.current?.querySelector("button")?.click();
    }, 150);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="overflow-hidden rounded-lg border border-border bg-background/70">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)] items-center border-b border-border px-4 py-2 text-[11px] font-semibold uppercase text-muted-foreground">
          <span>Issue</span>
          <span className="grid grid-cols-[6rem_7rem_9rem_6rem_4.5rem] gap-2">
            <span>Assignee</span>
            <span>Project</span>
            <span>Workspace</span>
            <span>Tags</span>
            <span className="text-right">Updated</span>
          </span>
        </div>
        {storybookIssues.slice(0, 3).map((issue) => (
          <div key={issue.id} className="grid grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)] items-center border-b border-border/60 px-4 py-3 last:border-b-0">
            <div className="flex min-w-0 items-center gap-2">
              <InboxIssueMetaLeading
                issue={issue}
                isLive={issue.id === primaryIssue.id}
                showStatus={visibleColumnSet.has("status")}
                showIdentifier={visibleColumnSet.has("id")}
              />
              <span className="truncate text-sm font-medium">{issue.title}</span>
            </div>
            <InboxIssueTrailingColumns
              issue={issue}
              columns={columns.filter((column) => !["status", "id"].includes(column))}
              projectName={storybookProjects.find((project) => project.id === issue.projectId)?.name ?? null}
              projectColor={storybookProjects.find((project) => project.id === issue.projectId)?.color ?? null}
              workspaceId={issue.projectWorkspaceId ?? issue.executionWorkspaceId}
              workspaceName={issue.currentExecutionWorkspace?.name ?? "Board UI"}
              assigneeName={issue.assigneeAgentId ? storybookAgentMap.get(issue.assigneeAgentId)?.name ?? null : null}
              assigneeUserName={issue.assigneeUserId ? "Riley Board" : null}
              currentUserId="user-board"
              parentIdentifier={storybookIssues.find((candidate) => candidate.id === issue.parentId)?.identifier ?? null}
              parentTitle={storybookIssues.find((candidate) => candidate.id === issue.parentId)?.title ?? null}
            />
          </div>
        ))}
      </div>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Columns3 className="h-4 w-4" />
            Column configuration
          </CardTitle>
          <CardDescription>Open picker plus sort state tokens used beside issue rows.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div ref={triggerRef}>
            <IssueColumnPicker
              availableColumns={["status", "id", "assignee", "project", "workspace", "parent", "labels", "updated"]}
              visibleColumnSet={visibleColumnSet}
              onToggleColumn={(column, enabled) => {
                setColumns((current) => {
                  const next = enabled ? [...current, column] : current.filter((value) => value !== column);
                  return DEFAULT_INBOX_ISSUE_COLUMNS.filter((candidate) => next.includes(candidate)).concat(
                    next.filter((candidate) => !DEFAULT_INBOX_ISSUE_COLUMNS.includes(candidate)),
                  );
                });
              }}
              onResetColumns={() => setColumns(DEFAULT_INBOX_ISSUE_COLUMNS)}
              title="Choose which issue columns stay visible"
            />
          </div>
          <div className="space-y-2">
            {[
              { label: "Priority", icon: ArrowUpDown, state: "descending" },
              { label: "Title", icon: ArrowDownAZ, state: "ascending" },
              { label: "Updated", icon: Check, state: "active default" },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.label} className="flex items-center justify-between rounded-md border border-border bg-background/70 px-3 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    {item.label}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.state}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function GroupHeaderMatrix() {
  const rows = [
    { label: "In progress", trailing: "1 issue", badge: <StatusBadge status="in_progress" /> },
    { label: "High priority", trailing: "3 issues", badge: <PriorityIcon priority="high" showLabel /> },
    { label: "CodexCoder", trailing: "3 assigned", badge: <Identity name="CodexCoder" size="sm" /> },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {rows.map((row, index) => (
        <div key={row.label} className="rounded-lg border border-border bg-background/70 p-2">
          <IssueGroupHeader
            label={row.label}
            collapsible
            collapsed={index === 1}
            trailing={<span className="text-xs text-muted-foreground">{row.trailing}</span>}
          />
          <div className="border-t border-border px-3 py-4">{row.badge}</div>
        </div>
      ))}
    </div>
  );
}

function OpenFiltersPopover() {
  const [state, setState] = useState<IssueFilterState>({
    ...defaultIssueFilterState,
    statuses: ["in_progress", "blocked", "in_review"],
    priorities: ["critical", "high"],
    assignees: ["agent-codex", "agent-qa", "__unassigned"],
  });
  const triggerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      triggerRef.current?.querySelector("button")?.click();
    }, 150);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-[500px] items-start justify-end rounded-lg border border-dashed border-border bg-background/60 p-4">
      <div ref={triggerRef}>
        <IssueFiltersPopover
          state={state}
          onChange={(patch) => setState((current) => ({ ...current, ...patch }))}
          activeFilterCount={countActiveIssueFilters(state, true)}
          agents={storybookAgents.map((agent) => ({ id: agent.id, name: agent.name }))}
          projects={storybookProjects.map((project) => ({ id: project.id, name: project.name }))}
          labels={storybookIssueLabels.map((label) => ({ id: label.id, name: label.name, color: label.color }))}
          currentUserId="user-board"
          enableRoutineVisibilityFilter
          buttonVariant="outline"
          workspaces={storybookExecutionWorkspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }))}
          creators={[
            { id: "user:user-board", label: "Riley Board", kind: "user", searchText: "board user human" },
            ...storybookAgents.map((agent) => ({
              id: `agent:${agent.id}`,
              label: agent.name,
              kind: "agent" as const,
              searchText: `${agent.name} ${agent.role}`,
            })),
          ]}
        />
      </div>
    </div>
  );
}

function RunLedgerWithCostColumns() {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <IssueRunLedgerContent
        runs={storybookIssueRuns}
        activeRun={null}
        liveRuns={[]}
        issueStatus={primaryIssue.status}
        childIssues={childIssues}
        agentMap={storybookAgentMap}
      />
      <div className="overflow-hidden rounded-lg border border-border bg-background/70">
        <div className="grid grid-cols-[1fr_90px_80px_70px] gap-2 border-b border-border px-3 py-2 text-[11px] font-semibold uppercase text-muted-foreground">
          <span>Run</span>
          <span>Status</span>
          <span>Duration</span>
          <span className="text-right">Cost</span>
        </div>
        {storybookIssueRuns.map((run) => {
          const start = run.startedAt ? new Date(run.startedAt).getTime() : null;
          const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
          const minutes = start ? Math.max(1, Math.round((end - start) / 60_000)) : null;
          const costCents = typeof run.usageJson?.costCents === "number" ? run.usageJson.costCents : 0;
          return (
            <div key={run.runId} className="grid grid-cols-[1fr_90px_80px_70px] gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-b-0">
              <span className="min-w-0 truncate font-mono">{run.runId}</span>
              <span className="capitalize text-muted-foreground">{run.status}</span>
              <span className="text-muted-foreground">{minutes ? `${minutes}m` : "unknown"}</span>
              <span className="text-right font-mono">${(costCents / 100).toFixed(2)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WorkspaceCardWithRuntime() {
  const service = primaryIssue.currentExecutionWorkspace?.runtimeServices?.[0] ?? null;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <IssueWorkspaceCard
        issue={primaryIssue}
        project={storybookProjects[0]!}
        onUpdate={() => undefined}
      />
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Runtime status
          </CardTitle>
          <CardDescription>Branch, path, and running service context paired with the workspace card.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Branch</span>
            <span className="truncate font-mono text-xs">{primaryIssue.currentExecutionWorkspace?.branchName}</span>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">Path</span>
            <div className="break-all rounded-md border border-border bg-background/70 p-2 font-mono text-xs">
              {primaryIssue.currentExecutionWorkspace?.cwd}
            </div>
          </div>
          {service ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/70 px-3 py-2">
              <span>{service.serviceName}</span>
              <Badge variant="outline">{service.status}</Badge>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function QuicklookSurfaces() {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="rounded-lg border border-border bg-background/70 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          IssueLinkQuicklook
        </div>
        <IssueLinkQuicklook
          issuePathId={primaryIssue.identifier ?? primaryIssue.id}
          issuePrefetch={primaryIssue}
          to={`/PAP/issues/${primaryIssue.identifier}`}
          className="font-mono text-sm text-primary hover:underline"
        >
          {primaryIssue.identifier}
        </IssueLinkQuicklook>
        <div className="mt-4 rounded-md border border-border bg-popover p-3 shadow-xl">
          <IssueQuicklookCard
            issue={primaryIssue}
            linkTo={`/PAP/issues/${primaryIssue.identifier}`}
            compact
          />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-background/70 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <PanelRight className="h-4 w-4 text-muted-foreground" />
          IssuesQuicklook
        </div>
        <IssuesQuicklook issue={storybookIssues[2]!}>
          <Button variant="outline" size="sm">Hover preview trigger</Button>
        </IssuesQuicklook>
        <div className="mt-4 rounded-md border border-border bg-card p-3">
          <IssueQuicklookCard
            issue={storybookIssues[2]!}
            linkTo={`/PAP/issues/${storybookIssues[2]!.identifier}`}
          />
        </div>
      </div>
    </div>
  );
}

function IssueManagementStories() {
  return (
    <StorybookData>
      <div className="paperclip-story">
        <main className="paperclip-story__inner space-y-6">
          <section className="paperclip-story__frame p-6">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div>
                <div className="paperclip-story__label">Issue management</div>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight">List, detail, filters, runs, and workspace states</h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                  Fixture-backed issue management stories cover the operational states used by the board when reviewing,
                  filtering, handing off, and continuing agent work.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">7 issues</Badge>
                <Badge variant="outline">3 agents</Badge>
                <Badge variant="outline">workspace aware</Badge>
              </div>
            </div>
          </section>

          <Section eyebrow="IssuesList" title="Full list view with grouped issue rows and column headers">
            <div className="mb-3 grid grid-cols-[minmax(0,1fr)_120px_120px_110px] gap-3 rounded-lg border border-border bg-background/70 px-4 py-2 text-[11px] font-semibold uppercase text-muted-foreground">
              <span>Issue</span>
              <span>Assignee</span>
              <span>Workspace</span>
              <span className="text-right">Updated</span>
            </div>
            <IssuesList
              issues={storybookIssues}
              agents={storybookAgents}
              projects={storybookProjects}
              liveIssueIds={new Set([primaryIssue.id])}
              viewStateKey={issueListViewKey}
              onUpdateIssue={() => undefined}
              createIssueLabel="issue"
              enableRoutineVisibilityFilter
            />
          </Section>

          <Section eyebrow="IssueColumns" title="Column configuration and sorting states">
            <ColumnConfigurationMatrix />
          </Section>

          <Section eyebrow="IssueGroupHeader" title="Grouped by status, priority, and assignee">
            <GroupHeaderMatrix />
          </Section>

          <Section eyebrow="IssueProperties" title="Full issue detail sidebar with all property fields">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
              <div className="space-y-4 rounded-lg border border-border bg-background/70 p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={primaryIssue.status} />
                  <PriorityIcon priority={primaryIssue.priority} showLabel />
                  <Badge variant="secondary">{primaryIssue.identifier}</Badge>
                </div>
                <h3 className="text-2xl font-semibold tracking-tight">{primaryIssue.title}</h3>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{primaryIssue.description}</p>
              </div>
              <div className="rounded-lg border border-border bg-background/70 p-4">
                <IssueProperties
                  issue={primaryIssue}
                  childIssues={childIssues}
                  onAddSubIssue={() => undefined}
                  onUpdate={() => undefined}
                  inline
                />
              </div>
            </div>
          </Section>

          <Section eyebrow="IssueDocumentsSection" title="Documents list with plan and notes documents">
            <IssueDocumentsSection
              issue={primaryIssue}
              canDeleteDocuments
              feedbackDataSharingPreference="allowed"
            />
          </Section>

          <Section eyebrow="IssueFiltersPopover" title="Open filter popover with status, priority, and assignee filters">
            <OpenFiltersPopover />
          </Section>

          <Section eyebrow="IssueContinuationHandoff" title="Expanded handoff for continuing work across runs">
            <IssueContinuationHandoff document={storybookContinuationHandoff} focusSignal={1} />
          </Section>

          <Section eyebrow="IssueRunLedger" title="Run history table with status, duration, and cost columns">
            <RunLedgerWithCostColumns />
          </Section>

          <Section eyebrow="IssueWorkspaceCard" title="Workspace info card with branch, path, and runtime status">
            <WorkspaceCardWithRuntime />
          </Section>

          <Section eyebrow="Quicklook" title="Linked issue popup and side-panel quick look">
            <QuicklookSurfaces />
          </Section>

          <section className="grid gap-4 md:grid-cols-3">
            {[
              { icon: LayoutList, label: "List density", detail: "Grouped rows keep status and ownership visible." },
              { icon: Filter, label: "Filtering", detail: "Selected filters are explicit and clearable." },
              { icon: Rows3, label: "Detail panels", detail: "Properties, documents, runs, and workspaces stay close to the task." },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <Card key={item.label} className="paperclip-story__frame shadow-none">
                  <CardHeader>
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <CardTitle>{item.label}</CardTitle>
                    <CardDescription>{item.detail}</CardDescription>
                  </CardHeader>
                </Card>
              );
            })}
          </section>
        </main>
      </div>
    </StorybookData>
  );
}

const meta = {
  title: "Product/Issue Management",
  component: IssueManagementStories,
  parameters: {
    docs: {
      description: {
        component:
          "Issue-management stories exercise the full list, column, grouping, property, document, filter, continuation, run, workspace, and quicklook surfaces.",
      },
    },
  },
} satisfies Meta<typeof IssueManagementStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FullSurfaceMatrix: Story = {};
