import { useEffect, useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HeartbeatRun, Issue } from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Bot,
  CheckCircle2,
  Clock3,
  FileCode2,
  FolderKanban,
  ListFilter,
  Loader2,
  Play,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  ChartCard,
  IssueStatusChart,
  PriorityChart,
  RunActivityChart,
  SuccessRateChart,
} from "@/components/ActivityCharts";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { EntityRow } from "@/components/EntityRow";
import { FilterBar, type FilterValue } from "@/components/FilterBar";
import { KanbanBoard } from "@/components/KanbanBoard";
import { LiveRunWidget } from "@/components/LiveRunWidget";
import { OnboardingWizard } from "@/components/OnboardingWizard";
import {
  buildFileTree,
  collectAllPaths,
  countFiles,
  PackageFileTree,
  parseFrontmatter,
  type FileTreeNode,
} from "@/components/PackageFileTree";
import { PageSkeleton } from "@/components/PageSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { SwipeToArchive } from "@/components/SwipeToArchive";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDialog } from "@/context/DialogContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  createIssue,
  storybookAgents,
  storybookIssues,
  storybookLiveRuns,
} from "../fixtures/paperclipData";

const companyId = "company-storybook";
const primaryIssueId = "issue-storybook-1";

function StoryShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">{children}</main>
    </div>
  );
}

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

function daysAgo(days: number, hour = 12): Date {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date;
}

function makeHeartbeatRun(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  const createdAt = overrides.createdAt ?? daysAgo(1);
  const run: HeartbeatRun = {
    id: "run-fixture",
    companyId,
    agentId: "agent-codex",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "succeeded",
    startedAt: createdAt,
    finishedAt: new Date(createdAt.getTime() + 11 * 60_000),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: 0,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processGroupId: null,
    processStartedAt: createdAt,
    retryOfRunId: null,
    processLossRetryCount: 0,
    scheduledRetryAt: null,
    scheduledRetryAttempt: 0,
    scheduledRetryReason: null,
    retryExhaustedReason: null,
    livenessState: "completed",
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: null,
    contextSnapshot: null,
    ...overrides,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
  };
  return run;
}

const activityRuns: HeartbeatRun[] = [
  makeHeartbeatRun({ id: "run-chart-1", status: "succeeded", createdAt: daysAgo(13), startedAt: daysAgo(13) }),
  makeHeartbeatRun({ id: "run-chart-2", status: "succeeded", createdAt: daysAgo(10), startedAt: daysAgo(10) }),
  makeHeartbeatRun({ id: "run-chart-3", status: "failed", createdAt: daysAgo(10), startedAt: daysAgo(10, 15), exitCode: 1 }),
  makeHeartbeatRun({ id: "run-chart-4", status: "running", createdAt: daysAgo(7), startedAt: daysAgo(7), finishedAt: null }),
  makeHeartbeatRun({ id: "run-chart-5", status: "succeeded", createdAt: daysAgo(5), startedAt: daysAgo(5) }),
  makeHeartbeatRun({ id: "run-chart-6", status: "timed_out", createdAt: daysAgo(3), startedAt: daysAgo(3), errorCode: "timeout" }),
  makeHeartbeatRun({ id: "run-chart-7", status: "succeeded", createdAt: daysAgo(1), startedAt: daysAgo(1) }),
  makeHeartbeatRun({ id: "run-chart-8", status: "succeeded", createdAt: daysAgo(1, 16), startedAt: daysAgo(1, 16) }),
];

const activityIssues = [
  { priority: "high", status: "in_progress", createdAt: daysAgo(13) },
  { priority: "critical", status: "blocked", createdAt: daysAgo(11) },
  { priority: "medium", status: "todo", createdAt: daysAgo(9) },
  { priority: "medium", status: "in_review", createdAt: daysAgo(9, 16) },
  { priority: "low", status: "done", createdAt: daysAgo(6) },
  { priority: "high", status: "todo", createdAt: daysAgo(4) },
  { priority: "critical", status: "in_progress", createdAt: daysAgo(2) },
  { priority: "medium", status: "done", createdAt: daysAgo(1) },
];

const kanbanIssues: Issue[] = [
  ...storybookIssues,
  createIssue({
    id: "issue-kanban-backlog",
    identifier: "PAP-1701",
    issueNumber: 1701,
    title: "Sketch company analytics dashboard",
    status: "backlog",
    priority: "low",
    assigneeAgentId: "agent-cto",
  }),
  createIssue({
    id: "issue-kanban-cancelled",
    identifier: "PAP-1702",
    issueNumber: 1702,
    title: "Remove obsolete color token migration",
    status: "cancelled",
    priority: "medium",
    assigneeAgentId: null,
  }),
];

