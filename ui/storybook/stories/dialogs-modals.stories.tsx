import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  DocumentRevision,
  ExecutionWorkspaceCloseReadiness,
  Goal,
  IssueAttachment,
} from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { DocumentDiffModal } from "@/components/DocumentDiffModal";
import { ExecutionWorkspaceCloseDialog } from "@/components/ExecutionWorkspaceCloseDialog";
import { ImageGalleryModal } from "@/components/ImageGalleryModal";
import { NewAgentDialog } from "@/components/NewAgentDialog";
import { NewGoalDialog } from "@/components/NewGoalDialog";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { PathInstructionsModal } from "@/components/PathInstructionsModal";
import { useCompany } from "@/context/CompanyContext";
import { useDialog } from "@/context/DialogContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  storybookAgents,
  storybookAuthSession,
  storybookCompanies,
  storybookExecutionWorkspaces,
  storybookIssueDocuments,
  storybookIssueLabels,
  storybookIssues,
  storybookProjects,
} from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";
const SELECTED_COMPANY_STORAGE_KEY = "paperclip.selectedCompanyId";
const ISSUE_DRAFT_STORAGE_KEY = "paperclip:issue-draft";

const storybookGoals: Goal[] = [
  {
    id: "goal-company",
    companyId: COMPANY_ID,
    title: "Build Paperclip",
    description: "Make autonomous companies easier to run and govern.",
    level: "company",
    status: "active",
    parentId: null,
    ownerAgentId: "agent-cto",
    createdAt: new Date("2026-04-01T09:00:00.000Z"),
    updatedAt: new Date("2026-04-20T11:00:00.000Z"),
  },
  {
    id: "goal-storybook",
    companyId: COMPANY_ID,
    title: "Complete Storybook coverage",
    description: "Expose dense board UI states for review before release.",
    level: "team",
    status: "active",
    parentId: "goal-company",
    ownerAgentId: "agent-codex",
    createdAt: new Date("2026-04-17T09:00:00.000Z"),
    updatedAt: new Date("2026-04-20T11:10:00.000Z"),
  },
  {
    id: "goal-governance",
    companyId: COMPANY_ID,
    title: "Tighten governance review",
    description: "Make review and approval gates visible in every operator flow.",
    level: "team",
    status: "planned",
    parentId: "goal-company",
    ownerAgentId: "agent-cto",
    createdAt: new Date("2026-04-18T09:00:00.000Z"),
    updatedAt: new Date("2026-04-20T11:15:00.000Z"),
  },
];

const documentRevisions: DocumentRevision[] = [
  {
    id: "revision-plan-1",
    companyId: COMPANY_ID,
    documentId: "document-plan-storybook",
    issueId: "issue-storybook-1",
    key: "plan",
    revisionNumber: 1,
    title: "Plan",
    format: "markdown",
    body: [
      "# Plan",
      "",
      "- Add overview stories for the dashboard.",
      "- Create issue list stories for filters and grouping.",
      "- Ask QA to review the final Storybook build.",
    ].join("\n"),
    changeSummary: "Initial plan",
    createdByAgentId: "agent-codex",
    createdByUserId: null,
    createdAt: new Date("2026-04-20T08:00:00.000Z"),
  },
  {
    id: "revision-plan-2",
    companyId: COMPANY_ID,
    documentId: "document-plan-storybook",
    issueId: "issue-storybook-1",
    key: "plan",
    revisionNumber: 2,
    title: "Plan",
    format: "markdown",
    body: [
      "# Plan",
      "",
      "- Add overview stories for the dashboard.",
      "- Create issue list stories for filters, grouping, and workspace state.",
      "- Add dialog stories for issue, goal, project, and workspace workflows.",
      "- Ask QA to review the final Storybook build.",
    ].join("\n"),
    changeSummary: "Expanded component coverage",
    createdByAgentId: "agent-codex",
    createdByUserId: null,
    createdAt: new Date("2026-04-20T10:00:00.000Z"),
  },
  {
    id: "revision-plan-3",
    companyId: COMPANY_ID,
    documentId: "document-plan-storybook",
    issueId: "issue-storybook-1",
    key: "plan",
    revisionNumber: 3,
    title: "Plan",
    format: "markdown",
    body: storybookIssueDocuments[0]?.body ?? "",
    changeSummary: "Aligned with current issue scope",
    createdByAgentId: "agent-codex",
    createdByUserId: null,
    createdAt: new Date("2026-04-20T11:30:00.000Z"),
  },
];

