import { useMemo, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { Goal, Project } from "@paperclipai/shared";
import { Archive, Boxes, FolderGit2, GitBranch, Network, Play, RotateCcw, Square } from "lucide-react";
import { GoalProperties } from "@/components/GoalProperties";
import { GoalTree } from "@/components/GoalTree";
import { ProjectProperties, type ProjectConfigFieldKey, type ProjectFieldSaveState } from "@/components/ProjectProperties";
import { ProjectWorkspacesContent } from "@/components/ProjectWorkspacesContent";
import { ProjectWorkspaceSummaryCard } from "@/components/ProjectWorkspaceSummaryCard";
import {
  WorkspaceRuntimeControls,
  buildWorkspaceRuntimeControlSections,
  type WorkspaceRuntimeControlRequest,
} from "@/components/WorkspaceRuntimeControls";
import { WorktreeBanner } from "@/components/WorktreeBanner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { queryKeys } from "@/lib/queryKeys";
import { buildProjectWorkspaceSummaries } from "@/lib/project-workspaces-tab";
import {
  storybookAgents,
  storybookAuthSession,
  storybookCompanies,
  storybookExecutionWorkspaces,
  storybookGoals,
  storybookIssues,
  storybookProjectWorkspaces,
  storybookProjects,
} from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";
const boardProject = storybookProjects.find((project) => project.id === "project-board-ui") ?? storybookProjects[0]!;
const archivedProject =
  storybookProjects.find((project) => project.id === "project-archived-import")
  ?? storybookProjects[storybookProjects.length - 1]!;

const goalProgress = new Map<string, number>([
  ["goal-company", 62],
  ["goal-board-ux", 74],
  ["goal-agent-runtime", 48],
  ["goal-storybook", 88],
  ["goal-budget-safety", 100],
  ["goal-archived-import", 18],
]);

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
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
  queryClient.setQueryData(queryKeys.auth.session, storybookAuthSession);
  queryClient.setQueryData(queryKeys.companies.all, { companies: storybookCompanies, unauthorized: false });
  queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), storybookAgents);
  queryClient.setQueryData(queryKeys.projects.list(COMPANY_ID), storybookProjects);
  queryClient.setQueryData(queryKeys.projects.detail(boardProject.id), boardProject);
  queryClient.setQueryData(queryKeys.projects.detail(boardProject.urlKey), boardProject);
  queryClient.setQueryData(queryKeys.projects.detail(archivedProject.id), archivedProject);
  queryClient.setQueryData(queryKeys.goals.list(COMPANY_ID), storybookGoals);
  for (const goal of storybookGoals) {
    queryClient.setQueryData(queryKeys.goals.detail(goal.id), goal);
  }
  queryClient.setQueryData(queryKeys.issues.list(COMPANY_ID), storybookIssues);
  queryClient.setQueryData(queryKeys.issues.listByProject(COMPANY_ID, boardProject.id), storybookIssues);
  queryClient.setQueryData(queryKeys.secrets.list(COMPANY_ID), []);
  queryClient.setQueryData(queryKeys.instance.experimentalSettings, {
    enableIsolatedWorkspaces: true,
    enableRoutineTriggers: true,
  });
  queryClient.setQueryData(queryKeys.executionWorkspaces.list(COMPANY_ID), storybookExecutionWorkspaces);
  queryClient.setQueryData(
    queryKeys.executionWorkspaces.list(COMPANY_ID, { projectId: boardProject.id }),
    storybookExecutionWorkspaces,
  );
  queryClient.setQueryData(
    queryKeys.executionWorkspaces.summaryList(COMPANY_ID),
    storybookExecutionWorkspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      mode: workspace.mode,
      projectWorkspaceId: workspace.projectWorkspaceId,
    })),
  );
}

