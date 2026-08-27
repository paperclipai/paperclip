import { lazy, Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useActiveCompanyPrefix, useLocation, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { Layout } from "./components/Layout";
import { ConferenceRoomChatGate } from "./components/ConferenceRoomChatGate";
import { TaskChatLab } from "./pages/TaskChatLab";
import { PipelinesExperimentalGate } from "./components/PipelinesExperimentalGate";
import { CasesExperimentalGate } from "./components/CasesExperimentalGate";
import { StatusCardsExperimentalGate } from "./components/StatusCardsExperimentalGate";
import { AppsExperimentalGate } from "./components/AppsExperimentalGate";
import { CloudManagedPageGate } from "./components/CloudManagedPageGate";
import { HiddenSettingsPageGate } from "./components/HiddenSettingsPageGate";
import { IsolatedWorkspacesRouteGate } from "./components/IsolatedWorkspacesRouteGate";
import { useHiddenSettings } from "./hooks/useHiddenSettings";
import { Cases } from "./pages/Cases";
import { CaseDetail } from "./pages/CaseDetail";
import { OnboardingWizardVariant } from "./components/OnboardingWizardVariant";
import { CloudAccessGate } from "./components/CloudAccessGate";
import { PaperclipLoading } from "./components/AnimatedPaperclipIcon";
import { Dashboard } from "./pages/Dashboard";
import { DashboardLive } from "./pages/DashboardLive";
import { Timeline } from "./pages/Timeline";
import { Companies } from "./pages/Companies";
import { AGENT_FILTER_TABS, Agents } from "./pages/Agents";
import { AgentDetail } from "./pages/AgentDetail";
import { Projects } from "./pages/Projects";
import { ProjectDetail } from "./pages/ProjectDetail";
import { ProjectWorkspaceDetail } from "./pages/ProjectWorkspaceDetail";
import { Workspaces } from "./pages/Workspaces";
import { Issues } from "./pages/Issues";
import { Search } from "./pages/Search";
import { IssueDetail } from "./pages/IssueDetail";
import { IssueChatLongThreadPerf } from "./pages/IssueChatLongThreadPerf";
import { Routines } from "./pages/Routines";
import { Learnings, PipelineItemDetail, PipelineItemLegacyRedirect, Pipelines, ReviewQueue } from "./pages/Pipelines";
import { PipelineSettings } from "./pages/PipelineSettings";
import { StatusCards } from "./pages/StatusCards";
import { RoutineDetail } from "./pages/RoutineDetail";
import { UserProfile } from "./pages/UserProfile";
import { ExecutionWorkspaceDetail } from "./pages/ExecutionWorkspaceDetail";
import { Goals } from "./pages/Goals";
import { Artifacts } from "./pages/Artifacts";
import { GoalDetail } from "./pages/GoalDetail";
import { Approvals } from "./pages/Approvals";
import { ApprovalDetail } from "./pages/ApprovalDetail";
import { Costs } from "./pages/Costs";
import { CompanyActivity } from "./pages/audit/CompanyActivity";
import { Inbox } from "./pages/Inbox";
import { WhatNeedsMe } from "./pages/WhatNeedsMe";
import { DecisionQueuePage } from "./pages/DecisionQueuePage";
import { BoardChat } from "./pages/BoardChat";
import { CompanySettings } from "./pages/CompanySettings";
import { CompanyEnvironments } from "./pages/CompanyEnvironments";
import { BootstrapSetupUxLab } from "./pages/BootstrapSetupUxLab";
import { ResponsibleUserDenialUxLab } from "./pages/ResponsibleUserDenialUxLab";
import { CrossIssueCollaborationUxLab } from "./pages/CrossIssueCollaborationUxLab";
import { CompanySettingsPluginPage } from "./pages/CompanySettingsPluginPage";
import { CompanyAccess, CompanyAccessLegacyRoute } from "./pages/CompanyAccess";
import { AdvancedToolsRoute } from "./pages/tools/AdvancedToolsRoute";
import { ProfileWizardRoute } from "./pages/tools/profiles/ProfileWizardRoute";
import { ProfileDetailRoute } from "./pages/tools/profiles/ProfileDetailRoute";
import { Connections } from "./pages/apps/Connections";
import { Browse } from "./pages/apps/Browse";
import { AppsConnect } from "./pages/apps/AppsConnect";
import { canEnterAppsConnect } from "./pages/apps/app-connect-policy";
import { AppsReview } from "./pages/apps/AppsReview";
import { AppDetail } from "./pages/apps/AppDetail";
import { AppNotConnected } from "./pages/apps/AppNotConnected";
import { GatewaysList } from "./pages/apps/gateways/GatewaysList";
import { GatewayDetail } from "./pages/apps/gateways/GatewayDetail";
import { CompanySkills } from "./pages/CompanySkills";
import { SkillStudio } from "./pages/SkillStudio";
import { Secrets } from "./pages/Secrets";
import { CompanyImport } from "./pages/CompanyImport";
import { DesignGuide } from "./pages/DesignGuide";
import { InstanceExperimentalSettings } from "./pages/InstanceExperimentalSettings";
import { InstanceAccess } from "./pages/InstanceAccess";
import { ProfileSettings } from "./pages/ProfileSettings";
import { PluginManager } from "./pages/PluginManager";
import { PluginSettings } from "./pages/PluginSettings";
import { AdapterManager } from "./pages/AdapterManager";
import { PluginPage } from "./pages/PluginPage";
import { OrgChart } from "./pages/OrgChart";
import { NewAgent } from "./pages/NewAgent";
import { AuthPage } from "./pages/Auth";
import { BoardClaimPage } from "./pages/BoardClaim";
import { CliAuthPage } from "./pages/CliAuth";
import { InviteLandingPage } from "./pages/InviteLanding";
import { JoinRequestQueue } from "./pages/JoinRequestQueue";
import { NotFoundPage } from "./pages/NotFound";
import { useCompany } from "./context/CompanyContext";
import { useDialogActions, useDialogState } from "./context/DialogContext";
import { loadLastInboxTab } from "./lib/inbox";
import {
  isOnboardingWizardActive,
  onboardingStepForCompany,
  shouldRedirectCompanylessRouteToOnboarding,
} from "./lib/onboarding-route";
import { filterHiddenInstanceSettingsPath, normalizeRememberedInstanceSettingsPath } from "./lib/instance-settings";
import { useCloudInstance } from "./hooks/useCloudInstance";
import { cloudStackCreateUrl } from "./lib/cloudLinks";
import { navigateTopLevel } from "@/lib/browserNavigation";

const CompanyExport = lazy(() =>
  import("./pages/CompanyExport").then((module) => ({ default: module.CompanyExport })),
);

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
      <Route element={<HiddenSettingsPageGate pageKey="company.members" />}>
        <Route path="company/settings/members" element={<CompanyAccess />} />
        <Route path="company/settings/access" element={<CompanyAccessLegacyRoute />} />
      </Route>
      {/* Invites moved into the Members page; the old URL redirects (and stays
          gated so a hidden Invites surface never round-trips through it). */}
      <Route element={<HiddenSettingsPageGate pageKey="company.invites" />}>
        <Route
          path="company/settings/invites"
          element={<Navigate to="/company/settings/members?tab=invites" replace />}
        />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="company.export" />}>
        <Route
          path="company/export/*"
          element={(
            <Suspense fallback={<PaperclipLoading />}>
              <CompanyExport />
            </Suspense>
          )}
        />
      </Route>
      <Route element={<CloudManagedPageGate />}>
        <Route element={<HiddenSettingsPageGate pageKey="company.import" />}>
          <Route path="company/import" element={<CompanyImport />} />
        </Route>
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="company.secrets" />}>
        <Route path="company/settings/secrets" element={<Secrets />} />
      </Route>
      <Route path="company/settings/tools" element={<LegacyToolsSettingsRedirect />} />
      <Route path="company/settings/tools/:tab" element={<LegacyToolsSettingsRedirect />} />
      <Route path="tools" element={<LegacyToolsRedirect />} />
      <Route path="tools/:tab" element={<LegacyToolsRedirect />} />
      <Route element={<AppsExperimentalGate />}>
        <Route path="apps" element={<Browse />} />
        <Route path="apps/browse" element={<Navigate to="/apps" replace />} />
        <Route path="apps/connections" element={<Connections />} />
        <Route path="apps/byo" element={<AppsConnect byoOnly />} />
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
        <Route path="apps/advanced/gateways" element={<GatewaysList />} />
        <Route path="apps/advanced/profiles/new" element={<ProfileWizardRoute mode="new" />} />
        <Route path="apps/advanced/profiles/:profileId/edit" element={<ProfileWizardRoute mode="edit" />} />
        <Route path="apps/advanced/profiles/:profileId" element={<ProfileDetailRoute />} />
        <Route path="apps/advanced/:tab" element={<AdvancedToolsRoute />} />
        <Route path="apps/app/:applicationId" element={<AppNotConnected />} />
        <Route path="apps/app/:applicationId/:tab" element={<AppNotConnected />} />
        <Route path="apps/:connectionId" element={<Navigate to="setup" replace />} />
        <Route path="apps/:connectionId/:tab" element={<AppDetail />} />
      </Route>
      <Route path="company/settings/instance" element={<Navigate to="/company/settings" replace />} />
      <Route element={<HiddenSettingsPageGate pageKey="instance.profile" />}>
        <Route path="company/settings/instance/profile" element={<ProfileSettings />} />
      </Route>
      <Route path="company/settings/instance/general" element={<Navigate to="/company/settings" replace />} />
      <Route path="company/settings/instance/heartbeats" element={<Navigate to="/company/settings" replace />} />
      <Route element={<HiddenSettingsPageGate pageKey="instance.environments" />}>
        <Route path="company/settings/instance/environments" element={<CompanyEnvironments />} />
        <Route path="company/settings/instance/environments/new" element={<CompanyEnvironments mode="create" />} />
        <Route path="company/settings/instance/environments/:environmentId/edit" element={<CompanyEnvironments mode="edit" />} />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="instance.access" />}>
        <Route path="company/settings/instance/access" element={<InstanceAccess />} />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="instance.experimental" />}>
        <Route path="company/settings/instance/experimental" element={<InstanceExperimentalSettings />} />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="instance.plugins" />}>
        <Route path="company/settings/instance/plugins" element={<PluginManager />} />
        <Route path="company/settings/instance/plugins/:pluginId" element={<PluginSettings />} />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="instance.adapters" />}>
        <Route path="company/settings/instance/adapters" element={<AdapterManager />} />
      </Route>
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
      <Route element={<IsolatedWorkspacesRouteGate />}>
        <Route path="projects/:projectId/workspaces/:workspaceId" element={<ProjectWorkspaceDetail />} />
      </Route>
      <Route path="projects/:projectId/workspaces" element={<ProjectDetail />} />
      <Route path="projects/:projectId/configuration" element={<ProjectDetail />} />
      <Route path="projects/:projectId/budget" element={<ProjectDetail />} />
      <Route element={<IsolatedWorkspacesRouteGate />}>
        <Route path="workspaces" element={<Workspaces />} />
      </Route>
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
      <Route element={<IsolatedWorkspacesRouteGate />}>
        <Route path="execution-workspaces/:workspaceId" element={<ExecutionWorkspaceDetail />} />
        <Route path="execution-workspaces/:workspaceId/services" element={<ExecutionWorkspaceDetail />} />
        <Route path="execution-workspaces/:workspaceId/configuration" element={<ExecutionWorkspaceDetail />} />
        <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<ExecutionWorkspaceDetail />} />
        <Route path="execution-workspaces/:workspaceId/issues" element={<ExecutionWorkspaceDetail />} />
        <Route path="execution-workspaces/:workspaceId/routines" element={<ExecutionWorkspaceDetail />} />
      </Route>
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
  const { hidden: hiddenSettings } = useHiddenSettings();

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

  const normalizedPath = filterHiddenInstanceSettingsPath(
    normalizeRememberedInstanceSettingsPath(
      `${location.pathname}${location.search}${location.hash}`,
    ),
    hiddenSettings,
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
  if (tab === "runtime") return "/apps/connections";
  if (tab === "policies") return "/apps/advanced/profiles";
  return `/apps/advanced/${tab}`;
}

