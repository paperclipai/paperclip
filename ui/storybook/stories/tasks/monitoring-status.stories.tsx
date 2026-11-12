import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { Route, Routes, useNavigate } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { IssueDetail } from "@/pages/IssueDetail";
import { Issues } from "@/pages/Issues";
import { Search } from "@/pages/Search";
import { Dashboard } from "@/pages/Dashboard";
import { Inbox } from "@/pages/Inbox";
import { UserProfile } from "@/pages/UserProfile";
import { StatusCardDetailDrawer } from "@/pages/StatusCards/StatusCardDetailDrawer";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { StatusIcon } from "@/components/StatusIcon";
import { IssueStatusBadge } from "@/components/StatusBadge";
import { IssueReferencePill } from "@/components/IssueReferencePill";
import { IssueSiblingNavigation } from "@/components/IssueSiblingNavigation";
import { AgentTaskCard } from "@/components/chat/AgentWorkPanels";
import { installFixtureApi } from "../../support/capability-gaps/api";
import { makeStatusCard } from "../../support/capability-gaps/status-cards";
import { storybookIssues, storybookAgents } from "../../fixtures/paperclipData";
import { instanceExperimentalSettingsSchema, type Issue } from "@paperclipai/shared";

const companyId = "company-storybook";
const nextCheckAt = new Date(Date.now() + 10 * 60_000);
const monitored: Issue = {
  ...storybookIssues[0]!, status: "in_progress", displayStatus: "monitoring",
  title: "Verify deployment after CI completes", identifier: "PAP-120",
  description: "The implementation is ready. The agent will check CI and merge after the checks pass.",
  assigneeAgentId: storybookAgents[0]!.id, assigneeUserId: null,
  executionRunId: null, checkoutRunId: null, activeRun: null,
  monitorNextCheckAt: nextCheckAt, monitorAttemptCount: 2,
  executionPolicy: { mode: "normal", stages: [], commentRequired: false, monitor: { nextCheckAt: nextCheckAt.toISOString(), scheduledBy: "assignee", notes: "Check CI and merge when green." } },
  executionState: null, parentId: null, blockedBy: [], blocks: [],
};
const working: Issue = { ...storybookIssues[1]!, parentId: null, status: "in_progress", displayStatus: "in_progress", title: "Implement the next change" };
const rows = [monitored, working, ...storybookIssues.slice(2)];

function fixtures() {
  return installFixtureApi([
    { path: "/api/workspace-preferences/me", read: () => ({ userId: "user-storybook", coordinatorWorkspaceEnabled: false, updatedAt: null }) },
    { path: "/api/instance/settings/experimental", read: () => instanceExperimentalSettingsSchema.parse({ enableStreamlinedUi: true, enableCombinedInboxTasks: true }) },

    { path: "/api/cli-auth/me", read: () => ({ source: "local_implicit", isInstanceAdmin: true, companyIds: [companyId], memberships: [] }) },
    { path: /^\/api\/issues\/[^/]+\/(feedback-votes|browsers|live-runs|attachments|accepted-plan-decompositions)$/, read: () => [] },
    { path: /^\/api\/issues\/[^/]+\/runner-goal$/, read: () => null },
    { path: /^\/api\/companies\/[^/]+\/email\/tasks\/[^/]+$/, read: () => null },

    { path: `/api/companies/${companyId}/live-runs`, read: () => [] },
    { path: `/api/companies/${companyId}/users/riley/profile`, read: () => ({ user: { id: "user-storybook", slug: "riley", name: "Riley Board", email: "riley@example.com", image: null, membershipRole: "owner", membershipStatus: "active", joinedAt: monitored.createdAt }, stats: [], daily: [], recentIssues: [monitored, working], recentActivity: [], topAgents: [], topProviders: [] }) },
    { path: "/api/status-cards/card-gap/updates", read: () => [] },
    { path: "/api/status-cards/card-gap/dry-run", read: () => ({ cardId: "card-gap", queryVersion: 1, queries: [], mentionedIssues: [monitored] }) },
    { path: `/api/companies/${companyId}/issues`, read: ({ url }) => rows.filter(row => !url.searchParams.has("displayStatus") || url.searchParams.get("displayStatus")!.split(",").includes(row.displayStatus ?? row.status)) },
    { path: `/api/companies/${companyId}/issues/summaries`, read: ({ url }) => rows.filter(row => url.searchParams.get("ids")?.includes(row.id)).map(row => ({ ...row, externalConversationState: null })) },
    { path: `/api/companies/${companyId}/search`, read: () => ({ query: "deployment", normalizedQuery: "deployment", scope: "issues", sort: "relevance", limit: 20, offset: 0, hasMore: false, zeroResults: null,
      countsByType: { issue: 1, artifact: 0, agent: 0, project: 0, comment: 0, document: 0 },
      filterOptionCounts: { status: { in_progress: 1 }, displayStatus: { monitoring: 1 }, priority: {}, assigneeAgentId: {}, assigneeUserId: {}, projectId: {}, labelId: {}, updatedWithin: {} },
      results: [{ id: monitored.id, type: "issue", score: 6000, title: monitored.title, href: `/PAP/issues/${monitored.identifier}`, matchedFields: ["title"], sourceLabel: null, snippet: null, snippets: [], updatedAt: monitored.updatedAt.toISOString(), previewImageUrl: null, issue: { ...monitored, updatedAt: monitored.updatedAt.toISOString() } }] }) },
    { path: /^\/api\/issues\/[^/]+$/, read: ({ url }) => rows.find(row => url.pathname.endsWith(row.id) || url.pathname.endsWith(row.identifier ?? "__none__")) ?? monitored },
    { path: /^\/api\/issues\/[^/]+\/recent-comments$/, read: () => ({ comments: [], hasMore: false, latestCommentId: null }) },
    { path: /^\/api\/issues\/[^/]+\/tree-control\/state$/, read: () => ({ activePauseHold: null }) },
    { path: /^\/api\/issues\/[^/]+\/active-run$/, read: () => null },
    { path: /^\/api\/issues\/[^/]+\/(comments|runs|activity|work-products|documents|interactions)$/, read: () => [] },
    { path: /^\/api\/issues\/[^/]+\/queued-comments$/, read: () => ({ queues: [], items: [], revision: "monitoring-story" }) },
  ]).cleanup;
}