const packageFiles: Record<string, string> = {
  "COMPANY.md": "---\nname: Paperclip Storybook\nkind: company\n---\nFixture company package for UI review.",
  "agents/codexcoder/AGENTS.md": "---\nname: CodexCoder\nskills:\n  - frontend-design\n  - paperclip\n---\nShips product UI and verifies changes.",
  "agents/qachecker/AGENTS.md": "---\nname: QAChecker\nskills:\n  - web-design-guidelines\n---\nReviews browser behavior and acceptance criteria.",
  "projects/board-ui/PROJECT.md": "---\ntitle: Board UI\nstatus: in_progress\n---\nStorybook and operator control-plane surfaces.",
  "tasks/PAP-1641.md": "---\ntitle: Create super-detailed storybooks\npriority: high\n---\nParent issue for Storybook coverage.",
  "tasks/PAP-1677.md": "---\ntitle: Data Visualization & Misc stories\npriority: medium\n---\nFixture task for this story file.",
  "skills/frontend-design/SKILL.md": "---\nname: frontend-design\n---\nDesign quality guidance.",
};

const actionMap = new Map([
  ["COMPANY.md", "replace"],
  ["agents/codexcoder/AGENTS.md", "update"],
  ["agents/qachecker/AGENTS.md", "create"],
  ["tasks/PAP-1677.md", "create"],
]);

function ActivityChartsMatrix({ empty = false }: { empty?: boolean }) {
  const runs = empty ? [] : activityRuns;
  const issues = empty ? [] : activityIssues;

  return (
    <StoryShell>
      <Section eyebrow="ActivityCharts" title={empty ? "Empty activity timelines" : "Two-week activity timelines"}>
        <div className="grid gap-4 md:grid-cols-2">
          <ChartCard title="Run activity" subtitle="Succeeded, failed, and in-flight heartbeats">
            <RunActivityChart runs={runs} />
          </ChartCard>
          <ChartCard title="Success rate" subtitle="Daily completion ratio">
            <SuccessRateChart runs={runs} />
          </ChartCard>
          <ChartCard title="Issue priority" subtitle="Created issues by urgency">
            <PriorityChart issues={issues} />
          </ChartCard>
          <ChartCard title="Issue status" subtitle="Created issues by workflow state">
            <IssueStatusChart issues={issues} />
          </ChartCard>
        </div>
      </Section>
    </StoryShell>
  );
}

function KanbanBoardDemo({ empty = false }: { empty?: boolean }) {
  const [issues, setIssues] = useState<Issue[]>(empty ? [] : kanbanIssues);
  const liveIssueIds = useMemo(() => new Set(["issue-storybook-1", "issue-kanban-backlog"]), []);

  return (
    <StoryShell>
      <Section eyebrow="KanbanBoard" title={empty ? "Collapsed empty workflow columns" : "Draggable issue cards by status"}>
        <KanbanBoard
          issues={issues}
          agents={storybookAgents}
          liveIssueIds={liveIssueIds}
          onUpdateIssue={(id, data) => {
            setIssues((current) =>
              current.map((issue) => (issue.id === id ? { ...issue, ...data } : issue)),
            );
          }}
        />
      </Section>
    </StoryShell>
  );
}

function FilterBarDemo({ empty = false }: { empty?: boolean }) {
  const [filters, setFilters] = useState<FilterValue[]>(
    empty
      ? []
      : [
          { key: "status", label: "Status", value: "In progress" },
          { key: "assignee", label: "Assignee", value: "CodexCoder" },
          { key: "priority", label: "Priority", value: "High" },
          { key: "project", label: "Project", value: "Board UI" },
        ],
  );

  return (
    <StoryShell>
      <Section eyebrow="FilterBar" title={empty ? "No active filters" : "Active removable filter chips"}>
        <div className="rounded-lg border border-dashed border-border bg-background/70 p-4">
          <FilterBar
            filters={filters}
            onRemove={(key) => setFilters((current) => current.filter((filter) => filter.key !== key))}
            onClear={() => setFilters([])}
          />
          {filters.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ListFilter className="h-4 w-4" />
              No filters are active.
            </div>
          )}
        </div>
      </Section>
    </StoryShell>
  );
}