const closeReadinessReady: ExecutionWorkspaceCloseReadiness = {
  workspaceId: "execution-workspace-storybook",
  state: "ready_with_warnings",
  blockingReasons: [],
  warnings: [
    "The branch is still two commits ahead of master.",
    "One shared runtime service will be stopped during cleanup.",
  ],
  linkedIssues: [
    {
      id: "issue-storybook-1",
      identifier: "PAP-1641",
      title: "Create super-detailed storybooks for the project",
      status: "done",
      isTerminal: true,
    },
    {
      id: "issue-storybook-6",
      identifier: "PAP-1670",
      title: "Publish static Storybook preview",
      status: "todo",
      isTerminal: false,
    },
  ],
  plannedActions: [
    {
      kind: "stop_runtime_services",
      label: "Stop Storybook preview",
      description: "Stops the managed Storybook preview service before archiving the workspace record.",
      command: "pnpm dev:stop",
    },
    {
      kind: "git_worktree_remove",
      label: "Remove git worktree",
      description: "Removes the issue worktree from the local worktree parent directory.",
      command: "git worktree remove .paperclip/worktrees/PAP-1641-create-super-detailed-storybooks-for-our-project",
    },
    {
      kind: "archive_record",
      label: "Archive workspace record",
      description: "Keeps audit history while removing the workspace from active workspace views.",
      command: null,
    },
  ],
  isDestructiveCloseAllowed: true,
  isSharedWorkspace: false,
  isProjectPrimaryWorkspace: false,
  git: {
    repoRoot: "/Users/dotta/paperclip",
    workspacePath: "/Users/dotta/paperclip/.paperclip/worktrees/PAP-1641-create-super-detailed-storybooks-for-our-project",
    branchName: "PAP-1641-create-super-detailed-storybooks-for-our-project",
    baseRef: "master",
    hasDirtyTrackedFiles: true,
    hasUntrackedFiles: false,
    dirtyEntryCount: 3,
    untrackedEntryCount: 0,
    aheadCount: 2,
    behindCount: 0,
    isMergedIntoBase: false,
    createdByRuntime: true,
  },
  runtimeServices: storybookExecutionWorkspaces[0]?.runtimeServices ?? [],
};

const closeReadinessBlocked: ExecutionWorkspaceCloseReadiness = {
  ...closeReadinessReady,
  state: "blocked",
  blockingReasons: [
    "PAP-1670 is still open and references this execution workspace.",
    "The worktree has dirty tracked files that have not been committed.",
  ],
  warnings: [],
  plannedActions: closeReadinessReady.plannedActions.slice(0, 1),
};

