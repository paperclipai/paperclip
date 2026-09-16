import { useEffect, useMemo, useState } from "react";
import type { Issue, IssueComment } from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import { TaskDetailTasksPanel } from "@/components/task-detail/TaskDetailTasksPanel";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { cn, projectRouteRef } from "@/lib/utils";
import { Layout } from "@/components/Layout";
import { IssueDetail } from "@/pages/IssueDetail";
import { ProjectDetail } from "@/pages/ProjectDetail";
import { Navigate, Route, Routes, useParams } from "@/lib/router";
import { seedIssueDetailCache } from "@/lib/issueDetailCache";
import { taskPanelPropertiesTab, taskPanelSubtasksTab, taskPanelDocumentTab, taskPanelArtifactsTab, writeTaskSidePanelState } from "@/lib/task-side-panel-state";
import { createIssue, storybookAgents, storybookCompanies, storybookAuthSession, storybookProjects, storybookIssueDocuments } from "../../fixtures/paperclipData";

// PAP-1953's phase topology is already documented in sub-issues-workflow.stories.
// These are review fixtures, not a claim about the live task's current state.
export const sourceTask = createIssue({
  id: "origin-story-source", identifier: "PAP-1953", issueNumber: 1953,
  title: "Ship the next phase of the board UI",
  status: "in_review",
  executionWorkspaceId: null, currentExecutionWorkspace: null, projectWorkspaceId: null,
  description: "Finish the board UI rollout. Verify each phase and capture any follow-up work in the project where it belongs.",
  checkoutRunId: null, executionRunId: null, executionLockedAt: null,
  labelIds: [], labels: [], workProducts: [],
  createdAt: new Date("2026-09-11T13:00:00Z"), updatedAt: new Date("2026-09-11T14:00:00Z"),
});

const runSources = new Map([
  ["origin-run-legacy", sourceTask.id],
  ["origin-run-native", sourceTask.id],
  ["origin-run-unrelated", "another-source"],
]);

function task(number: number, title: string, status: Issue["status"], parentId: string | null, originRunId = "origin-run-native", projectIndex = 0): Issue {
  const project = storybookProjects[projectIndex]!;
  return createIssue({
    id: `origin-story-${number}`, identifier: `PAP-${number}`, issueNumber: number,
    title, status, parentId, originRunId,
    projectId: project.id, project, projectWorkspaceId: null,
    executionWorkspaceId: null, currentExecutionWorkspace: null,
    createdByAgentId: "agent-codex", createdByUserId: null,
    assigneeAgentId: number % 2 === 0 ? "agent-codex" : "agent-qa",
    checkoutRunId: null, executionRunId: null, executionLockedAt: null,
    labelIds: [], labels: [], blockedBy: [], blocks: [],
    createdAt: new Date("2026-09-11T13:00:00Z"), updatedAt: new Date("2026-09-11T14:00:00Z"),
    lastActivityAt: new Date("2026-09-11T14:00:00Z"), lastExternalCommentAt: null, myLastTouchAt: null, isUnreadForMe: false,
    completedAt: status === "done" ? new Date("2026-09-11T14:00:00Z") : null,
    cancelledAt: status === "cancelled" ? new Date("2026-09-11T14:00:00Z") : null,
  });
}

export const taskCandidates = [
  task(1954, "Scoping review", "done", sourceTask.id, "origin-run-legacy"),
  task(1964, "Phase 5 — UI polish", "in_progress", sourceTask.id),
  task(2189, "Keep task list filters when switching projects", "todo", null, "origin-run-legacy", 1),
  task(1965, "Phase 6 — release verification", "blocked", sourceTask.id),
  task(2190, "Document the new task navigation", "in_review", "docs-parent", "origin-run-native", 1),
  task(1963, "Phase 4 — API surface", "done", sourceTask.id, "origin-run-legacy"),
  task(2191, "Replace the legacy filter popover", "cancelled", null),
  task(2192, "Investigate an unrelated runner timeout", "todo", null, "origin-run-unrelated"),
  { ...task(2193, "Follow up on release notes", "todo", null), projectId: null, project: null },
  task(2194, "Review accessibility", "todo", sourceTask.id, "origin-run-unrelated"),
];

