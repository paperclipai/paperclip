import { agentAvatarUrl } from "@/lib/agent-avatar-url";
import { useEffect, useState, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { Route, Routes, useLocation, useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Layout } from "@/components/Layout";
import { Agents } from "@/pages/Agents";
import { AgentDetail } from "@/pages/AgentDetail";
import { IssueDetail } from "@/pages/IssueDetail";
import { Dashboard } from "@/pages/Dashboard";
import { NewAgent } from "@/pages/NewAgent";
import { AgentBasicsDialog } from "@/components/new-agent/AgentBasicsDialog";
import { queryKeys } from "@/lib/queryKeys";
import { resolveAgentAppearance } from "@paperclipai/shared";
import { storybookAgents, storybookIssues, storybookActivityEvents, storybookLiveRuns, storybookDashboardSummary } from "../fixtures/paperclipData";

const companyId = "company-storybook";
const agents = storybookAgents.map(agent => {
  const appearance = resolveAgentAppearance(agent.appearance, agent.id);
  return { ...agent, appearance, avatarUrl: agentAvatarUrl(appearance), chainOfCommand: [], access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] } };
});
const liveRuns = storybookLiveRuns.map(run => ({ ...run, agentAppearance: agents.find(agent => agent.id === run.agentId)?.appearance }));
const issue = { ...storybookIssues[0], assigneeAgentId: agents[0].id, status: "in_progress" };

/** Real route components and navigation; all domain data stays in Storybook. */
function installPageFixtures() {
  const previous = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    const path = url.pathname;
    if (!path.startsWith("/api/") || path.startsWith("/api/agent-avatars/")) return previous(input, init);
    const json = (data: unknown) => Response.json(data);
    if (path === "/api/cli-auth/me") return json({ source: "local_implicit", isInstanceAdmin: true, companyIds: [companyId], memberships: [] });
    if (path === "/api/health") return json({ status: "ok", deploymentMode: "local_trusted", authReady: true, bootstrapStatus: "ready" });
    if (path === "/api/instance/settings") return json({ experimental: {} });
    if (path === "/api/instance/settings/experimental") return previous(input, init);
    if (path.endsWith("/resource-memberships/me")) return json({ projectMemberships: {}, agentMemberships: {}, starredProjectIds: [], starredAgentIds: [], starredDocumentIds: [], projectStarredAt: {}, agentStarredAt: {}, documentStarredAt: {}, updatedAt: null });
    if (path === `/api/companies/${companyId}/agents`) return json(agents);
    if (path.endsWith("/dashboard")) return json(storybookDashboardSummary);
    if (path === `/api/companies/${companyId}/activity`) return json(storybookActivityEvents);
    if (path === `/api/companies/${companyId}/live-runs`) return json(liveRuns);
    const agentMatch = path.match(/^\/api\/agents\/([^/]+)(?:\/(.*))?$/);
    if (agentMatch) {
      const agent = agents.find(item => item.id === agentMatch[1] || item.urlKey === agentMatch[1]) ?? agents[0];
      if (!agentMatch[2]) return json(agent);
      if (agentMatch[2] === "runtime-state") return json({ agentId: agent.id, companyId, adapterType: agent.adapterType, stateJson: {}, sessionId: null, sessionDisplayId: null, totalInputTokens: 42000, totalOutputTokens: 8200, totalCostCents: 340, lastRunStatus: "succeeded" });
      if (agentMatch[2] === "skills") return json({ desiredSkills: [], actualSkills: [], errors: [] });
      if (agentMatch[2] === "instructions-bundle") return previous(input, init);
      return json([]);
    }
    const issueMatch = path.match(/^\/api\/issues\/([^/]+)(?:\/(.*))?$/);
    if (issueMatch) {
      const item = storybookIssues.find(row => row.id === issueMatch[1] || row.identifier === issueMatch[1]) ?? issue;
      if (!issueMatch[2]) return json({ ...item, assigneeAgentId: agents[0].id });
      if (issueMatch[2] === "comments") return json([{ id: "persona-comment", issueId: item.id, companyId, authorAgentId: agents[0].id, authorUserId: null, body: "The implementation is ready for review. I’ve checked the edge cases and added coverage for the new behavior.", createdAt: item.updatedAt, updatedAt: item.updatedAt }]);
      if (issueMatch[2] === "active-run") return json(null);
      if (issueMatch[2] === "queued-comments") return json({ queues: [], revision: "storybook", items: [] });
      if (issueMatch[2] === "cost-summary") return json({ costCents: 340, inputTokens: 42000, outputTokens: 8200, runCount: 1 });
      if (issueMatch[2].startsWith("documents/")) return new Response(null, { status: 404 });
      return json([]);
    }
    if (path.endsWith("/budgets/overview")) return json({ companyId, policies: [], activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0, pendingApprovalCount: 0 });
    if (path.includes("/heartbeat-runs/") && path.endsWith("/events")) return json([]);
    // Reuse the preview's auth, company, adapter, issue-list and environment fixtures.
    if (path === "/api/companies" || path.startsWith("/api/auth/") || path.includes("/adapters") || path.includes("/environments") || path.endsWith("/issues") || path.endsWith("/projects") || path.endsWith("/approvals") || path.endsWith("/sidebar-badges") || path.endsWith("/user-directory")) return previous(input, init);
    if (path.includes("/settings")) return json({});
    return json([]);
  };
  return () => { window.fetch = previous; };
}