function LiveRunWidgetStory({ empty = false, loading = false }: { empty?: boolean; loading?: boolean }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (loading) return;
    queryClient.setQueryData(queryKeys.issues.liveRuns(primaryIssueId), empty ? [] : storybookLiveRuns);
    queryClient.setQueryData(queryKeys.issues.activeRun(primaryIssueId), empty ? null : storybookLiveRuns[0]);
  }, [empty, loading, queryClient]);

  if (loading) {
    return (
      <StoryShell>
        <Section eyebrow="LiveRunWidget" title="Loading live run status">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-background/70 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Waiting for the first run poll.
          </div>
        </Section>
      </StoryShell>
    );
  }

  return (
    <StoryShell>
      <Section eyebrow="LiveRunWidget" title={empty ? "No active run" : "Streaming run indicator"}>
        <LiveRunWidget issueId={primaryIssueId} />
        {empty && (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-background/70 p-4 text-sm text-muted-foreground">
            <Clock3 className="h-4 w-4" />
            The widget renders no panel when the issue has no live runs.
          </div>
        )}
      </Section>
    </StoryShell>
  );
}

function OpenOnboardingOnMount({ initialStep }: { initialStep: 1 | 2 }) {
  const { openOnboarding } = useDialog();
  const queryClient = useQueryClient();

  useEffect(() => {
    queryClient.setQueryData(queryKeys.agents.adapterModels(companyId, "claude_local"), [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
      { id: "claude-opus-4-1", label: "Claude Opus 4.1" },
    ]);
    openOnboarding(initialStep === 1 ? { initialStep } : { initialStep, companyId });
  }, [initialStep, openOnboarding, queryClient]);

  return <OnboardingWizard />;
}