// Model the proposed API projection explicitly. Parentage and creation are
// independent. Deduplicate children created by the source run; never include
// unrelated tasks merely because the same agent created them.
export function tasksForSource(candidates: Issue[]): Issue[] {
  return [...new Map(candidates.filter((item) =>
    item.companyId === sourceTask.companyId && !item.hiddenAt && item.id !== sourceTask.id &&
    (item.parentId === sourceTask.id || (item.originRunId && runSources.get(item.originRunId) === sourceTask.id)),
  ).map((item) => [item.id, item])).values()];
}

export type Scenario = "mixed" | "subtasks" | "other" | "completed" | "empty" | "arrival";
export function scenarioTasks(scenario: Scenario) {
  const items = tasksForSource(taskCandidates);
  if (scenario === "empty" || scenario === "arrival") return [];
  if (scenario === "subtasks") return items.filter((item) => item.parentId === sourceTask.id);
  if (scenario === "other") return items.filter((item) => item.parentId !== sourceTask.id);
  if (scenario === "completed") return items.map((item) => ({ ...item, status: item.status === "cancelled" ? "cancelled" as const : "done" as const }));
  return items;
}

export function SeedData({ children }: { children: React.ReactNode }) {
  const client = useQueryClient();
  const [ready] = useState(() => {
    client.setQueryData(queryKeys.companies.all, { companies: storybookCompanies, unauthorized: false });
    client.setQueryData(queryKeys.auth.session, storybookAuthSession);
    client.setQueryData(queryKeys.agents.list(sourceTask.companyId), storybookAgents);
    client.setQueryData(queryKeys.projects.list(sourceTask.companyId), storybookProjects);
    client.setQueryData(queryKeys.issues.list(sourceTask.companyId), [sourceTask, ...taskCandidates]);
    client.setQueryData(queryKeys.issues.labels(sourceTask.companyId), []);
    client.setQueryData(queryKeys.instance.experimentalSettings, { enableStreamlinedUi: true, enableIsolatedWorkspaces: false });
    client.setQueryData(queryKeys.issues.documents(sourceTask.id), []);
    client.setQueryData(queryKeys.issues.runs(sourceTask.id), []);
    client.setQueryData(queryKeys.issues.liveRuns(sourceTask.id), []);
    client.setQueryData(queryKeys.issues.activeRun(sourceTask.id), null);
    return true;
  });
  return ready ? children : null;
}

export function TasksPanel({ items }: { items: Issue[] }) {
  return <TaskDetailTasksPanel
    subtasks={items.filter((item) => item.parentId === sourceTask.id)}
    createdTasks={items.filter((item) => item.originRunId && runSources.get(item.originRunId) === sourceTask.id)}
    projects={storybookProjects}
  />;
}

const plan = "## Rollout plan\n\n1. Complete scoping and the API surface.\n2. Finish UI polish and verify the release.\n3. Track filter persistence and navigation documentation in their owning projects.\n\n### Acceptance\n\nThe board can inspect every task created during this work, including tasks outside this hierarchy.";

const baseComments: IssueComment[] = [
  { id: "origin-comment-1", companyId: sourceTask.companyId, issueId: sourceTask.id, authorAgentId: null, authorUserId: "user-board", authorType: "user", body: sourceTask.description!, presentation: null, metadata: null, createdAt: new Date("2026-09-11T13:00:00Z"), updatedAt: new Date("2026-09-11T13:00:00Z") },
  { id: "origin-comment-2", companyId: sourceTask.companyId, issueId: sourceTask.id, authorAgentId: "agent-codex", authorUserId: null, authorType: "agent", body: "Scoping and the API surface are complete. UI polish is in progress; release verification is waiting on it.\n\nI also found two follow-ups: filter persistence and navigation docs. I created those in their owning projects so we can track them without changing the rollout hierarchy.", presentation: null, metadata: null, createdAt: new Date("2026-09-11T14:00:00Z"), updatedAt: new Date("2026-09-11T14:00:00Z") },
];