function PersonaPage({ path, meet = false }: { path: string; meet?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const [ready, setReady] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(meet);
  const initialPath = useRef<string | null>(null);
  useEffect(() => installPageFixtures(), []);
  useEffect(() => {
    if (initialPath.current === path) return;
    initialPath.current = path;
    queryClient.setQueryData(queryKeys.agents.list(companyId), agents);
    // Shared polling elects a leader asynchronously; seed the visible panel so
    // its initial render is independent of that election and the avatar cache.
    queryClient.setQueryData([...queryKeys.liveRuns(companyId), "dashboard", { minRunCount: 4, fetchLimit: undefined }], liveRuns);
    for (const agent of agents) {
      for (const ref of [agent.id, agent.urlKey]) queryClient.setQueryData([...queryKeys.agents.detail(ref!), companyId], agent);
    }
    setSelectedCompanyId(companyId);
    navigate(path, { replace: true });
    setReady(true);
  }, [path, navigate, queryClient, setSelectedCompanyId]);
  if (!ready || selectedCompanyId !== companyId || location.pathname === "/PAP/storybook") return null;
  return <PluginLauncherProvider>
    <Routes>
      <Route path="/:companyPrefix" element={<Layout />}>
        <Route path="agents" element={<Agents />} />
        <Route path="agents/all" element={<Agents />} />
        <Route path="agents/new" element={<NewAgent />} />
        <Route path="agents/:agentId/:tab?" element={<AgentDetail />} />
        <Route path="issues/:issueId" element={<IssueDetail />} />
        <Route path="dashboard" element={<Dashboard />} />
      </Route>
    </Routes>
    {meet && <AgentBasicsDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onContinue={basics => { setDialogOpen(false); navigate(`/PAP/agents/new?name=${encodeURIComponent(basics.name)}&adapterType=${basics.adapterType}`); }} />}
  </PluginLauncherProvider>;
}
const meta = { title: "Agents/Personas/Full pages", parameters: { layout: "fullscreen", a11y: { test: "off" } } } satisfies Meta;
export default meta;
type Story = StoryObj;
export const AllAgents: Story = { render: () => <PersonaPage path="/PAP/agents/all" /> };
export const AgentOverview: Story = { render: () => <PersonaPage path="/PAP/agents/codexcoder/overview" /> };
export const Task: Story = { render: () => <PersonaPage path={`/PAP/issues/${issue.identifier}`} /> };
export const CompanyDashboard: Story = { name: "Dashboard", render: () => <PersonaPage path="/PAP/dashboard" /> };
export const MeetYourNextAgent: Story = { render: () => <PersonaPage path="/PAP/agents/all" meet /> };
export const NewAgentConnection: Story = { render: () => <PersonaPage path="/PAP/agents/new?name=Carl&adapterType=codex_local" /> };
