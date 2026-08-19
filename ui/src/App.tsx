import { lazy, Suspense, type ComponentType } from "react";
import { Loader2 } from "lucide-react";
import { Navigate, Route, Routes, useActiveCompanyPrefix, useLocation, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { Layout } from "./components/Layout";
import { ConferenceRoomChatGate } from "./components/ConferenceRoomChatGate";
import { PipelinesExperimentalGate } from "./components/PipelinesExperimentalGate";
import { CasesExperimentalGate } from "./components/CasesExperimentalGate";
import { StatusCardsExperimentalGate } from "./components/StatusCardsExperimentalGate";
import { AppsExperimentalGate } from "./components/AppsExperimentalGate";
import { OnboardingWizardVariant } from "./components/OnboardingWizardVariant";
import { CloudAccessGate } from "./components/CloudAccessGate";
import { PaperclipLoading } from "./components/AnimatedPaperclipIcon";
// Pure predicate with no module dependencies of its own — safe to keep on the
// critical path so the /apps/connect entry route can decide synchronously.
import { canEnterAppsConnect } from "./pages/apps/app-connect-policy";

// Route-level code splitting. Previously every one of ~90 pages was
// statically imported here, producing a single ~6.5 MB entry chunk shipped on
// every route (including the issue page). Each page is now loaded lazily so a
// route ships only its own chunk plus shared vendor chunks. Pages are named
// exports, so `lazyPage` unwraps the requested export into a default for
// React.lazy while preserving the component's prop types for JSX below.
function lazyPage<M, K extends keyof M>(loader: () => Promise<M>, name: K): M[K] {
  return lazy(() =>
    loader().then((module) => ({ default: module[name] as ComponentType<unknown> })),
  ) as unknown as M[K];
}

// AGENT_FILTER_TABS is a tiny stable constant the router needs eagerly to
// register per-tab routes; inline it so it does not drag the heavy Agents page
// into the entry chunk. Keep in sync with pages/Agents.tsx.
const AGENT_FILTER_TABS = ["all", "active", "paused", "error", "builtin"] as const;

const Cases = lazyPage(() => import("./pages/Cases"), "Cases");
const CaseDetail = lazyPage(() => import("./pages/CaseDetail"), "CaseDetail");
const Dashboard = lazyPage(() => import("./pages/Dashboard"), "Dashboard");
const DashboardLive = lazyPage(() => import("./pages/DashboardLive"), "DashboardLive");
const Timeline = lazyPage(() => import("./pages/Timeline"), "Timeline");
const Companies = lazyPage(() => import("./pages/Companies"), "Companies");
const Agents = lazyPage(() => import("./pages/Agents"), "Agents");
const AgentDetail = lazyPage(() => import("./pages/AgentDetail"), "AgentDetail");
const Projects = lazyPage(() => import("./pages/Projects"), "Projects");
const ProjectDetail = lazyPage(() => import("./pages/ProjectDetail"), "ProjectDetail");
const ProjectWorkspaceDetail = lazyPage(() => import("./pages/ProjectWorkspaceDetail"), "ProjectWorkspaceDetail");
const Workspaces = lazyPage(() => import("./pages/Workspaces"), "Workspaces");
const Issues = lazyPage(() => import("./pages/Issues"), "Issues");
const Search = lazyPage(() => import("./pages/Search"), "Search");
const IssueDetail = lazyPage(() => import("./pages/IssueDetail"), "IssueDetail");
const IssueChatLongThreadPerf = lazyPage(() => import("./pages/IssueChatLongThreadPerf"), "IssueChatLongThreadPerf");
// Dev-only harness. Lazy so it never reaches a production entry chunk even if
// the `import.meta.env.DEV` route guard below is not tree-shaken away.
const TaskChatLab = lazyPage(() => import("./pages/TaskChatLab"), "TaskChatLab");
const Routines = lazyPage(() => import("./pages/Routines"), "Routines");
const Learnings = lazyPage(() => import("./pages/Pipelines"), "Learnings");
const PipelineItemDetail = lazyPage(() => import("./pages/Pipelines"), "PipelineItemDetail");
const PipelineItemLegacyRedirect = lazyPage(() => import("./pages/Pipelines"), "PipelineItemLegacyRedirect");
const Pipelines = lazyPage(() => import("./pages/Pipelines"), "Pipelines");
const ReviewQueue = lazyPage(() => import("./pages/Pipelines"), "ReviewQueue");
const PipelineSettings = lazyPage(() => import("./pages/PipelineSettings"), "PipelineSettings");
const StatusCards = lazyPage(() => import("./pages/StatusCards"), "StatusCards");
const RoutineDetail = lazyPage(() => import("./pages/RoutineDetail"), "RoutineDetail");
const UserProfile = lazyPage(() => import("./pages/UserProfile"), "UserProfile");
const ExecutionWorkspaceDetail = lazyPage(() => import("./pages/ExecutionWorkspaceDetail"), "ExecutionWorkspaceDetail");
const Goals = lazyPage(() => import("./pages/Goals"), "Goals");
const Artifacts = lazyPage(() => import("./pages/Artifacts"), "Artifacts");
const GoalDetail = lazyPage(() => import("./pages/GoalDetail"), "GoalDetail");
const Approvals = lazyPage(() => import("./pages/Approvals"), "Approvals");
const ApprovalDetail = lazyPage(() => import("./pages/ApprovalDetail"), "ApprovalDetail");
const Costs = lazyPage(() => import("./pages/Costs"), "Costs");
const CompanyActivity = lazyPage(() => import("./pages/audit/CompanyActivity"), "CompanyActivity");
const Inbox = lazyPage(() => import("./pages/Inbox"), "Inbox");
const WhatNeedsMe = lazyPage(() => import("./pages/WhatNeedsMe"), "WhatNeedsMe");
const DecisionQueuePage = lazyPage(() => import("./pages/DecisionQueuePage"), "DecisionQueuePage");
const BoardChat = lazyPage(() => import("./pages/BoardChat"), "BoardChat");
const CompanySettings = lazyPage(() => import("./pages/CompanySettings"), "CompanySettings");
const CompanyEnvironments = lazyPage(() => import("./pages/CompanyEnvironments"), "CompanyEnvironments");
const BootstrapSetupUxLab = lazyPage(() => import("./pages/BootstrapSetupUxLab"), "BootstrapSetupUxLab");
const ResponsibleUserDenialUxLab = lazyPage(() => import("./pages/ResponsibleUserDenialUxLab"), "ResponsibleUserDenialUxLab");
const CrossIssueCollaborationUxLab = lazyPage(
  () => import("./pages/CrossIssueCollaborationUxLab"),
  "CrossIssueCollaborationUxLab",
);
const CompanySettingsPluginPage = lazyPage(() => import("./pages/CompanySettingsPluginPage"), "CompanySettingsPluginPage");
const CompanyAccess = lazyPage(() => import("./pages/CompanyAccess"), "CompanyAccess");
const CompanyAccessLegacyRoute = lazyPage(() => import("./pages/CompanyAccess"), "CompanyAccessLegacyRoute");
const AdvancedToolsRoute = lazyPage(() => import("./pages/tools/AdvancedToolsRoute"), "AdvancedToolsRoute");
const ProfileWizardRoute = lazyPage(() => import("./pages/tools/profiles/ProfileWizardRoute"), "ProfileWizardRoute");
const ProfileDetailRoute = lazyPage(() => import("./pages/tools/profiles/ProfileDetailRoute"), "ProfileDetailRoute");
const Connections = lazyPage(() => import("./pages/apps/Connections"), "Connections");
const Browse = lazyPage(() => import("./pages/apps/Browse"), "Browse");
const AppsConnect = lazyPage(() => import("./pages/apps/AppsConnect"), "AppsConnect");
const AppsReview = lazyPage(() => import("./pages/apps/AppsReview"), "AppsReview");
const AppDetail = lazyPage(() => import("./pages/apps/AppDetail"), "AppDetail");
const AppNotConnected = lazyPage(() => import("./pages/apps/AppNotConnected"), "AppNotConnected");
const GatewaysList = lazyPage(() => import("./pages/apps/gateways/GatewaysList"), "GatewaysList");
const GatewayDetail = lazyPage(() => import("./pages/apps/gateways/GatewayDetail"), "GatewayDetail");
const CompanyInvites = lazyPage(() => import("./pages/CompanyInvites"), "CompanyInvites");
const CompanySkills = lazyPage(() => import("./pages/CompanySkills"), "CompanySkills");
const SkillStudio = lazyPage(() => import("./pages/SkillStudio"), "SkillStudio");
const Secrets = lazyPage(() => import("./pages/Secrets"), "Secrets");
const CompanyExport = lazyPage(() => import("./pages/CompanyExport"), "CompanyExport");
const CompanyImport = lazyPage(() => import("./pages/CompanyImport"), "CompanyImport");
const DesignGuide = lazyPage(() => import("./pages/DesignGuide"), "DesignGuide");
const InstanceGeneralSettings = lazyPage(() => import("./pages/InstanceGeneralSettings"), "InstanceGeneralSettings");
const InstanceAccess = lazyPage(() => import("./pages/InstanceAccess"), "InstanceAccess");
const InstanceSettings = lazyPage(() => import("./pages/InstanceSettings"), "InstanceSettings");
const InstanceExperimentalSettings = lazyPage(() => import("./pages/InstanceExperimentalSettings"), "InstanceExperimentalSettings");
const ProfileSettings = lazyPage(() => import("./pages/ProfileSettings"), "ProfileSettings");
const PluginManager = lazyPage(() => import("./pages/PluginManager"), "PluginManager");
const PluginSettings = lazyPage(() => import("./pages/PluginSettings"), "PluginSettings");
const AdapterManager = lazyPage(() => import("./pages/AdapterManager"), "AdapterManager");
const PluginPage = lazyPage(() => import("./pages/PluginPage"), "PluginPage");
const OrgChart = lazyPage(() => import("./pages/OrgChart"), "OrgChart");
const NewAgent = lazyPage(() => import("./pages/NewAgent"), "NewAgent");
const AuthPage = lazyPage(() => import("./pages/Auth"), "AuthPage");
const BoardClaimPage = lazyPage(() => import("./pages/BoardClaim"), "BoardClaimPage");
const CliAuthPage = lazyPage(() => import("./pages/CliAuth"), "CliAuthPage");
const InviteLandingPage = lazyPage(() => import("./pages/InviteLanding"), "InviteLandingPage");
const JoinRequestQueue = lazyPage(() => import("./pages/JoinRequestQueue"), "JoinRequestQueue");
const NotFoundPage = lazyPage(() => import("./pages/NotFound"), "NotFoundPage");
import { useCompany } from "./context/CompanyContext";
import { useDialogActions, useDialogState } from "./context/DialogContext";
import { loadLastInboxTab } from "./lib/inbox";
import {
  isOnboardingWizardActive,
  onboardingStepForCompany,
  shouldRedirectCompanylessRouteToOnboarding,
} from "./lib/onboarding-route";
import { useCompanyMission } from "./hooks/useCompanyMission";
import { normalizeRememberedInstanceSettingsPath } from "./lib/instance-settings";

function boardRoutes() {
  return (
    <>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="dashboard/live" element={<DashboardLive />} />
      <Route path="timeline" element={<Timeline />} />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="companies" element={<Companies />} />
      <Route path="company/settings" element={<CompanySettings />} />
      <Route path="company/settings/environments" element={<Navigate to="/company/settings/instance/environments" replace />} />
      <Route path="company/settings/cloud-upstream" element={<Navigate to="/company/export" replace />} />
      <Route path="company/settings/members" element={<CompanyAccess />} />
      <Route path="company/settings/access" element={<CompanyAccessLegacyRoute />} />
      <Route path="company/settings/invites" element={<CompanyInvites />} />
      <Route path="company/export/*" element={<CompanyExport />} />
      <Route path="company/import" element={<CompanyImport />} />
      <Route path="company/settings/secrets" element={<Secrets />} />
      <Route path="company/settings/tools" element={<LegacyToolsSettingsRedirect />} />
      <Route path="company/settings/tools/:tab" element={<LegacyToolsSettingsRedirect />} />
      <Route path="tools" element={<LegacyToolsRedirect />} />
      <Route path="tools/:tab" element={<LegacyToolsRedirect />} />
      <Route element={<AppsExperimentalGate />}>
        <Route path="apps" element={<Browse />} />
        <Route path="apps/browse" element={<Navigate to="/apps" replace />} />
        <Route path="apps/connections" element={<Connections />} />
        <Route path="apps/connect" element={<AppsConnectEntryRoute />} />
        <Route path="apps/connect/:appKey" element={<Navigate to="/apps" replace />} />
        <Route path="apps/connect/:appKey/:stage" element={<Navigate to="/apps" replace />} />
        <Route path="apps/review" element={<AppsReview />} />
        {/* Needs attention folded into Connections (PAP-13254); keep legacy links working. */}
        <Route path="apps/attention" element={<Navigate to="/apps/connections" replace />} />
        <Route path="apps/gateways" element={<GatewaysList />} />
        <Route path="apps/gateways/:gatewayId" element={<Navigate to="overview" replace />} />
        <Route path="apps/gateways/:gatewayId/:tab" element={<GatewayDetail />} />
        <Route path="apps/advanced" element={<AdvancedToolsRoute />} />
        <Route path="apps/advanced/profiles/new" element={<ProfileWizardRoute mode="new" />} />
        <Route path="apps/advanced/profiles/:profileId/edit" element={<ProfileWizardRoute mode="edit" />} />
        <Route path="apps/advanced/profiles/:profileId" element={<ProfileDetailRoute />} />
        <Route path="apps/advanced/:tab" element={<AdvancedToolsRoute />} />
        <Route path="apps/app/:applicationId" element={<AppNotConnected />} />
        <Route path="apps/app/:applicationId/:tab" element={<AppNotConnected />} />
        <Route path="apps/:connectionId" element={<Navigate to="setup" replace />} />
        <Route path="apps/:connectionId/:tab" element={<AppDetail />} />
      </Route>
      <Route path="company/settings/instance" element={<Navigate to="general" replace />} />
      <Route path="company/settings/instance/profile" element={<ProfileSettings />} />
      <Route path="company/settings/instance/general" element={<InstanceGeneralSettings />} />
      <Route path="company/settings/instance/environments" element={<CompanyEnvironments />} />
      <Route path="company/settings/instance/environments/new" element={<CompanyEnvironments mode="create" />} />
      <Route path="company/settings/instance/environments/:environmentId/edit" element={<CompanyEnvironments mode="edit" />} />
      <Route path="company/settings/instance/access" element={<InstanceAccess />} />
      <Route path="company/settings/instance/heartbeats" element={<InstanceSettings />} />
      <Route path="company/settings/instance/experimental" element={<InstanceExperimentalSettings />} />
      <Route path="company/settings/instance/plugins" element={<PluginManager />} />
      <Route path="company/settings/instance/plugins/:pluginId" element={<PluginSettings />} />
      <Route path="company/settings/instance/adapters" element={<AdapterManager />} />
      <Route path="company/settings/:settingsRoutePath/*" element={<CompanySettingsPluginPage />} />
      <Route path="skills/studio" element={<SkillStudio />} />
      <Route path="skills/studio/new" element={<SkillStudio />} />
      <Route path="skills/studio/:skillId" element={<SkillStudio />} />
      <Route path="skills/:skillId/studio" element={<LegacySkillStudioRedirect />} />
      <Route path="skills/*" element={<CompanySkills />} />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="plugins/:pluginId" element={<PluginPage />} />
      <Route path="org" element={<OrgChart />} />
      <Route path="agents" element={<Navigate to="/agents/all" replace />} />
      {AGENT_FILTER_TABS.map((tab) => (
        <Route key={tab} path={`agents/${tab}`} element={<Agents />} />
      ))}
      <Route path="agents/new" element={<NewAgent />} />
      <Route path="agents/:agentId" element={<AgentDetail />} />
      <Route path="agents/:agentId/:tab" element={<AgentDetail />} />
      <Route path="agents/:agentId/runs/:runId" element={<AgentDetail />} />
      <Route path="projects" element={<Projects />} />
      <Route path="projects/:projectId" element={<ProjectDetail />} />
      <Route path="projects/:projectId/overview" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues/:filter" element={<ProjectDetail />} />
      <Route path="projects/:projectId/workspaces/:workspaceId" element={<ProjectWorkspaceDetail />} />
      <Route path="projects/:projectId/workspaces" element={<ProjectDetail />} />
      <Route path="projects/:projectId/configuration" element={<ProjectDetail />} />
      <Route path="projects/:projectId/budget" element={<ProjectDetail />} />
      <Route path="workspaces" element={<Workspaces />} />
      <Route path="issues" element={<Issues />} />
      <Route path="search" element={<Search />} />
      <Route path="issues/all" element={<Navigate to="/issues" replace />} />
      <Route path="issues/active" element={<Navigate to="/issues" replace />} />
      <Route path="issues/backlog" element={<Navigate to="/issues" replace />} />
      <Route path="issues/done" element={<Navigate to="/issues" replace />} />
      <Route path="issues/recent" element={<Navigate to="/issues" replace />} />
      <Route path="issues/:issueId" element={<IssueDetail />} />
      {import.meta.env.DEV ? (
        <Route path="tests/perf/long-thread" element={<IssueChatLongThreadPerf />} />
      ) : null}
      <Route path="routines" element={<Routines />} />
      <Route
        path="cases"
        element={<CasesExperimentalGate><Cases /></CasesExperimentalGate>}
      />
      <Route
        path="cases/:caseIdentifier"
        element={<CasesExperimentalGate><CaseDetail /></CasesExperimentalGate>}
      />
      <Route
        path="status"
        element={<StatusCardsExperimentalGate><StatusCards /></StatusCardsExperimentalGate>}
      />
      <Route
        path="status/:cardId"
        element={<StatusCardsExperimentalGate><StatusCards /></StatusCardsExperimentalGate>}
      />
      {/* Back-compat: the board lived at /status-cards before PAP-15223. */}
      <Route path="status-cards" element={<StatusCardsLegacyRedirect />} />
      <Route path="status-cards/:cardId" element={<StatusCardsLegacyRedirect />} />
      <Route
        path="review-queue"
        element={<PipelinesExperimentalGate><ReviewQueue /></PipelinesExperimentalGate>}
      />
      <Route
        path="learnings"
        element={<PipelinesExperimentalGate><Learnings /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines"
        element={<PipelinesExperimentalGate><Pipelines /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId"
        element={<PipelinesExperimentalGate><Pipelines /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/add"
        element={<PipelinesExperimentalGate><Pipelines /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/settings"
        element={<PipelinesExperimentalGate><PipelineSettings /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/items/:caseId"
        element={<PipelinesExperimentalGate><PipelineItemDetail /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/cases/:caseId"
        element={<PipelinesExperimentalGate><PipelineItemLegacyRedirect /></PipelinesExperimentalGate>}
      />
      <Route path="routines/:routineId" element={<RoutineDetail />} />
      <Route path="routines/:routineId/:section" element={<RoutineDetail />} />
      <Route path="execution-workspaces/:workspaceId" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/services" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/configuration" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/issues" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/routines" element={<ExecutionWorkspaceDetail />} />
      <Route path="goals" element={<Goals />} />
      <Route path="goals/:goalId" element={<GoalDetail />} />
      <Route path="artifacts" element={<Artifacts />} />
      <Route path="approvals" element={<Navigate to="/approvals/pending" replace />} />
      <Route path="approvals/pending" element={<Approvals />} />
      <Route path="approvals/all" element={<Approvals />} />
      <Route path="approvals/:approvalId" element={<ApprovalDetail />} />
      <Route path="costs" element={<Costs />} />
      <Route path="activity" element={<CompanyActivity />} />
      {/* `/audit` merged into the single Activity page (PAP-16302). Existing deep
          links keep working, preset to the agent-actions scope. */}
      <Route path="audit" element={<Navigate to="/activity?mode=agents" replace />} />
      {/* Conference Room Chat surfaces (PAP-136/PAP-137): routes stay
          registered but redirect to the company home while the experimental
          flag is off. The board-level `artifacts` mount below is the new
          conference-room one; the master-level mount above it still serves
          `/artifacts` in both modes. */}
      <Route element={<ConferenceRoomChatGate />}>
        <Route path="board-chat" element={<BoardChat />} />
        <Route path="artifacts" element={<Artifacts />} />
      </Route>
      {/* Task chat dev harness — dev builds only. */}
      {import.meta.env.DEV ? (
        <Route path="dev/task-chat-lab" element={<TaskChatLab />} />
      ) : null}
      <Route path="decisions" element={<WhatNeedsMe />} />
      <Route path="decisions/queues/:key" element={<DecisionQueuePage />} />
      <Route path="inbox" element={<InboxRootRedirect />} />
      <Route path="inbox/mine" element={<Inbox />} />
      <Route path="inbox/recent" element={<Inbox />} />
      <Route path="inbox/unread" element={<Inbox />} />
      <Route path="inbox/blocked" element={<Inbox />} />
      <Route path="inbox/all" element={<Inbox />} />
      <Route path="inbox/requests" element={<JoinRequestQueue />} />
      <Route path="inbox/new" element={<Navigate to="/inbox/mine" replace />} />
      <Route path="u/:userSlug" element={<UserProfile />} />
      <Route path="design-guide" element={<DesignGuide />} />
      <Route path="instance/settings/adapters" element={<AdapterManager />} />
      <Route path=":pluginRoutePath/*" element={<PluginPage />} />
      <Route path="*" element={<NotFoundPage scope="board" />} />
    </>
  );
}

function AppsConnectEntryRoute() {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  return canEnterAppsConnect(searchParams) ? <AppsConnect /> : <Navigate to="/apps" replace />;
}

function InboxRootRedirect() {
  return <Navigate to={`/inbox/${loadLastInboxTab()}`} replace />;
}

function LegacySkillStudioRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();
  const { companyPrefix, skillId } = useParams<{ companyPrefix?: string; skillId?: string }>();

  if (loading) return null;

  const targetCompany =
    (companyPrefix
      ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase())
      : null) ??
    selectedCompany ??
    companies[0] ??
    null;

  if (!targetCompany || !skillId) {
    return <Navigate to="/skills/studio" replace />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}/skills/studio/${encodeURIComponent(skillId)}${location.search}${location.hash}`}
      replace
    />
  );
}

function LegacySettingsRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();

  if (loading) {
    return <PaperclipLoading />;
  }

  const targetCompany =
    (companyPrefix
      ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase())
      : null) ??
    selectedCompany ??
    companies[0] ??
    null;

  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  const normalizedPath = normalizeRememberedInstanceSettingsPath(
    `${location.pathname}${location.search}${location.hash}`,
  );

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${normalizedPath}`}
      replace
    />
  );
}

function LegacyToolsSettingsRedirect() {
  const { tab } = useParams<{ tab?: string }>();
  return <Navigate to={legacyToolsRedirectTarget(tab)} replace />;
}

// The developer "Tools" surface moved under the Apps "Advanced setup" door
// (PAP-10862). `/tools` and `/tools/:tab` redirect to their new home.
function LegacyToolsRedirect() {
  const { tab } = useParams<{ tab?: string }>();
  return <Navigate to={legacyToolsRedirectTarget(tab)} replace />;
}

function legacyToolsRedirectTarget(tab?: string) {
  if (!tab) return "/apps/advanced/profiles";
  if (tab === "applications" || tab === "connections" || tab === "overview" || tab === "examples") return "/apps/connections";
  return `/apps/advanced/${tab}`;
}

export function OnboardingRoutePage() {
  const { companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { onboardingOpen, onboardingRouteDismissed } = useDialogState();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const matchedCompany = companyPrefix
    ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase()) ?? null
    : null;
  // Which step this company belongs on, by the same rule the route resolver
  // and the dashboard already use. Resolved above the early return below,
  // because a hook cannot be called after it.
  const { hasMission } = useCompanyMission(matchedCompany?.id ?? null);

  // The OnboardingWizard auto-opens on this route (and can also be opened
  // explicitly). While it is showing it covers the whole screen, so the
  // launcher card below must not stay interactive behind it — otherwise users
  // can tab/click through to the form behind the modal (PAP-52). The launcher
  // only needs to render as a re-entry point once the wizard is dismissed.
  if (isOnboardingWizardActive({ onboardingOpen, routeDismissed: onboardingRouteDismissed })) {
    return null;
  }

  const title = matchedCompany
    ? `Add another agent to ${matchedCompany.name}`
    : companies.length > 0
      ? "Create another company"
      : "Create your first company";
  const description = matchedCompany
    ? "Run onboarding again to add an agent and a starter task for this company."
    : companies.length > 0
      ? "Run onboarding again to create another company and seed its first agent."
      : "Get started by creating a company and your first agent.";

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4">
          <Button
            onClick={() =>
              matchedCompany
                ? openOnboarding({
                    // "Add another agent" to a company that already has its
                    // mission must not stop to ask for the mission again. An
                    // unsettled or failed lookup reads as "no mission" and
                    // costs the step, which the customer can pass - and the
                    // mission step now updates the existing goal rather than
                    // adding a second one.
                    initialStep: onboardingStepForCompany(hasMission),
                    companyId: matchedCompany.id,
                  })
                : openOnboarding()
            }
          >
            {matchedCompany ? "Add Agent" : "Start Onboarding"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CompanyRootRedirect() {
  const { companies, selectedCompany, loading } = useCompany();
  const location = useLocation();

  if (loading) {
    return <PaperclipLoading />;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return <Navigate to={`/${targetCompany.issuePrefix}/dashboard`} replace />;
}

function StatusCardsLegacyRedirect() {
  const { cardId } = useParams<{ cardId?: string }>();
  const prefix = useActiveCompanyPrefix();
  const base = prefix ? `/${prefix}` : "";
  return <Navigate to={`${base}/status${cardId ? `/${cardId}` : ""}`} replace />;
}

function UnprefixedBoardRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <PaperclipLoading />;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

function NoCompaniesStartPage() {
  const { openOnboarding } = useDialogActions();
  const { t } = useTranslation();

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">
          {t("app.noCompanies.title", { defaultValue: "Create your first company" })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("app.noCompanies.description", { defaultValue: "Get started by creating a company." })}
        </p>
        <div className="mt-4">
          <Button onClick={() => openOnboarding()}>
            {t("app.noCompanies.newCompany", { defaultValue: "New Company" })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function FullPageRouteFallback() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

export function App() {
  return (
    <>
      <Suspense fallback={<FullPageRouteFallback />}>
      <Routes>
        <Route path="auth" element={<AuthPage />} />
        <Route path="board-claim/:token" element={<BoardClaimPage />} />
        <Route path="cli-auth/:id" element={<CliAuthPage />} />
        <Route path="invite/:token" element={<InviteLandingPage />} />
        <Route path="tests/perf/long-thread" element={<IssueChatLongThreadPerf />} />
        <Route path="ux-lab/bootstrap-setup" element={<BootstrapSetupUxLab />} />
        <Route path="ux-lab/responsible-user-denial" element={<ResponsibleUserDenialUxLab />} />
        <Route path="ux-lab/cross-issue-collaboration" element={<CrossIssueCollaborationUxLab />} />

        <Route element={<CloudAccessGate />}>
          <Route index element={<CompanyRootRedirect />} />
          <Route path="onboarding" element={<OnboardingRoutePage />} />
          <Route path="instance" element={<LegacySettingsRedirect />} />
          <Route path="instance/settings" element={<LegacySettingsRedirect />} />
          <Route path="instance/settings/*" element={<LegacySettingsRedirect />} />
          <Route path="companies" element={<UnprefixedBoardRedirect />} />
          <Route path="issues" element={<UnprefixedBoardRedirect />} />
          <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
          <Route path="routines" element={<UnprefixedBoardRedirect />} />
          <Route path="routines/:routineId" element={<UnprefixedBoardRedirect />} />
          <Route path="review-queue" element={<UnprefixedBoardRedirect />} />
          <Route path="learnings" element={<UnprefixedBoardRedirect />} />
          <Route path="cases" element={<UnprefixedBoardRedirect />} />
          <Route path="cases/:caseIdentifier" element={<UnprefixedBoardRedirect />} />
          <Route path="status" element={<UnprefixedBoardRedirect />} />
          <Route path="status/:cardId" element={<UnprefixedBoardRedirect />} />
          <Route path="status-cards" element={<UnprefixedBoardRedirect />} />
          <Route path="status-cards/:cardId" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/add" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/settings" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/items/:caseId" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/cases/:caseId" element={<UnprefixedBoardRedirect />} />
          <Route path="artifacts" element={<UnprefixedBoardRedirect />} />
          <Route path="audit" element={<UnprefixedBoardRedirect />} />
          <Route path="decisions" element={<UnprefixedBoardRedirect />} />
          <Route path="u/:userSlug" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/studio" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/studio/new" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/studio/:skillId" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/:skillId/studio" element={<LegacySkillStudioRedirect />} />
          <Route path="skills/*" element={<UnprefixedBoardRedirect />} />
          <Route path="settings" element={<LegacySettingsRedirect />} />
          <Route path="settings/*" element={<LegacySettingsRedirect />} />
          <Route path="agents" element={<UnprefixedBoardRedirect />} />
          {AGENT_FILTER_TABS.map((tab) => (
            <Route key={tab} path={`agents/${tab}`} element={<UnprefixedBoardRedirect />} />
          ))}
          <Route path="agents/new" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/:tab" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/runs/:runId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/overview" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues/:filter" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/services" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/routines" element={<UnprefixedBoardRedirect />} />
          <Route path=":companyPrefix" element={<Layout />}>
            {boardRoutes()}
          </Route>
          <Route path="*" element={<NotFoundPage scope="global" />} />
        </Route>
      </Routes>
      </Suspense>
      <OnboardingWizardVariant />
    </>
  );
}