const planDocument = { ...storybookIssueDocuments[0]!, issueId: sourceTask.id, body: plan };
sourceTask.planDocument = planDocument;
sourceTask.documentSummaries = [planDocument];

/** Only replaces data. Every full-page pixel is rendered by the production route. */
function TaskPageData({ children, scenario }: { children: React.ReactNode; scenario: Scenario }) {
  const client = useQueryClient();
  const [fixture] = useState(() => {
    const rows = [sourceTask, ...taskCandidates];
    const comments = scenario === "arrival" ? [] : [baseComments[1]!];
    for (const row of rows) {
      seedIssueDetailCache(client, row);
      for (const ref of [row.id, row.identifier!]) {
        client.setQueryData(queryKeys.issues.comments(ref), { pages: [row.id === sourceTask.id ? [...comments].reverse() : []], pageParams: [null] });
        client.setQueryData(queryKeys.issues.documents(ref), row.id === sourceTask.id ? [planDocument] : []);
        client.setQueryData([...queryKeys.issues.documents(ref), "plan"], row.id === sourceTask.id ? planDocument : null);
        client.setQueryData(queryKeys.issues.liveRuns(ref), []);
        client.setQueryData(queryKeys.issues.activeRun(ref), null);
      }
    }
    client.setQueryData(queryKeys.health, { status: "ok", deploymentMode: "local_trusted", bootstrapStatus: "ready" });
    client.setQueryData(queryKeys.instance.generalSettings, { keyboardShortcuts: true });
    client.setQueryData(queryKeys.access.currentBoardAccess, { companyIds: [] });
    client.setQueryData(queryKeys.issues.listCreatedFromIssue(sourceTask.companyId, sourceTask.id), taskCandidates.filter((row) => row.originRunId && runSources.get(row.originRunId) === sourceTask.id));
    client.setQueryData(queryKeys.issues.listByDescendantRoot(sourceTask.companyId, sourceTask.id), taskCandidates.filter((row) => row.parentId === sourceTask.id));
    const userId = storybookAuthSession.user.id;
    writeTaskSidePanelState(userId, sourceTask.companyId, sourceTask.id, {
      state: {
        tabs: [taskPanelPropertiesTab(), ...(scenario !== "arrival" ? [taskPanelSubtasksTab()] : []), taskPanelDocumentTab("plan", "Plan"), taskPanelArtifactsTab()],
        activeTabId: scenario === "arrival" ? "document:plan" : "subtasks",
      },
      userInteracted: true, autoPlanHandled: true, launcherOpen: false, updatedAt: Date.now(),
    });
    const originalFetch = window.fetch;
    const fetchFixture: typeof fetch = async (input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, window.location.origin);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.pathname === "/api/health") return Response.json({ status: "ok", deploymentMode: "local_trusted", bootstrapStatus: "ready" });
      if (url.pathname === "/api/instance/settings/general") return Response.json({ keyboardShortcuts: true });
      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && method === "GET") {
        const project = storybookProjects.find((item) => item.id === projectMatch[1] || projectRouteRef(item) === projectMatch[1]);
        return project ? Response.json(project) : Response.json({ error: "Project is outside this story" }, { status: 404 });
      }
      const match = url.pathname.match(/^\/api\/issues\/([^/]+)(?:\/(.*))?$/);
      if (match) {
        const row = rows.find((item) => item.id === match[1] || item.identifier === match[1]);
        if (!row) return Response.json({ error: "Task is outside this story" }, { status: 404 });
        const resource = match[2] ?? "";
        if (!resource) {
          if (method === "PATCH") Object.assign(row, JSON.parse(String(init?.body ?? "{}")));
          return Response.json(row);
        }
        if (resource === "comments") {
          if (method === "POST") {
            const body = JSON.parse(String(init?.body ?? "{}"));
            const comment = { ...baseComments[0]!, ...body, id: `story-comment-${comments.length}`, issueId: row.id, createdAt: new Date(), updatedAt: new Date() };
            comments.push(comment);
            return Response.json(comment);
          }
          return Response.json(row.id === sourceTask.id ? [...comments].reverse() : []);
        }
        if (resource === "documents/plan") return row.id === sourceTask.id ? Response.json(planDocument) : Response.json({ error: "No plan" }, { status: 404 });
        if (resource === "documents") return Response.json(row.id === sourceTask.id ? [planDocument] : []);
        if (resource === "active-run") return Response.json(null);
        if (resource === "read") return Response.json({ ok: true });
        if (["interactions", "attachments", "work-products", "live-runs", "runs", "feedback-votes", "activity", "approvals", "references"].includes(resource)) return Response.json([]);
        return Response.json({ error: `Not simulated: ${resource}` }, { status: 404 });
      }
      if (url.pathname === `/api/companies/${sourceTask.companyId}/issues`) {
        const parent = url.searchParams.get("descendantOf") ?? url.searchParams.get("parentId");
        const projectId = url.searchParams.get("projectId");
        const createdFrom = url.searchParams.get("createdFromIssueId");
        const filtered = rows.filter((row) => (!parent || row.parentId === parent) && (!projectId || row.projectId === projectId) && (!createdFrom || (row.originRunId && runSources.get(row.originRunId) === createdFrom)));
        const afterId = url.searchParams.get("afterId");
        const ordered = url.searchParams.get("sortField") === "id"
          ? filtered.sort((a, b) => a.id.localeCompare(b.id)).filter((row) => !afterId || row.id > afterId)
          : filtered;
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? filtered.length);
        return Response.json(ordered.slice(offset, offset + limit));
      }
      return originalFetch(input, init);
    };
    window.fetch = fetchFixture;
    return { restore: () => { if (window.fetch === fetchFixture) window.fetch = originalFetch; } };
  });
  useEffect(() => fixture.restore, [fixture]);
  return children;
}

