import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Decorator } from "@storybook/react-vite";
import type { Agent, Issue, ResourceMemberships } from "@paperclipai/shared";
import { Layout } from "@/components/Layout";
import { Layout as ClassicLayout } from "@/components/Layout.production";
import { SidebarAgents } from "@/components/SidebarAgents";
import { Agents } from "@/pages/Agents";
import { Agents as ClassicAgents } from "@/pages/Agents.production";
import { AgentDetail } from "@/pages/AgentDetail";
import { AgentChats } from "@/pages/AgentChats";
import { AgentChat } from "@/pages/AgentChat";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { PrimaryAgentPresentationProvider, usePrimaryAgentPresentation } from "@/components/primary-agent/PrimaryAgentPresentation";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { useDialogActions } from "@/context/DialogContext";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { agentChatDraft } from "@/lib/agent-chat-draft";
import { Navigate, Route, Routes } from "@/lib/router";
import { storybookAgents, storybookAuthSession, storybookCompanies, storybookIssues, storybookDashboardSummary } from "../../fixtures/paperclipData";

export const companyId = "company-storybook";
export const mobile = { viewport: { value: "mobile", isRotated: false } };
export const primaryAgent = { ...storybookAgents[0]!, name: "Maia", urlKey: "maia", title: "Chief of staff", role: "general", status: "idle", reportsTo: null } as Agent;
export const specialist = { ...storybookAgents[1]!, name: "Alex", urlKey: "alex", title: "Product engineer", role: "engineer", status: "idle", reportsTo: null } as Agent;
export const designer = { ...storybookAgents[2]!, name: "Jules", urlKey: "jules", title: "Designer", role: "designer", status: "idle" } as Agent;

export interface PrimaryScenario {
  primaryId?: string | null;
  primaryName?: string;
  paused?: boolean;
  error?: boolean;
  active?: boolean;
  activePrimary?: boolean;
  loading?: boolean;
  failNext?: boolean;
  firstCreated?: boolean;
  classic?: boolean;
  drawer?: boolean;
  recentAssignee?: boolean;
  recentChat?: boolean;
  unavailable?: boolean;
  leftPrimary?: boolean;
}

interface StoryState {
  agents: Agent[];
  memberships: ResourceMemberships;
  chats: Issue[];
  primaryId: string | null;
  options: PrimaryScenario;
}
const StoryStateContext = createContext<StoryState | null>(null);
export function usePrimaryStory() {
  return useContext(StoryStateContext)!;
}

function makeState(options: PrimaryScenario): StoryState {
  const first = { ...primaryAgent, name: options.primaryName || primaryAgent.name, status: options.paused ? "paused" : options.error ? "error" : options.activePrimary ? "running" : "idle" } as Agent;
  return {
    agents: options.firstCreated ? [first] : [...(options.unavailable ? [] : [first]), { ...specialist, status: options.active ? "running" : "idle" }, designer],
    memberships: { projectMemberships: {}, agentMemberships: options.leftPrimary ? { [first.id]: "left" } : {}, starredAgentIds: options.firstCreated ? [] : [specialist.id], starredProjectIds: [], starredDocumentIds: [], agentStarredAt: {}, projectStarredAt: {}, documentStarredAt: {}, updatedAt: null },
    chats: options.recentChat ? [{ ...agentChatDraft(specialist), id: "primary-story-recent-chat", conversationUserId: "user-board", createdAt: new Date("2026-10-07T13:00:00Z"), updatedAt: new Date("2026-10-07T13:05:00Z") }] : [],
    primaryId: options.unavailable || options.leftPrimary ? null : options.primaryId === undefined ? first.id : options.primaryId,
    options,
  };
}

/** All simulated writes are confined to this mounted story. No new API client
 * or server behavior is installed in the application during design review. */