const galleryImages: IssueAttachment[] = [
  {
    id: "attachment-storybook-dashboard",
    companyId: COMPANY_ID,
    issueId: "issue-storybook-1",
    issueCommentId: null,
    assetId: "asset-dashboard",
    provider: "storybook",
    objectKey: "storybook/dashboard-preview.svg",
    contentType: "image/svg+xml",
    byteSize: 1480,
    sha256: "storybook-dashboard-preview",
    originalFilename: "dashboard-preview.png",
    createdByAgentId: "agent-codex",
    createdByUserId: null,
    createdAt: new Date("2026-04-20T10:30:00.000Z"),
    updatedAt: new Date("2026-04-20T10:30:00.000Z"),
    contentPath:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1400' height='900' viewBox='0 0 1400 900'%3E%3Crect width='1400' height='900' fill='%230f172a'/%3E%3Crect x='88' y='96' width='1224' height='708' rx='28' fill='%23111827' stroke='%23334155' stroke-width='4'/%3E%3Crect x='136' y='148' width='264' height='604' rx='18' fill='%231e293b'/%3E%3Crect x='444' y='148' width='380' height='190' rx='18' fill='%230f766e'/%3E%3Crect x='860' y='148' width='348' height='190' rx='18' fill='%232563eb'/%3E%3Crect x='444' y='382' width='764' height='104' rx='18' fill='%23334155'/%3E%3Crect x='444' y='526' width='764' height='104' rx='18' fill='%23334155'/%3E%3Crect x='444' y='670' width='520' height='82' rx='18' fill='%23334155'/%3E%3Ccircle cx='236' cy='236' r='58' fill='%2314b8a6'/%3E%3Crect x='188' y='334' width='164' height='18' rx='9' fill='%2394a3b8'/%3E%3Crect x='188' y='386' width='128' height='18' rx='9' fill='%2364748b'/%3E%3Crect x='188' y='438' width='176' height='18' rx='9' fill='%2364748b'/%3E%3C/svg%3E",
  },
  {
    id: "attachment-storybook-diff",
    companyId: COMPANY_ID,
    issueId: "issue-storybook-1",
    issueCommentId: null,
    assetId: "asset-diff",
    provider: "storybook",
    objectKey: "storybook/diff-preview.svg",
    contentType: "image/svg+xml",
    byteSize: 1320,
    sha256: "storybook-diff-preview",
    originalFilename: "document-diff-preview.png",
    createdByAgentId: "agent-qa",
    createdByUserId: null,
    createdAt: new Date("2026-04-20T10:40:00.000Z"),
    updatedAt: new Date("2026-04-20T10:40:00.000Z"),
    contentPath:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1400' height='900' viewBox='0 0 1400 900'%3E%3Crect width='1400' height='900' fill='%23171717'/%3E%3Crect x='110' y='104' width='1180' height='692' rx='24' fill='%230a0a0a' stroke='%23333333' stroke-width='4'/%3E%3Crect x='160' y='164' width='1080' height='48' rx='12' fill='%23262626'/%3E%3Crect x='160' y='260' width='1080' height='52' fill='%2315221a'/%3E%3Crect x='160' y='312' width='1080' height='52' fill='%23231818'/%3E%3Crect x='160' y='364' width='1080' height='52' fill='%2315221a'/%3E%3Crect x='160' y='468' width='1080' height='52' fill='%23231818'/%3E%3Crect x='160' y='520' width='1080' height='52' fill='%2315221a'/%3E%3Crect x='220' y='276' width='720' height='18' rx='9' fill='%2374c69d'/%3E%3Crect x='220' y='328' width='540' height='18' rx='9' fill='%23fca5a5'/%3E%3Crect x='220' y='380' width='820' height='18' rx='9' fill='%2374c69d'/%3E%3Crect x='220' y='484' width='480' height='18' rx='9' fill='%23fca5a5'/%3E%3Crect x='220' y='536' width='760' height='18' rx='9' fill='%2374c69d'/%3E%3C/svg%3E",
  },
];

