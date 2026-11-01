import { useState } from "react";
import type { StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { useQueryClient } from "@tanstack/react-query";
import { IssuesList } from "@/components/IssuesList";
import { defaultIssueFilterState } from "@/lib/issue-filters";
import { saveTaskCollectionPreferences } from "@/lib/task-collection-preferences";
import { queryKeys } from "@/lib/queryKeys";
import { createIssue, storybookAgents, storybookAuthSession, storybookCompanies, storybookProjects } from "../fixtures/paperclipData";

const companyId = "company-storybook";
type Story = StoryObj;

function hydrateStorybookQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.setQueryData(queryKeys.companies.all, { companies: storybookCompanies, unauthorized: false });
  queryClient.setQueryData(queryKeys.auth.session, storybookAuthSession);
  queryClient.setQueryData(queryKeys.agents.list(companyId), storybookAgents);
  queryClient.setQueryData(queryKeys.projects.list(companyId), storybookProjects);
  queryClient.setQueryData(queryKeys.instance.experimentalSettings, { enableIsolatedWorkspaces: false, enableStreamlinedUi: true });
}


const creationVisibilityTasks = [
  createIssue({ id: "visibility-human", identifier: "PAP-1701", title: "Human request", createdByUserId: "user-board", createdByAgentId: null }),
  createIssue({ id: "visibility-agent", identifier: "PAP-1702", title: "Agent root task", createdByUserId: null, createdByAgentId: "agent-codex" }),
  createIssue({ id: "visibility-channel", identifier: "PAP-1707", title: "Chat channel task", originKind: "chat_channel", createdByUserId: "user-board", createdByAgentId: null }),
  createIssue({ id: "visibility-routine", identifier: "PAP-1703", title: "Scheduled routine run", originKind: "routine_execution", createdByUserId: null, createdByAgentId: null, responsibleUserId: "user-board" }),
  createIssue({ id: "visibility-child", identifier: "PAP-1704", title: "Agent subtask", parentId: "visibility-human", createdByUserId: null, createdByAgentId: "agent-codex" }),
  createIssue({ id: "visibility-ancestor", identifier: "PAP-1705", title: "Agent ancestor", createdByUserId: null, createdByAgentId: "agent-codex" }),
  createIssue({ id: "visibility-human-child", identifier: "PAP-1706", title: "Human follow-up", parentId: "visibility-ancestor", createdByUserId: "user-board", createdByAgentId: null }),
].map((issue) => ({ ...issue, status: "todo" as const, checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, executionWorkspaceId: null, currentExecutionWorkspace: null, startedAt: null, labelIds: [], labels: [] }));

function CreationVisibilityStory({ included = false }: { included?: boolean }) {
  const queryClient = useQueryClient();
  const viewStateKey = `storybook:agent-created-tasks:${included ? "included" : "hidden"}`;
  useState(() => {
    hydrateStorybookQueries(queryClient);
    saveTaskCollectionPreferences({ companyId, collectionKey: viewStateKey, legacyViewStorageKey: `${viewStateKey}:${companyId}` }, {
      viewState: { ...defaultIssueFilterState, showAgentCreatedTasks: included, viewMode: "list", groupBy: "none", sortField: "updated", sortDir: "desc", nestingEnabled: true, collapsedParents: [], collapsedGroups: [] },
      columns: ["status", "id", "assignee", "updated"],
    });
    const listKey = queryKeys.issues.list(companyId);
    const ancestor = creationVisibilityTasks.find((issue) => issue.id === "visibility-ancestor")!;
    queryClient.setQueryData([...listKey, "hierarchy-ancestors", ancestor.id], [ancestor]);
    queryClient.setQueryData([...listKey, "hierarchy-children", ["visibility-human", "visibility-human-child"], [], 100], { issues: [creationVisibilityTasks.find((issue) => issue.id === "visibility-child")!], hasMore: false });
    return true;
  });
  return (
    <div className="paperclip-story min-h-screen bg-background p-6 text-foreground">
      <IssuesList
        issues={creationVisibilityTasks}
        agents={storybookAgents}
        projects={storybookProjects}
        viewStateKey={viewStateKey}
        enableAgentCreatedVisibilityFilter
        searchWithinLoadedIssues
        rowPresentation="task"
        toolbarPresentation="collection"
        onUpdateIssue={() => undefined}
      />
    </div>
  );
}

const hidden: Story = {
  name: "Agent-created tasks — hidden by default",
  render: () => <CreationVisibilityStory />,
  parameters: { docs: { description: { story: "Production task collection with simulated creation metadata and hierarchy reads. Agent and routine roots are hidden; agent subtasks and ancestors remain as context. Server participation and pagination are covered separately." } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Human request")).toBeVisible();
    await expect(canvas.getByText("Agent subtask")).toBeVisible();
    await expect(canvas.getByText("Agent ancestor")).toBeVisible();
    await expect(canvas.queryByText("Agent root task")).not.toBeInTheDocument();
    await expect(canvas.queryByText("Scheduled routine run")).not.toBeInTheDocument();
    await expect(canvas.queryByText("Chat channel task")).not.toBeInTheDocument();
  },
};

const included: Story = {
  name: "Agent-created tasks — explicit opt-in",
  render: () => <CreationVisibilityStory included />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Agent root task")).toBeVisible();
    await expect(canvas.getByText("Scheduled routine run")).toBeVisible();
    await expect(canvas.getByText("Chat channel task")).toBeVisible();
  },
};

const filter: Story = {
  name: "Agent-created tasks — filter control",
  render: () => <CreationVisibilityStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Human request")).toBeVisible();
    canvas.getByTitle("Filter").click();
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByRole("checkbox", { name: /Show agent-created tasks/ })).not.toBeChecked();
  },
};

export const creationVisibilityStories = { hidden, included, filter };