function installFixtures(state: StoryState, changed: () => void) {
  const previousFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (!url.pathname.startsWith("/api/")) return previousFetch(input, init);
    const path = url.pathname;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
    const json = (value: unknown) => Response.json(value);
    if (path === "/api/auth/get-session") return json(storybookAuthSession);
    if (path === "/api/companies") return json([{ ...storybookCompanies[0], name: "Northstar", requireBoardApprovalForNewAgents: false }]);
    if (path === "/api/health") return json({ deploymentMode: "authenticated", status: "ok" });
    if (path === "/api/instance/settings/experimental") return json({ enableStreamlinedUi: !state.options.classic, enableAgentChat: true, enableManagedSandboxOnly: false, enableCombinedInboxTasks: true });
    if (path === "/api/instance/settings") return json({ experimental: { enableStreamlinedUi: !state.options.classic, enableAgentChat: true, enableBuiltInAgents: false, enableEnvironments: false } });
    if (path === "/api/cli-auth/me" || path.endsWith("/access/me")) return json({ user: storybookAuthSession.user, userId: "user-board", source: "authenticated", isInstanceAdmin: false, companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner", status: "active" }], keyId: null });
    if (path.endsWith("/resource-memberships/me")) return json(state.memberships);
    const membership = path.match(/resource-memberships\/me\/agents\/([^/]+)$/);
    if (membership && method === "PUT") {
      const id = membership[1]!;
      const stars = new Set(state.memberships.starredAgentIds);
      if (body.starred === true) stars.add(id);
      if (body.starred === false || body.state === "left") stars.delete(id);
      state.memberships = { ...state.memberships, starredAgentIds: [...stars], agentMemberships: { ...state.memberships.agentMemberships, [id]: body.state ?? "joined" } };
      if (body.state === "left" && state.primaryId === id) state.primaryId = null;
      changed();
      return json({ resourceType: "agent", resourceId: id, state: body.state ?? "joined", starredAt: stars.has(id) ? new Date() : null, updatedAt: new Date() });
    }
    if (path === `/api/companies/${companyId}/agents`) return json(state.agents);
    const detail = path.match(/^\/api\/agents\/([^/]+)$/);
    if (detail) {
      const agent = state.agents.find(a => a.id === detail[1] || a.urlKey === detail[1]);
      return agent ? json({ ...agent, chainOfCommand: [], access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] } }) : new Response(null, { status: 404 });
    }
    const lifecycle = path.match(/^\/api\/agents\/([^/]+)\/(pause|resume|terminate)$/);
    if (lifecycle && method === "POST") {
      const agent = state.agents.find(a => a.id === lifecycle[1])!;
      agent.status = lifecycle[2] === "pause" ? "paused" : lifecycle[2] === "terminate" ? "terminated" : "idle";
      if (agent.status === "terminated") {
        state.agents = state.agents.filter(a => a.id !== agent.id);
        if (state.primaryId === agent.id) state.primaryId = null;
      }
      changed();
      return json(agent);
    }
    if (path.endsWith("/runtime-state") || path.endsWith("/identity")) return json(null);
    if (path.endsWith("/org")) return json(state.agents.map(a => ({ ...a, children: [] })));
    if (path.endsWith("/live-runs")) return json(state.options.active || state.options.activePrimary ? [{ id: "primary-story-run", agentId: state.options.activePrimary ? primaryAgent.id : specialist.id, companyId, status: "running", issueId: null, startedAt: new Date() }] : []);
    if (path.endsWith("/dashboard")) return json(storybookDashboardSummary);
    if (path.endsWith("/sidebar-badges")) return json({ inbox: 0, approvals: 0, failedRuns: 0, joinRequests: 0 });
    if (path.endsWith("/sidebar-preferences/me")) return json({ orderedIds: [], updatedAt: null });
    if (path.endsWith("/user-directory")) return json({ users: [{ principalId: "user-board", status: "active", user: storybookAuthSession.user }] });
    if (path.endsWith("/budgets/overview")) return json({ companyId, policies: [], activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0, pendingApprovalCount: 0 });
    if (path === `/api/companies/${companyId}/chats`) return json(state.chats);
    const chat = path.match(/\/chats\/([^/]+)$/);
    if (chat) {
      const agent = state.agents.find(a => a.id === chat[1] || a.urlKey === chat[1]);
      let issue = state.chats.find(i => i.conversationAgentId === agent?.id);
      if (!issue && method === "POST" && agent) {
        issue = { ...agentChatDraft(agent), id: `primary-chat-${agent.id}`, conversationUserId: "user-board", createdAt: new Date(), updatedAt: new Date() };
        state.chats.push(issue);
      }
      return json(issue ?? null);
    }
    const issueDetail = path.match(/^\/api\/issues\/([^/]+)$/);
    if (issueDetail) return json(state.chats.find(issue => issue.id === issueDetail[1]) ?? null);
    if (path === "/api/issues/primary-story-recent-chat/comments") return json([
      { id: "primary-story-reply", issueId: "primary-story-recent-chat", companyId, authorType: "agent", authorAgentId: specialist.id, authorUserId: null, body: "The mobile navigation update is ready for your review.", presentation: null, metadata: null, createdAt: "2026-10-07T13:05:00Z", updatedAt: "2026-10-07T13:05:00Z" },
      { id: "primary-story-message", issueId: "primary-story-recent-chat", companyId, authorType: "user", authorAgentId: null, authorUserId: "user-board", body: "Can you review the mobile navigation before we launch?", presentation: null, metadata: null, createdAt: "2026-10-07T13:00:00Z", updatedAt: "2026-10-07T13:00:00Z" },
    ]);
    if (path.endsWith("/active-run") || path.endsWith("/documents/plan")) return json(null);
    if (path.endsWith("/tree-control/state")) return json({ activePauseHold: null });
    if (path.includes("/email/tasks/")) return json(null);
    if (path.endsWith("/queued-comments")) return json({ issueId: path.split("/")[3], queueId: null, state: null, targetRunId: null, revision: "0", entries: [] });
    if (path === `/api/companies/${companyId}/issues`) {
      if (method === "POST") return json({ ...storybookIssues[0], ...body, id: "primary-story-task", identifier: "PAP-1642", companyId });
      return json([]);
    }
    if (path.endsWith("/read-state")) return json({ unread: false });
    if (path.endsWith("/capabilities") && path.includes("/environments")) return json({ environments: [], defaultEnvironmentId: null });
    if (path.includes("/models") || path === "/api/adapters" || path.includes("/model-profiles")) return previousFetch(input, init);
    // Other existing read-only shell panels are empty in this isolated company.
    // Refuse unknown writes rather than ever reaching a running Paperclip API.
    return method === "GET" ? json([]) : Response.json({ error: "This action is outside the primary-agent design preview." }, { status: 422 });
  };
  return () => { window.fetch = previousFetch; };
}