function Section({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="paperclip-story__frame overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="paperclip-story__label">{eyebrow}</div>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">{title}</h2>
            {description ? (
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function StoryShell({ children }: { children: ReactNode }) {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">{children}</main>
    </div>
  );
}

function DialogBackdropFrame({
  eyebrow,
  title,
  description,
  badges,
}: {
  eyebrow: string;
  title: string;
  description: string;
  badges: string[];
}) {
  return (
    <StoryShell>
      <Section eyebrow={eyebrow} title={title} description={description}>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_260px]">
          <div className="space-y-3">
            <div className="h-3 w-36 rounded-full bg-muted" />
            <div className="h-24 rounded-lg border border-dashed border-border bg-muted/30" />
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="h-16 rounded-lg border border-border bg-background/70" />
              <div className="h-16 rounded-lg border border-border bg-background/70" />
              <div className="h-16 rounded-lg border border-border bg-background/70" />
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <div className="mb-3 text-sm font-medium">Story state</div>
            <div className="flex flex-wrap gap-2">
              {badges.map((badge) => (
                <Badge key={badge} variant="outline">
                  {badge}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </Section>
    </StoryShell>
  );
}

function hydrateDialogQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.setQueryData(queryKeys.companies.all, storybookCompanies);
  queryClient.setQueryData(queryKeys.auth.session, storybookAuthSession);
  queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), storybookAgents);
  queryClient.setQueryData(queryKeys.projects.list(COMPANY_ID), storybookProjects);
  queryClient.setQueryData(queryKeys.goals.list(COMPANY_ID), storybookGoals);
  queryClient.setQueryData(queryKeys.issues.list(COMPANY_ID), storybookIssues);
  queryClient.setQueryData(queryKeys.issues.labels(COMPANY_ID), storybookIssueLabels);
  queryClient.setQueryData(queryKeys.issues.documents("issue-storybook-1"), storybookIssueDocuments);
  queryClient.setQueryData(queryKeys.issues.documentRevisions("issue-storybook-1", "plan"), documentRevisions);
  queryClient.setQueryData(queryKeys.executionWorkspaces.closeReadiness("execution-workspace-storybook"), closeReadinessReady);
  queryClient.setQueryData(queryKeys.executionWorkspaces.closeReadiness("execution-workspace-blocked"), closeReadinessBlocked);
  queryClient.setQueryData(
    queryKeys.executionWorkspaces.list(COMPANY_ID, {
      projectId: "project-board-ui",
      projectWorkspaceId: "workspace-board-ui",
      reuseEligible: true,
    }),
    storybookExecutionWorkspaces,
  );
  queryClient.setQueryData(queryKeys.instance.experimentalSettings, {
    enableIsolatedWorkspaces: true,
    enableRoutineTriggers: true,
  });
  queryClient.setQueryData(queryKeys.access.companyUserDirectory(COMPANY_ID), {
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
    queryKeys.sidebarPreferences.projectOrder(COMPANY_ID, storybookAuthSession.user.id),
    { orderedIds: storybookProjects.map((project) => project.id), updatedAt: null },
  );
  queryClient.setQueryData(queryKeys.adapters.all, [
    {
      type: "codex_local",
      label: "Codex local",
      source: "builtin",
      modelsCount: 5,
      loaded: true,
      disabled: false,
      capabilities: {
        supportsInstructionsBundle: true,
        supportsSkills: true,
        supportsLocalAgentJwt: true,
        requiresMaterializedRuntimeSkills: false,
      },
    },
    {
      type: "claude_local",
      label: "Claude local",
      source: "builtin",
      modelsCount: 4,
      loaded: true,
      disabled: false,
      capabilities: {
        supportsInstructionsBundle: true,
        supportsSkills: true,
        supportsLocalAgentJwt: true,
        requiresMaterializedRuntimeSkills: false,
      },
    },
  ]);
  queryClient.setQueryData(queryKeys.agents.adapterModels(COMPANY_ID, "codex_local"), [
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  ]);
}

function StorybookDialogFixtures({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [ready] = useState(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SELECTED_COMPANY_STORAGE_KEY, COMPANY_ID);
      window.localStorage.removeItem(ISSUE_DRAFT_STORAGE_KEY);
    }
    hydrateDialogQueries(queryClient);
    return true;
  });

  return ready ? children : null;
}

function useIssueCreateErrorMock(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled || typeof window === "undefined") return undefined;

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(rawUrl, window.location.origin);
      if (url.pathname === `/api/companies/${COMPANY_ID}/issues` && init?.method === "POST") {
        return Response.json(
          { error: "Validation failed: add a reviewer before creating governed release work." },
          { status: 422 },
        );
      }
      return originalFetch(input, init);
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, [enabled]);
}

function setFieldValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  valueSetter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function fillFirstField(selector: string, value: string) {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!element) return false;
  setFieldValue(element, value);
  return true;
}

function clickButtonByText(text: string) {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
  const button = buttons.find((candidate) => candidate.textContent?.trim().includes(text));
  button?.click();
}

function useOpenWhenCompanyReady(open: () => void) {
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const didOpenRef = useRef(false);

  useLayoutEffect(() => {
    if (selectedCompanyId !== COMPANY_ID) {
      setSelectedCompanyId(COMPANY_ID);
      return;
    }
    if (didOpenRef.current) return;
    didOpenRef.current = true;
    open();
  }, [open, selectedCompanyId, setSelectedCompanyId]);
}

function IssueDialogOpener({
  variant,
}: {
  variant: "empty" | "prefilled" | "validation";
}) {
  const { openNewIssue } = useDialog();
  useIssueCreateErrorMock(variant === "validation");

  useOpenWhenCompanyReady(() => {
    openNewIssue(
      variant === "empty"
        ? {}
        : {
            title: variant === "validation" ? "Ship guarded release checklist" : "Create dialog Storybook coverage",
            description: [
              "Cover modal flows with fixture-backed states.",
              "",
              "- Keep dialogs open by default",
              "- Show project workspace selection",
              "- Include reviewer and approver context",
            ].join("\n"),
            status: "todo",
            priority: "high",
            projectId: "project-board-ui",
            projectWorkspaceId: "workspace-board-ui",
            assigneeAgentId: "agent-codex",
            executionWorkspaceMode: "isolated_workspace",
          },
    );
  });

  useEffect(() => {
    if (variant !== "validation") return undefined;
    const timer = window.setTimeout(() => {
      clickButtonByText("Create Issue");
    }, 500);
    return () => window.clearTimeout(timer);
  }, [variant]);

  return <NewIssueDialog />;
}