function PackageFileTreeDemo({ empty = false }: { empty?: boolean }) {
  const nodes = useMemo(
    () => (empty ? [] : buildFileTree(packageFiles, actionMap)),
    [empty],
  );
  const allFilePaths = useMemo(() => collectAllPaths(nodes, "file"), [nodes]);
  const [expandedDirs, setExpandedDirs] = useState(() => collectAllPaths(nodes, "dir"));
  const [checkedFiles, setCheckedFiles] = useState(() => allFilePaths);
  const [selectedFile, setSelectedFile] = useState<string | null>(empty ? null : "tasks/PAP-1677.md");

  useEffect(() => {
    setExpandedDirs(collectAllPaths(nodes, "dir"));
    setCheckedFiles(allFilePaths);
    setSelectedFile(empty ? null : "tasks/PAP-1677.md");
  }, [allFilePaths, empty, nodes]);

  const selectedContent = selectedFile ? packageFiles[selectedFile] ?? "" : "";
  const frontmatter = selectedContent ? parseFrontmatter(selectedContent) : null;

  function toggleDir(path: string) {
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleCheck(path: string, kind: "file" | "dir") {
    setCheckedFiles((current) => {
      const next = new Set(current);
      const paths =
        kind === "file"
          ? [path]
          : [...collectAllPaths(findNode(nodes, path)?.children ?? [], "file")];
      const shouldCheck = paths.some((candidate) => !next.has(candidate));
      for (const candidate of paths) {
        if (shouldCheck) next.add(candidate);
        else next.delete(candidate);
      }
      return next;
    });
  }

  return (
    <StoryShell>
      <Section eyebrow="PackageFileTree" title={empty ? "Empty package export" : "Selectable company package tree"}>
        {empty ? (
          <div className="rounded-lg border border-dashed border-border bg-background/70 p-6 text-sm text-muted-foreground">
            No files are included in this package preview.
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.1fr)]">
            <div className="overflow-hidden rounded-lg border border-border bg-background/70">
              <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm">
                <span className="font-medium">Package contents</span>
                <Badge variant="outline">{countFiles(nodes)} files</Badge>
              </div>
              <PackageFileTree
                nodes={nodes}
                selectedFile={selectedFile}
                expandedDirs={expandedDirs}
                checkedFiles={checkedFiles}
                onToggleDir={toggleDir}
                onSelectFile={setSelectedFile}
                onToggleCheck={toggleCheck}
                renderFileExtra={(node) =>
                  node.action ? (
                    <Badge variant="secondary" className="ml-auto text-[10px]">
                      {node.action}
                    </Badge>
                  ) : null
                }
              />
            </div>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileCode2 className="h-4 w-4" />
                  {selectedFile}
                </CardTitle>
                <CardDescription>Frontmatter and markdown body parsed from the selected package file.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {frontmatter ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {Object.entries(frontmatter.data).map(([key, value]) => (
                      <div key={key} className="rounded-md border border-border bg-background/70 p-2">
                        <div className="text-[10px] uppercase text-muted-foreground">{key}</div>
                        <div className="mt-1 text-sm">{Array.isArray(value) ? value.join(", ") : value}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
                <pre className="max-h-56 overflow-auto rounded-md bg-muted/40 p-3 text-xs leading-5">
                  {frontmatter?.body.trim() || selectedContent}
                </pre>
              </CardContent>
            </Card>
          </div>
        )}
      </Section>
    </StoryShell>
  );
}

function findNode(nodes: FileTreeNode[], path: string): FileTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = findNode(node.children, path);
    if (child) return child;
  }
  return null;
}

function EntityRowsDemo({ empty = false }: { empty?: boolean }) {
  const rows = empty
    ? []
    : [
        {
          id: "agent",
          leading: <Bot className="h-4 w-4 text-cyan-600" />,
          identifier: "agent",
          title: "CodexCoder",
          subtitle: "Senior Product Engineer · active in Storybook worktree",
          trailing: <StatusBadge status="running" />,
          selected: true,
        },
        {
          id: "issue",
          leading: <FolderKanban className="h-4 w-4 text-emerald-600" />,
          identifier: "PAP-1677",
          title: "Storybook: Data Visualization & Misc stories",
          subtitle: "Medium priority · Board UI project",
          trailing: <Badge variant="secondary">UI</Badge>,
        },
        {
          id: "approval",
          leading: <ShieldCheck className="h-4 w-4 text-amber-600" />,
          identifier: "approval",
          title: "Publish Storybook preview",
          subtitle: "Approved for internal design review",
          trailing: <CheckCircle2 className="h-4 w-4 text-emerald-600" />,
        },
      ];

  return (
    <StoryShell>
      <Section eyebrow="EntityRow" title={empty ? "Empty list container" : "Generic list rows"}>
        <div className="overflow-hidden rounded-lg border border-border bg-background/70">
          {rows.map((row) => (
            <EntityRow
              key={row.id}
              leading={row.leading}
              identifier={row.identifier}
              title={row.title}
              subtitle={row.subtitle}
              trailing={row.trailing}
              selected={row.selected}
              to={row.id === "issue" ? "/PAP/issues/PAP-1677" : undefined}
            />
          ))}
          {rows.length === 0 && (
            <div className="p-6 text-sm text-muted-foreground">No entities match this view.</div>
          )}
        </div>
      </Section>
    </StoryShell>
  );
}

function SwipeToArchiveDemo({ disabled = false }: { disabled?: boolean }) {
  const [archived, setArchived] = useState(false);

  return (
    <StoryShell>
      <Section eyebrow="SwipeToArchive" title={disabled ? "Disabled mobile gesture" : "Mobile archive gesture"}>
        <div className="mx-auto w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
          <div className="border-b border-border px-4 py-3 text-xs uppercase tracking-wide text-muted-foreground">
            Inbox
          </div>
          {archived ? (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
              <Archive className="h-4 w-4" />
              Archived
            </div>
          ) : (
            <SwipeToArchive
              selected
              disabled={disabled}
              onArchive={() => setArchived(true)}
            >
              <EntityRow
                leading={<Play className="h-4 w-4 text-cyan-600" />}
                identifier="PAP-1677"
                title="Storybook: Data Visualization & Misc stories"
                subtitle={disabled ? "Gesture disabled while review is locked" : "Swipe left on touch devices to archive"}
                trailing={<Badge variant="outline">mobile</Badge>}
              />
            </SwipeToArchive>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="m-3"
            onClick={() => setArchived(false)}
          >
            Reset
          </Button>
        </div>
      </Section>
    </StoryShell>
  );
}

function CompanyPatternIconMatrix() {
  const companies = [
    { name: "Paperclip Storybook", color: "#0f766e" },
    { name: "Research Bureau", color: "#2563eb" },
    { name: "Launch Ops", color: "#c2410c" },
    { name: "Atlas Finance", color: "#7c3aed" },
  ];
  const sizes = ["h-8 w-8 text-xs", "h-11 w-11 text-base", "h-16 w-16 text-xl", "h-24 w-24 text-3xl"];

  return (
    <StoryShell>
      <Section eyebrow="CompanyPatternIcon" title="Generated company pattern icons by size">
        <div className="grid gap-4 md:grid-cols-2">
          {companies.map((company) => (
            <Card key={company.name} className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">{company.name}</CardTitle>
                <CardDescription>{company.color}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-end gap-4">
                {sizes.map((size) => (
                  <CompanyPatternIcon
                    key={size}
                    companyName={company.name}
                    brandColor={company.color}
                    className={size}
                  />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>
    </StoryShell>
  );
}

function AsciiArtAnimationDemo({ loading = false }: { loading?: boolean }) {
  return (
    <StoryShell>
      <Section eyebrow="AsciiArtAnimation" title={loading ? "Loading art surface" : "Animated ASCII paperclip field"}>
        <div className="h-[360px] overflow-hidden rounded-xl border border-border bg-background">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Preparing animation canvas
            </div>
          ) : (
            <AsciiArtAnimation />
          )}
        </div>
      </Section>
    </StoryShell>
  );
}

function PageSkeletonMatrix() {
  const variants = [
    "list",
    "issues-list",
    "detail",
    "dashboard",
    "approvals",
    "costs",
    "inbox",
    "org-chart",
  ] as const;

  return (
    <StoryShell>
      <Section eyebrow="PageSkeleton" title="Loading skeletons for page layouts">
        <div className="grid gap-5 xl:grid-cols-2">
          {variants.map((variant) => (
            <Card key={variant} className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">{variant}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-[420px] overflow-hidden">
                  <PageSkeleton variant={variant} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>
    </StoryShell>
  );
}

const meta = {
  title: "Product/Data Visualization & Misc",
  parameters: {
    docs: {
      description: {
        component:
          "Fixture-backed stories for charting, board, filtering, live run, onboarding, package preview, entity row, mobile gesture, generated icon, ASCII animation, and skeleton states.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const ActivityChartsPopulated: Story = {
  name: "ActivityCharts / Populated",
  render: () => <ActivityChartsMatrix />,
};

export const ActivityChartsEmpty: Story = {
  name: "ActivityCharts / Empty",
  render: () => <ActivityChartsMatrix empty />,
};

export const KanbanBoardPopulated: Story = {
  name: "KanbanBoard / Populated",
  render: () => <KanbanBoardDemo />,
};

export const KanbanBoardEmpty: Story = {
  name: "KanbanBoard / Empty",
  render: () => <KanbanBoardDemo empty />,
};

export const FilterBarPopulated: Story = {
  name: "FilterBar / Populated",
  render: () => <FilterBarDemo />,
};

export const FilterBarEmpty: Story = {
  name: "FilterBar / Empty",
  render: () => <FilterBarDemo empty />,
};

export const LiveRunWidgetPopulated: Story = {
  name: "LiveRunWidget / Populated",
  render: () => <LiveRunWidgetStory />,
};

export const LiveRunWidgetLoading: Story = {
  name: "LiveRunWidget / Loading",
  render: () => <LiveRunWidgetStory loading />,
};

export const LiveRunWidgetEmpty: Story = {
  name: "LiveRunWidget / Empty",
  render: () => <LiveRunWidgetStory empty />,
};

export const OnboardingWizardCompanyStep: Story = {
  name: "OnboardingWizard / Company Step",
  render: () => <OpenOnboardingOnMount initialStep={1} />,
};

export const OnboardingWizardAgentStep: Story = {
  name: "OnboardingWizard / Agent Step",
  render: () => <OpenOnboardingOnMount initialStep={2} />,
};

export const PackageFileTreePopulated: Story = {
  name: "PackageFileTree / Populated",
  render: () => <PackageFileTreeDemo />,
};

export const PackageFileTreeEmpty: Story = {
  name: "PackageFileTree / Empty",
  render: () => <PackageFileTreeDemo empty />,
};

export const EntityRowPopulated: Story = {
  name: "EntityRow / Populated",
  render: () => <EntityRowsDemo />,
};

export const EntityRowEmpty: Story = {
  name: "EntityRow / Empty",
  render: () => <EntityRowsDemo empty />,
};

export const SwipeToArchiveMobile: Story = {
  name: "SwipeToArchive / Mobile",
  render: () => <SwipeToArchiveDemo />,
};

export const SwipeToArchiveDisabled: Story = {
  name: "SwipeToArchive / Disabled",
  render: () => <SwipeToArchiveDemo disabled />,
};

export const CompanyPatternIconSizes: Story = {
  name: "CompanyPatternIcon / Sizes",
  render: () => <CompanyPatternIconMatrix />,
};

export const AsciiArtAnimationPopulated: Story = {
  name: "AsciiArtAnimation / Populated",
  render: () => <AsciiArtAnimationDemo />,
};

export const AsciiArtAnimationLoading: Story = {
  name: "AsciiArtAnimation / Loading",
  render: () => <AsciiArtAnimationDemo loading />,
};

export const PageSkeletonLayouts: Story = {
  name: "PageSkeleton / Layouts",
  render: () => <PageSkeletonMatrix />,
};