function Sandbox({ options, children }: { options: PrimaryScenario; children: ReactNode }) {
  const [state] = useState(() => makeState(options));
  const [ready, setReady] = useState(false);
  const [primaryId, setPrimaryId] = useState(state.primaryId);
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
  const [loading] = useState(Boolean(options.loading));
  const failed = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const client = useQueryClient();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { pushToast, dismissToast } = useToastActions();
  useLayoutEffect(() => {
    const storageKeys = ["paperclip:issue-draft", "paperclip:recent-assignees", `paperclip:recent-assignees:${companyId}`, `paperclip.recentAgentChats:${companyId}:user-board`, ...state.agents.map(a => `paperclip.recentAgentChatIssue:${companyId}:user-board:${a.id}`)];
    const previous = storageKeys.map(key => [key, localStorage.getItem(key)] as const);
    storageKeys.forEach(key => localStorage.removeItem(key));
    const changed = () => {
      setPrimaryId(state.primaryId);
      client.setQueryData(queryKeys.agents.list(companyId), [...state.agents]);
      client.setQueryData(queryKeys.resourceMemberships.mine(companyId), { ...state.memberships });
    };
    const restore = installFixtures(state, changed);
    client.setQueryData(queryKeys.companies.list("user-board"), { companies: [{ ...storybookCompanies[0], name: "Northstar", requireBoardApprovalForNewAgents: false }], unauthorized: false });
    client.setQueryData(queryKeys.auth.session, storybookAuthSession);
    client.setQueryData(queryKeys.agents.list(companyId), state.agents);
    client.setQueryData(queryKeys.resourceMemberships.mine(companyId), state.memberships);
    client.setQueryData(queryKeys.projects.list(companyId), []);
    setSelectedCompanyId(companyId);
    setReady(true);
    return () => {
      restore();
      timers.current.forEach(clearTimeout);
      previous.forEach(([key, value]) => value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value));
    };
  }, [client, setSelectedCompanyId, state]);
  // Review-only simulation: feed the proposed resolved default to the existing
  // composer through its remembered selection. Production resolution is deferred.
  useEffect(() => {
    if (!ready) return;
    const id = options.recentAssignee ? specialist.id : primaryId;
    localStorage.setItem(`paperclip:recent-assignees:${companyId}`, JSON.stringify(id ? [`agent:${id}`] : []));
  }, [ready, primaryId, options.recentAssignee]);
  const changePrimary = (id: string) => {
    const before = state.primaryId;
    setPrimaryId(id);
    setPendingAgentId(id);
    timers.current.push(setTimeout(() => {
      setPendingAgentId(null);
      if (options.failNext && !failed.current) {
        failed.current = true;
        setPrimaryId(before);
        const toastId = pushToast({ title: "Couldn't change your primary agent", body: "Your previous choice is still saved.", tone: "error", action: { label: "Try again", onClick: () => { if (toastId) dismissToast(toastId); changePrimary(id); } } });
      } else {
        state.primaryId = id;
        if (id && state.memberships.agentMemberships[id] === "left") {
          state.memberships = { ...state.memberships, agentMemberships: { ...state.memberships.agentMemberships, [id]: "joined" } };
          client.setQueryData(queryKeys.resourceMemberships.mine(companyId), state.memberships);
        }
      }
    }, 450));
  };
  return ready && selectedCompanyId === companyId ? <StoryStateContext.Provider value={state}>
    <PrimaryAgentPresentationProvider value={{ companyId, primaryAgentId: primaryId, primaryAgent: state.agents.find(agent => agent.id === primaryId) ?? null, pendingAgentId, loading, onChange: changePrimary }}>
      {children}
    </PrimaryAgentPresentationProvider>
  </StoryStateContext.Provider> : null;
}