function MonitoringPage({ path }: { path: string }) {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => { const cleanup = fixtures(); navigate(path, { replace: true }); setReady(true); return cleanup; }, [path, navigate]);
  if (!ready) return null;
  return <PluginLauncherProvider><Routes><Route path="/:companyPrefix" element={<Layout />}>
    <Route path="issues" element={<Issues />} />
    <Route path="issues/:issueId" element={<IssueDetail />} />
    <Route path="search" element={<Search />} />
    <Route path="dashboard" element={<Dashboard />} />
    <Route path="inbox" element={<Inbox tab="recent" />} />
    <Route path="users/:userSlug" element={<UserProfile />} />
  </Route></Routes></PluginLauncherProvider>;
}

const meta = {
  id: "tasks-monitoring-status",
  title: "Tasks and conversations/Task creation and lifecycle/Monitoring",
  parameters: { layout: "fullscreen", paperclip: { capabilities: ["tasks/organize", "tasks/properties"], implementation: "production", boundary: "fixtures", notes: "Production task pages and shared indicators with isolated API fixtures. Database projection and execution boundaries are tested separately." } },
  beforeEach: fixtures,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const TaskDetail: Story = { render: () => <MonitoringPage path="/PAP/issues/PAP-120" /> };
export const TaskList: Story = { render: () => <MonitoringPage path="/PAP/issues?view=all" /> };
export const SearchResults: Story = { render: () => <MonitoringPage path="/PAP/search?q=deployment" /> };
export const CompanyDashboard: Story = { render: () => <MonitoringPage path="/PAP/dashboard" /> };
export const InboxRecent: Story = { render: () => <MonitoringPage path="/PAP/inbox" /> };
export const ProfileRecentTasks: Story = { render: () => <MonitoringPage path="/PAP/users/riley" /> };
export const StatusCardWatchedTasks: Story = { render: () => <StatusCardDetailDrawer card={makeStatusCard({ mentionedIssueIds: [monitored.id] })} companyId={companyId} open onOpenChange={() => undefined} initialTab="watched" /> };
export const TaskDetailMobile: Story = { ...TaskDetail, globals: { viewport: { value: "mobile", isRotated: false } }, parameters: { waitForViewport: true } };
export const TaskDetailLight: Story = { ...TaskDetail, globals: { theme: "light" } };
export const TaskDetailDark: Story = { ...TaskDetail, globals: { theme: "dark" } };
export const SharedIndicators: Story = {
  render: () => <div className="mx-auto max-w-3xl space-y-6 p-8">
    <section className="space-y-3"><h2 className="text-lg font-medium">Task status and properties</h2><StatusIcon status="in_progress" displayStatus="monitoring" showLabel onChange={() => undefined} /><IssueStatusBadge status="in_progress" displayStatus="monitoring" /></section>
    <section className="space-y-3"><h2 className="text-lg font-medium">Task references and relationships</h2><IssueReferencePill issue={monitored} /><IssueSiblingNavigation navigation={{ previous: monitored, next: working, currentIndex: 1, totalCount: 3 }} /></section>
    <section className="space-y-3"><h2 className="text-lg font-medium">Agent task card</h2><AgentTaskCard task={monitored} /></section>
  </div>,
  play: async ({ canvasElement }) => { const canvas = within(canvasElement); await expect(canvas.getAllByText("Monitoring", { exact: true })[0]!).toBeVisible(); },
};
