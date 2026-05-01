import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { Issue } from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import { IssuesList } from "@/components/IssuesList";
import { queryKeys } from "@/lib/queryKeys";
import {
  createIssue,
  storybookAgents,
  storybookAuthSession,
  storybookCompanies,
  storybookIssueLabels,
  storybookProjects,
} from "../fixtures/paperclipData";

const companyId = "company-storybook";
const parentId = "issue-pap-1953";

type BlockerRef = NonNullable<Issue["blockedBy"]>[number];

function child(overrides: Partial<Issue>): Issue {
  return createIssue({
    parentId,
    projectId: storybookProjects[0]!.id,
    projectWorkspaceId: storybookProjects[0]!.workspaces[0]?.id ?? null,
    goalId: null,
    blockedBy: [],
    blocks: [],
    labelIds: [],
    labels: [],
    ...overrides,
  });
}

const blockerRef = (issue: Issue): BlockerRef => ({
  id: issue.id,
  identifier: issue.identifier,
  title: issue.title,
  status: issue.status,
  priority: issue.priority,
  assigneeAgentId: issue.assigneeAgentId,
  assigneeUserId: issue.assigneeUserId,
});

const baseCreatedAt = new Date("2026-04-10T12:00:00.000Z").getTime();
const createdAt = (offsetMinutes: number) =>
  new Date(baseCreatedAt + offsetMinutes * 60_000);

// Mirrors the PAP-1953 topology called out in the PAP-2189 plan:
//   1954 Scoping (done)                — root
//   1955 Security scoping (done)       — root
//   1960 Phase 1 (done)      → 1961 Phase 2 (done)
//   1962 Phase 3 (done)      → 1963 Phase 4 (done)
//                                      → 1964 Phase 5 (in_progress)
//                                            → 1965 Phase 6 (blocked)
//                                                  → 1966 Phase 7 (blocked)

const scoping = child({
  id: "issue-pap-1954",
  identifier: "PAP-1954",
  issueNumber: 1954,
  title: "Scoping review",
  status: "done",
  priority: "medium",
  completedAt: createdAt(120),
  createdAt: createdAt(0),
});

const security = child({
  id: "issue-pap-1955",
  identifier: "PAP-1955",
  issueNumber: 1955,
  title: "Security scoping",
  status: "done",
  priority: "medium",
  completedAt: createdAt(180),
  createdAt: createdAt(10),
});

const phase1 = child({
  id: "issue-pap-1960",
  identifier: "PAP-1960",
  issueNumber: 1960,
  title: "Phase 1 — groundwork",
  status: "done",
  priority: "medium",
  completedAt: createdAt(600),
  createdAt: createdAt(20),
});

const phase2 = child({
  id: "issue-pap-1961",
  identifier: "PAP-1961",
  issueNumber: 1961,
  title: "Phase 2 — integration",
  status: "done",
  priority: "medium",
  completedAt: createdAt(720),
  createdAt: createdAt(30),
  blockedBy: [blockerRef(phase1)],
});

const phase3 = child({
  id: "issue-pap-1962",
  identifier: "PAP-1962",
  issueNumber: 1962,
  title: "Phase 3 — data model",
  status: "done",
  priority: "medium",
  completedAt: createdAt(800),
  createdAt: createdAt(40),
});

const phase4 = child({
  id: "issue-pap-1963",
  identifier: "PAP-1963",
  issueNumber: 1963,
  title: "Phase 4 — API surface",
  status: "done",
  priority: "medium",
  completedAt: createdAt(900),
  createdAt: createdAt(50),
  blockedBy: [blockerRef(phase3)],
});

const phase5 = child({
  id: "issue-pap-1964",
  identifier: "PAP-1964",
  issueNumber: 1964,
  title: "Phase 5 — UI polish",
  status: "in_progress",
  priority: "high",
  createdAt: createdAt(60),
  blockedBy: [blockerRef(phase4)],
});

const phase6 = child({
  id: "issue-pap-1965",
  identifier: "PAP-1965",
  issueNumber: 1965,
  title: "Phase 6 — telemetry wiring",
  status: "blocked",
  priority: "medium",
  createdAt: createdAt(70),
  blockedBy: [blockerRef(phase5)],
});

const phase7 = child({
  id: "issue-pap-1966",
  identifier: "PAP-1966",
  issueNumber: 1966,
  title: "Phase 7 — rollout",
  status: "blocked",
  priority: "medium",
  createdAt: createdAt(80),
  blockedBy: [blockerRef(phase6)],
});

const subIssues: Issue[] = [
  scoping,
  security,
  phase1,
  phase2,
  phase3,
  phase4,
  phase5,
  phase6,
  phase7,
];

const viewStateKey = "storybook:sub-issues-workflow:list";
const scopedKey = `${viewStateKey}:${companyId}`;

function hydrateQueries(client: ReturnType<typeof useQueryClient>) {
  client.setQueryData(queryKeys.companies.all, { companies: storybookCompanies, unauthorized: false });
  client.setQueryData(queryKeys.auth.session, storybookAuthSession);
  client.setQueryData(queryKeys.agents.list(companyId), storybookAgents);
  client.setQueryData(queryKeys.projects.list(companyId), storybookProjects);
  client.setQueryData(queryKeys.issues.labels(companyId), storybookIssueLabels);
  client.setQueryData(queryKeys.issues.list(companyId), subIssues);
  client.setQueryData(queryKeys.access.companyUserDirectory(companyId), {
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
  client.setQueryData(queryKeys.instance.experimentalSettings, {
    enableIsolatedWorkspaces: true,
    enableRoutineTriggers: true,
  });
}

function Hydrated({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [ready] = useState(() => {
    hydrateQueries(queryClient);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(scopedKey);
      window.localStorage.removeItem(`${scopedKey}:issue-columns`);
    }
    return true;
  });
  return ready ? children : null;
}

function SubIssuesWorkflowPanel() {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner">
        <div className="mx-auto max-w-5xl space-y-5">
          <header className="space-y-1">
            <div className="paperclip-story__label">Issue Detail · Sub-issues</div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Workflow-sorted sub-issues with checklist affordances
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Fixture mirrors the PAP-1953 topology called out in the PAP-2189
              plan: two standalone scoping items, a Phase 1→2 pair, and a long
              Phase 3→4→5→6→7 chain. The panel renders with
              <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">
                defaultSortField="workflow"
              </code>
              and
              <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">
                showProgressSummary
              </code>
              so reviewers see the full checklist surface in isolation.
            </p>
          </header>
          <div className="rounded-lg border border-border bg-background p-5">
            <IssuesList
              issues={subIssues}
              agents={storybookAgents}
              projects={storybookProjects}
              viewStateKey={viewStateKey}
              defaultSortField="workflow"
              showProgressSummary
              onUpdateIssue={() => undefined}
              createIssueLabel="Sub-issue"
            />
          </div>
        </div>
      </main>
    </div>
  );
}

const meta = {
  title: "UX Labs/Sub-issues Workflow Checklist",
  component: SubIssuesWorkflowPanel,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Review surface for the PAP-2189 checklist-style sub-issues work. Renders the IssuesList component with the Sub-issues panel props so the progress strip, workflow sort, step gutter, current marker, done de-emphasis, and blocker chips are all visible against a PAP-1953-like topology.",
      },
    },
  },
  decorators: [
    (StoryRender) => (
      <Hydrated>
        <StoryRender />
      </Hydrated>
    ),
  ],
} satisfies Meta<typeof SubIssuesWorkflowPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