export const primaryDecorator: Decorator = (Story, context) => <Sandbox key={`${context.id}:${JSON.stringify(context.args)}`} options={{ ...context.parameters.primaryAgent, ...context.args }}><Story /></Sandbox>;
export const primaryParameters = {
  layout: "fullscreen",
  initialEntries: ["/PAP/agents/all"],
  waitForViewport: true,
  docs: { story: { inline: false, height: "850px" }, description: { component: "Design review: shared production surfaces with in-memory preferences and API fixtures. Primary fallback routing and first-creation initialization are simulated here; no persistence, automatic production selection, or agent execution has been implemented." } },
};

function ChatEntry() {
  const state = usePrimaryStory();
  const primary = usePrimaryAgentPresentation(companyId);
  const agent = state.agents.find(a => a.id === (state.options.recentChat ? specialist.id : primary?.primaryAgentId));
  return agent ? <Navigate to={`/PAP/chats/${agent.urlKey}`} replace /> : <AgentChats />;
}

export function PrimaryPage({ task, drawer }: { task?: "primary" | "recent" | "explicit" | "draft"; drawer?: boolean }) {
  const state = usePrimaryStory();
  const { setSidebarOpen } = useSidebar();
  const { openNewIssue } = useDialogActions();
  const launched = useRef(false);
  useEffect(() => {
    if (drawer || state.options.drawer) setSidebarOpen(true);
    if (task && !launched.current) {
      launched.current = true;
      if (task === "draft") {
        localStorage.setItem("paperclip:issue-draft", JSON.stringify({ title: "Review the launch mockups", description: "Keep the mobile navigation compact.", companyId, status: "todo", priority: "medium", assigneeValue: `agent:${designer.id}`, projectId: "", reviewerValue: "", approverValue: "", assigneeModelOverride: "", assigneeThinkingEffort: "", assigneeChrome: false }));
        openNewIssue();
      } else {
        openNewIssue({ title: "Plan next week's launch", ...(task === "explicit" ? { assigneeAgentId: designer.id } : task === "primary" ? { assigneeAgentId: state.primaryId ?? undefined } : {}) });
      }
    }
  }, [drawer, openNewIssue, setSidebarOpen, state, task]);
  return <PluginLauncherProvider><Routes>
    <Route path="/:companyPrefix" element={state.options.classic ? <ClassicLayout /> : <Layout sidebarSections={<SidebarAgents streamlined />} />}>
      <Route path="agents/all" element={state.options.classic ? <ClassicAgents /> : <Agents />} />
      <Route path="agents" element={<Navigate to="/PAP/agents/all" replace />} />
      <Route path="agents/:agentId/:tab?" element={<AgentDetail />} />
      <Route path="chats" element={<ChatEntry />} />
      <Route path="chats/:agentRef" element={<AgentChat />} />
      <Route path="*" element={<Agents />} />
    </Route>
  </Routes></PluginLauncherProvider>;
}