function TaskRoute({ tasksTab }: { tasksTab?: React.ComponentProps<typeof IssueDetail>["tasksTab"] }) {
  const { issueId } = useParams();
  return <IssueDetail tasksTab={issueId === sourceTask.identifier ? tasksTab : undefined} />;
}

export function OriginatingTasksReview({ scenario = "mixed", fullPage = true, narrow = false, baseline = false }: { scenario?: Scenario; fullPage?: boolean; narrow?: boolean; baseline?: boolean }) {
  const [items, setItems] = useState(() => scenarioTasks(scenario));
  const tasksTab = useMemo(() => ({
    count: items.length,
    content: <TasksPanel items={items} />,
  }), [items]);
  if (!fullPage) return <div className={cn("min-h-screen bg-background p-4 text-foreground", narrow ? "max-w-md" : "max-w-3xl")}>{tasksTab.content}</div>;
  return (
    <TaskPageData scenario={scenario}>
      {scenario === "arrival" && <div className="flex items-center gap-3 border-b border-border p-2 text-xs"><span>Story control</span><Button size="sm" variant="outline" disabled={items.length > 0} onClick={() => setItems(scenarioTasks("other").slice(0, 1))}>Simulate task creation</Button></div>}
      <Routes>
        <Route path="/:companyPrefix" element={<Layout />}>
          <Route path="issues/:issueId" element={<TaskRoute tasksTab={baseline || scenario === "mixed" ? undefined : tasksTab} />} />
          <Route path="projects/:projectId/*" element={<ProjectDetail />} />
        </Route>
        <Route path="*" element={<Navigate to={`/PAP/issues/${sourceTask.identifier}`} replace />} />
      </Routes>
    </TaskPageData>
  );
}