function AgentDialogOpener({ advanced }: { advanced?: boolean }) {
  const { openNewAgent } = useDialog();

  useOpenWhenCompanyReady(() => {
    openNewAgent();
  });

  useEffect(() => {
    if (!advanced) return undefined;
    const timer = window.setTimeout(() => {
      clickButtonByText("advanced configuration");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [advanced]);

  return <NewAgentDialog />;
}

function GoalDialogOpener({ populated }: { populated?: boolean }) {
  const { openNewGoal } = useDialog();

  useOpenWhenCompanyReady(() => {
    openNewGoal(populated ? { parentId: "goal-company" } : {});
  });

  useEffect(() => {
    if (!populated) return undefined;
    const timer = window.setTimeout(() => {
      fillFirstField("input[placeholder='Goal title']", "Add modal review coverage");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [populated]);

  return <NewGoalDialog />;
}

function ProjectDialogOpener({ populated }: { populated?: boolean }) {
  const { openNewProject } = useDialog();

  useOpenWhenCompanyReady(() => {
    openNewProject();
  });

  useEffect(() => {
    if (!populated) return undefined;
    const timer = window.setTimeout(() => {
      fillFirstField("input[placeholder='Project name']", "Storybook review workspace");
      fillFirstField("input[placeholder='https://github.com/org/repo']", "https://github.com/paperclipai/paperclip");
      fillFirstField("input[placeholder='/absolute/path/to/workspace']", "/Users/dotta/paperclip/ui");
      fillFirstField("input[type='date']", "2026-04-30");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [populated]);

  return <NewProjectDialog />;
}

function DialogStory({
  eyebrow,
  title,
  description,
  badges,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  badges: string[];
  children: ReactNode;
}) {
  return (
    <StorybookDialogFixtures>
      <DialogBackdropFrame eyebrow={eyebrow} title={title} description={description} badges={badges} />
      {children}
    </StorybookDialogFixtures>
  );
}

function ExecutionWorkspaceDialogStory({ blocked }: { blocked?: boolean }) {
  const workspace = storybookExecutionWorkspaces[0]!;
  return (
    <DialogStory
      eyebrow="ExecutionWorkspaceCloseDialog"
      title={blocked ? "Blocked workspace close confirmation" : "Workspace close confirmation"}
      description="The close dialog exposes linked issues, git state, runtime services, and planned cleanup actions before archiving an execution workspace."
      badges={blocked ? ["blocked", "dirty worktree", "linked issue"] : ["ready with warnings", "cleanup actions"]}
    >
      <ExecutionWorkspaceCloseDialog
        workspaceId={blocked ? "execution-workspace-blocked" : workspace.id}
        workspaceName={blocked ? "PAP-1670 publish preview worktree" : workspace.name}
        currentStatus={workspace.status}
        open
        onOpenChange={() => undefined}
      />
    </DialogStory>
  );
}

function DocumentDiffModalStory() {
  return (
    <DialogStory
      eyebrow="DocumentDiffModal"
      title="Revision diff view"
      description="The diff modal compares document revisions with selectable old and new snapshots."
      badges={["revision selector", "line diff", "document history"]}
    >
      <DocumentDiffModal
        issueId="issue-storybook-1"
        documentKey="plan"
        latestRevisionNumber={3}
        open
        onOpenChange={() => undefined}
      />
    </DialogStory>
  );
}

function ImageGalleryModalStory() {
  return (
    <DialogStory
      eyebrow="ImageGalleryModal"
      title="Attachment gallery"
      description="The image gallery opens full-screen with attachment metadata, download action, and previous/next navigation."
      badges={["full-screen", "navigation", "visual attachment"]}
    >
      <ImageGalleryModal images={galleryImages} initialIndex={0} open onOpenChange={() => undefined} />
    </DialogStory>
  );
}

function PathInstructionsModalStory() {
  return (
    <DialogStory
      eyebrow="PathInstructionsModal"
      title="Absolute path instructions"
      description="The path helper opens directly to platform-specific steps for copying a full local workspace path."
      badges={["macOS", "Windows", "Linux"]}
    >
      <PathInstructionsModal open onOpenChange={() => undefined} />
    </DialogStory>
  );
}

const meta = {
  title: "Product/Dialogs & Modals",
  parameters: {
    docs: {
      description: {
        component:
          "Open-state stories for Paperclip creation dialogs, workspace confirmations, document diffing, image attachments, and path helper modals.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const NewIssueEmpty: Story = {
  name: "New Issue - Empty",
  render: () => (
    <DialogStory
      eyebrow="NewIssueDialog"
      title="Empty issue form"
      description="Default issue creation state with no assignee, project, priority, or workspace selected."
      badges={["empty", "creation", "draft"]}
    >
      <IssueDialogOpener variant="empty" />
    </DialogStory>
  ),
};

export const NewIssuePrefilled: Story = {
  name: "New Issue - Prefilled",
  render: () => (
    <DialogStory
      eyebrow="NewIssueDialog"
      title="Prefilled issue form"
      description="Populated issue creation state with project context, assignee, priority, description, and isolated workspace selection."
      badges={["populated", "assignee", "workspace"]}
    >
      <IssueDialogOpener variant="prefilled" />
    </DialogStory>
  ),
};

export const NewIssueValidationError: Story = {
  name: "New Issue - Validation Error",
  render: () => (
    <DialogStory
      eyebrow="NewIssueDialog"
      title="Validation error after submit"
      description="The submit path is mocked to return a 422 so the footer error state remains visible for review."
      badges={["validation", "422", "error"]}
    >
      <IssueDialogOpener variant="validation" />
    </DialogStory>
  ),
};

export const NewAgentRecommendation: Story = {
  name: "New Agent - Recommendation",
  render: () => (
    <DialogStory
      eyebrow="NewAgentDialog"
      title="Recommended CEO-assisted setup"
      description="Initial agent creation wizard state that routes operators toward CEO-owned agent setup."
      badges={["empty", "wizard", "CEO handoff"]}
    >
      <AgentDialogOpener />
    </DialogStory>
  ),
};

export const NewAgentAdapterSelection: Story = {
  name: "New Agent - Adapter Selection",
  render: () => (
    <DialogStory
      eyebrow="NewAgentDialog"
      title="Advanced adapter selection"
      description="Advanced branch of the agent creation wizard showing registered adapter choices and recommended states."
      badges={["populated", "adapters", "advanced"]}
    >
      <AgentDialogOpener advanced />
    </DialogStory>
  ),
};

export const NewGoalEmpty: Story = {
  name: "New Goal - Empty",
  render: () => (
    <DialogStory
      eyebrow="NewGoalDialog"
      title="Empty goal form"
      description="Default goal creation state with status, level, and parent-goal controls available."
      badges={["empty", "goal", "parent picker"]}
    >
      <GoalDialogOpener />
    </DialogStory>
  ),
};

export const NewGoalWithParent: Story = {
  name: "New Goal - Parent Selected",
  render: () => (
    <DialogStory
      eyebrow="NewGoalDialog"
      title="Goal creation with parent context"
      description="Populated goal creation state with a seeded title and company-level parent goal selected."
      badges={["populated", "sub-goal", "parent selected"]}
    >
      <GoalDialogOpener populated />
    </DialogStory>
  ),
};

export const NewProjectEmpty: Story = {
  name: "New Project - Empty",
  render: () => (
    <DialogStory
      eyebrow="NewProjectDialog"
      title="Empty project form"
      description="Default project creation state with description, goal, target date, and workspace fields empty."
      badges={["empty", "project", "workspace"]}
    >
      <ProjectDialogOpener />
    </DialogStory>
  ),
};

export const NewProjectWorkspaceConfig: Story = {
  name: "New Project - Workspace Config",
  render: () => (
    <DialogStory
      eyebrow="NewProjectDialog"
      title="Project creation with workspace config"
      description="Populated project creation state with repo URL, local folder path, and target date filled in."
      badges={["populated", "repo URL", "local path"]}
    >
      <ProjectDialogOpener populated />
    </DialogStory>
  ),
};

export const ExecutionWorkspaceCloseReady: Story = {
  name: "Execution Workspace Close - Ready",
  render: () => <ExecutionWorkspaceDialogStory />,
};

export const ExecutionWorkspaceCloseBlocked: Story = {
  name: "Execution Workspace Close - Blocked",
  render: () => <ExecutionWorkspaceDialogStory blocked />,
};

export const DocumentDiffOpen: Story = {
  name: "Document Diff",
  render: () => <DocumentDiffModalStory />,
};

export const ImageGalleryOpen: Story = {
  name: "Image Gallery",
  render: () => <ImageGalleryModalStory />,
};

export const PathInstructionsOpen: Story = {
  name: "Path Instructions",
  render: () => <PathInstructionsModalStory />,
};