export function OnboardingRoutePage() {
  const { companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { t } = useTranslation();
  const cloudInstance = useCloudInstance();
  const createStackUrl = cloudStackCreateUrl(cloudInstance?.cloudBaseUrl ?? null);
  const { onboardingOpen, onboardingRouteDismissed } = useDialogState();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const matchedCompany = companyPrefix
    ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase()) ?? null
    : null;
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
      ? "Create another organization"
      : "Create your first organization";
  const description = matchedCompany
    ? "Run onboarding again to add an agent and a starter task for this organization."
    : companies.length > 0
      ? "Run onboarding again to create another organization and seed its first agent."
      : "Get started by creating an organization and your first agent.";

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4">
          {/* On a managed stack whose Cloud origin is unknown there is nowhere
              to send this click: creation lives on Cloud, and in-app creation
              is a 403 floor. A button that does nothing is worse than none, so
              say why instead of rendering an inert control. */}
          {!matchedCompany && cloudInstance && !createStackUrl ? (
            <p className="text-sm text-muted-foreground">
              {t("app.cloudCreateUnavailable", {
                defaultValue:
                  "Organizations are created in Paperclip Cloud. This instance can't reach it right now — try again from your Cloud portfolio.",
              })}
            </p>
          ) : (
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
                      initialStep: onboardingStepForCompany(),
                      companyId: matchedCompany.id,
                    })
                  : cloudInstance && createStackUrl
                    ? navigateTopLevel(createStackUrl)
                    : openOnboarding()
              }
            >
              {matchedCompany ? "Add Agent" : "Start Onboarding"}
            </Button>
          )}
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
  // A managed stack with no visible companies is a loading or error state, not
  // an invitation to create one in-app — creation lives on Cloud (403 floor).
  const cloudInstance = useCloudInstance();
  const createStackUrl = cloudStackCreateUrl(cloudInstance?.cloudBaseUrl ?? null);

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">
          {t("app.noCompanies.title", { defaultValue: "Create your first organization" })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("app.noCompanies.description", { defaultValue: "Get started by creating an organization." })}
        </p>
        <div className="mt-4">
          {/* Same as the onboarding route: no Cloud origin means nowhere to
              send the click, and in-app creation is a 403 floor here. */}
          {cloudInstance && !createStackUrl ? (
            <p className="text-sm text-muted-foreground">
              {t("app.cloudCreateUnavailable", {
                defaultValue:
                  "Organizations are created in Paperclip Cloud. This instance can't reach it right now — try again from your Cloud portfolio.",
              })}
            </p>
          ) : (
            <Button
              onClick={() =>
                cloudInstance && createStackUrl
                  ? navigateTopLevel(createStackUrl)
                  : openOnboarding()
              }
            >
              {t("app.noCompanies.newCompany", { defaultValue: "New Organization" })}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <>
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
      <OnboardingWizardVariant />
    </>
  );
}