function StorybookData({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [ready] = useState(() => {
    hydrateStorybookQueries(queryClient);
    return true;
  });

  return ready ? children : null;
}

function stateForProjectField(field: ProjectConfigFieldKey): ProjectFieldSaveState {
  if (field === "env" || field === "execution_workspace_branch_template") return "saved";
  if (field === "execution_workspace_worktree_parent_dir") return "saving";
  return "idle";
}

function ProjectPropertiesMatrix() {
  const editableProject: Project = useMemo(
    () => ({
      ...boardProject,
      env: {
        STORYBOOK_REVIEW: { type: "plain", value: "enabled" },
        OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-openai", version: "latest" },
      },
    }),
    [],
  );

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="rounded-lg border border-border bg-background p-4">
        <ProjectProperties
          project={editableProject}
          onFieldUpdate={() => undefined}
          getFieldSaveState={stateForProjectField}
          onArchive={() => undefined}
        />
      </div>
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">{archivedProject.name}</div>
              <div className="text-xs text-muted-foreground">Archived, no workspace configured</div>
            </div>
            <Badge variant="outline" className="gap-1">
              <Archive className="h-3 w-3" />
              archived
            </Badge>
          </div>
          <ProjectProperties
            project={archivedProject}
            onFieldUpdate={() => undefined}
            onArchive={() => undefined}
            archivePending={false}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
          {[
            { label: "Goals linked", value: boardProject.goalIds.length, icon: Network },
            { label: "Workspaces", value: boardProject.workspaces.length, icon: Boxes },
            { label: "Runtime services", value: boardProject.primaryWorkspace?.runtimeServices?.length ?? 0, icon: Play },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className="rounded-lg border border-border bg-background p-4">
                <Icon className="h-4 w-4 text-muted-foreground" />
                <div className="mt-3 text-2xl font-semibold">{item.value}</div>
                <div className="text-xs text-muted-foreground">{item.label}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function WorkspacesMatrix() {
  const summaries = buildProjectWorkspaceSummaries({
    project: boardProject,
    issues: storybookIssues.filter((issue) => issue.projectId === boardProject.id),
    executionWorkspaces: storybookExecutionWorkspaces,
  });
  const localSummary = summaries.find((summary) => summary.kind === "project_workspace" && summary.workspaceId === "workspace-board-ui");
  const remoteSummary = summaries.find((summary) => summary.workspaceId === "workspace-docs-remote");
  const cleanupSummary = summaries.find((summary) => summary.executionWorkspaceStatus === "cleanup_failed");
  const featuredSummaries = [localSummary, remoteSummary, cleanupSummary].filter(
    (summary): summary is NonNullable<typeof summary> => Boolean(summary),
  );

  return (
    <div className="space-y-5">
      <ProjectWorkspacesContent
        companyId={COMPANY_ID}
        projectId={boardProject.id}
        projectRef={boardProject.urlKey}
        summaries={summaries}
      />
      <div className="grid gap-4 xl:grid-cols-3">
        {featuredSummaries.map((summary) => (
          <ProjectWorkspaceSummaryCard
            key={summary.key}
            projectRef={boardProject.urlKey}
            summary={summary}
            runtimeActionKey={summary.runningServiceCount > 0 ? `${summary.key}:stop` : null}
            runtimeActionPending={summary.runningServiceCount > 0}
            onRuntimeAction={() => undefined}
            onCloseWorkspace={() => undefined}
          />
        ))}
      </div>
      <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
        <ProjectWorkspacesContent
          companyId={COMPANY_ID}
          projectId={archivedProject.id}
          projectRef={archivedProject.urlKey}
          summaries={[]}
        />
      </div>
    </div>
  );
}

function GoalProgressRow({ goal }: { goal: Goal }) {
  const progress = goalProgress.get(goal.id) ?? 0;
  const childCount = storybookGoals.filter((candidate) => candidate.parentId === goal.id).length;

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{goal.title}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {goal.level} · {childCount} child goal{childCount === 1 ? "" : "s"}
          </div>
        </div>
        <span className="font-mono text-xs text-muted-foreground">{progress}%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" aria-label={`${progress}% complete`}>
        <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function GoalPropertiesMatrix() {
  const selectedGoal = storybookGoals.find((goal) => goal.id === "goal-board-ux") ?? storybookGoals[0]!;
  const childGoals = storybookGoals.filter((goal) => goal.parentId === selectedGoal.id);
  const linkedProjects = storybookProjects.filter((project) => project.goalIds.includes(selectedGoal.id));

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-background p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="paperclip-story__label">Goal detail composition</div>
              <h3 className="mt-2 text-xl font-semibold">{selectedGoal.title}</h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{selectedGoal.description}</p>
            </div>
            <Badge variant="outline">{selectedGoal.status}</Badge>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <GoalProgressRow goal={selectedGoal} />
            <div className="rounded-lg border border-border bg-background p-3">
              <div className="text-2xl font-semibold">{childGoals.length}</div>
              <div className="text-xs text-muted-foreground">Child goals</div>
            </div>
            <div className="rounded-lg border border-border bg-background p-3">
              <div className="text-2xl font-semibold">{linkedProjects.length}</div>
              <div className="text-xs text-muted-foreground">Linked projects</div>
            </div>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {childGoals.map((goal) => (
            <GoalProgressRow key={goal.id} goal={goal} />
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-background p-4">
        <GoalProperties goal={selectedGoal} onUpdate={() => undefined} />
      </div>
    </div>
  );
}

function GoalTreeMatrix() {
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(storybookGoals[1] ?? null);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="overflow-hidden rounded-lg border border-border bg-background">
        <GoalTree
          goals={storybookGoals}
          onSelect={setSelectedGoal}
        />
      </div>
      <div className="rounded-lg border border-border bg-background p-4">
        <div className="paperclip-story__label">Selected goal</div>
        {selectedGoal ? (
          <div className="mt-3 space-y-3">
            <div>
              <div className="text-sm font-medium">{selectedGoal.title}</div>
              <div className="mt-1 text-xs text-muted-foreground">{selectedGoal.description}</div>
            </div>
            <GoalProgressRow goal={selectedGoal} />
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">Select a goal row to inspect its progress state.</p>
        )}
      </div>
    </div>
  );
}

function RuntimeControlsMatrix() {
  const primaryWorkspace = storybookProjectWorkspaces[0]!;
  const remoteWorkspace = storybookProjectWorkspaces.find((workspace) => workspace.id === "workspace-docs-remote")!;
  const runningSections = buildWorkspaceRuntimeControlSections({
    runtimeConfig: primaryWorkspace.runtimeConfig?.workspaceRuntime,
    runtimeServices: primaryWorkspace.runtimeServices,
    canStartServices: true,
    canRunJobs: true,
  });
  const stoppedSections = buildWorkspaceRuntimeControlSections({
    runtimeConfig: remoteWorkspace.runtimeConfig?.workspaceRuntime,
    runtimeServices: remoteWorkspace.runtimeServices,
    canStartServices: true,
    canRunJobs: true,
  });
  const disabledSections = buildWorkspaceRuntimeControlSections({
    runtimeConfig: {
      commands: [
        { id: "web", name: "Web app", kind: "service", command: "pnpm dev" },
        { id: "migrate", name: "Migrate database", kind: "job", command: "pnpm db:migrate" },
      ],
    },
    runtimeServices: [],
    canStartServices: false,
    canRunJobs: false,
  });
  const pendingRequest: WorkspaceRuntimeControlRequest = {
    action: "restart",
    workspaceCommandId: "storybook",
    runtimeServiceId: "service-storybook",
    serviceIndex: 0,
  };

  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Square className="h-4 w-4" />
            Running services
          </CardTitle>
          <CardDescription>Stop and restart actions with a pending request spinner.</CardDescription>
        </CardHeader>
        <CardContent>
          <WorkspaceRuntimeControls
            sections={runningSections}
            isPending
            pendingRequest={pendingRequest}
            onAction={() => undefined}
          />
        </CardContent>
      </Card>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Play className="h-4 w-4" />
            Stopped remote preview
          </CardTitle>
          <CardDescription>Startable remote workspace service with URL history.</CardDescription>
        </CardHeader>
        <CardContent>
          <WorkspaceRuntimeControls sections={stoppedSections} onAction={() => undefined} />
        </CardContent>
      </Card>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4" />
            Missing prerequisites
          </CardTitle>
          <CardDescription>Disabled runtime controls when no workspace path is available.</CardDescription>
        </CardHeader>
        <CardContent>
          <WorkspaceRuntimeControls
            sections={disabledSections}
            disabledHint="Add a workspace path before starting runtime services."
            square
            onAction={() => undefined}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function setWorktreeMeta(name: string, content: string) {
  if (typeof document === "undefined") return;
  let element = document.querySelector(`meta[name="${name}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute("name", name);
    document.head.appendChild(element);
  }
  element.setAttribute("content", content);
}

function WorktreeBannerMatrix() {
  setWorktreeMeta("paperclip-worktree-enabled", "true");
  setWorktreeMeta("paperclip-worktree-name", "PAP-1675-projects-goals-workspaces");
  setWorktreeMeta("paperclip-worktree-color", "#0f766e");
  setWorktreeMeta("paperclip-worktree-text-color", "#ecfeff");

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border border-border bg-background">
        <WorktreeBanner />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {[
          { label: "Branch", value: "PAP-1675-projects-goals-workspaces", icon: GitBranch },
          { label: "Workspace", value: "Project Storybook worktree", icon: FolderGit2 },
          { label: "Context", value: "visible before layout chrome", icon: Boxes },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="rounded-lg border border-border bg-background p-4">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <div className="mt-3 text-xs uppercase tracking-[0.14em] text-muted-foreground">{item.label}</div>
              <div className="mt-1 break-all font-mono text-xs">{item.value}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProjectsGoalsWorkspacesStories() {
  return (
    <StorybookData>
      <div className="paperclip-story">
        <main className="paperclip-story__inner space-y-6">
          <section className="paperclip-story__frame p-6">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div>
                <div className="paperclip-story__label">Projects, goals, and workspaces</div>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight">Hierarchical planning and runtime surfaces</h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                  Fixture-backed project and goal stories cover editable project properties, local and remote workspace
                  cards, cleanup failures, goal hierarchy states, and runtime command controls.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">active</Badge>
                <Badge variant="outline">archived</Badge>
                <Badge variant="outline">local workspace</Badge>
                <Badge variant="outline">remote workspace</Badge>
              </div>
            </div>
          </section>

          <Section eyebrow="ProjectProperties" title="Full project detail panels with codebase, goals, env, and archive states">
            <ProjectPropertiesMatrix />
          </Section>

          <Section eyebrow="ProjectWorkspacesContent" title="Workspace list with local, remote, cleanup-failed, and empty states">
            <WorkspacesMatrix />
          </Section>

          <Section eyebrow="GoalProperties" title="Goal detail panel with progress and child goal context">
            <GoalPropertiesMatrix />
          </Section>

          <Section eyebrow="GoalTree" title="Hierarchical goal tree with expand/collapse and progress sidecar">
            <GoalTreeMatrix />
          </Section>

          <Section eyebrow="WorkspaceRuntimeControls" title="Runtime start, stop, restart, and disabled command states">
            <RuntimeControlsMatrix />
          </Section>

          <Section eyebrow="WorktreeBanner" title="Worktree context banner with branch identity">
            <WorktreeBannerMatrix />
          </Section>
        </main>
      </div>
    </StorybookData>
  );
}

const meta = {
  title: "Product/Projects Goals Workspaces",
  component: ProjectsGoalsWorkspacesStories,
  parameters: {
    docs: {
      description: {
        component:
          "Projects, goals, and workspaces stories cover project properties, workspace cards/lists, goal hierarchy panels, runtime controls, and worktree branding states.",
      },
    },
  },
} satisfies Meta<typeof ProjectsGoalsWorkspacesStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SurfaceMatrix: Story = {};
