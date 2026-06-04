import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { Layout } from "./components/Layout";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { CloudAccessGate } from "./components/CloudAccessGate";
import { Dashboard } from "./pages/Dashboard";
import { DashboardLive } from "./pages/DashboardLive";
import { Companies } from "./pages/Companies";
import { Agents } from "./pages/Agents";
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
import { RoutineDetail } from "./pages/RoutineDetail";
import { UserProfile } from "./pages/UserProfile";
import { ExecutionWorkspaceDetail } from "./pages/ExecutionWorkspaceDetail";
import { Goals } from "./pages/Goals";
import { GoalDetail } from "./pages/GoalDetail";
import { Approvals } from "./pages/Approvals";
import { ApprovalDetail } from "./pages/ApprovalDetail";
import { Costs } from "./pages/Costs";
import { Activity } from "./pages/Activity";
import { Inbox } from "./pages/Inbox";
import { CompanySettings } from "./pages/CompanySettings";
import { CompanyEnvironments } from "./pages/CompanyEnvironments";
import { CloudUpstream } from "./pages/CloudUpstream";
import { CloudUpstreamUxLab } from "./pages/CloudUpstreamUxLab";
import { BootstrapSetupUxLab } from "./pages/BootstrapSetupUxLab";
import { CompanySettingsPluginPage } from "./pages/CompanySettingsPluginPage";
import { CompanyAccess, CompanyAccessLegacyRoute } from "./pages/CompanyAccess";
import { CompanyInvites } from "./pages/CompanyInvites";
import { CompanySkills } from "./pages/CompanySkills";
import { Secrets } from "./pages/Secrets";
import { CompanyExport } from "./pages/CompanyExport";
import { CompanyImport } from "./pages/CompanyImport";
import { DesignGuide } from "./pages/DesignGuide";
import { InstanceGeneralSettings } from "./pages/InstanceGeneralSettings";
import { InstanceAccess } from "./pages/InstanceAccess";
import { InstanceSettings } from "./pages/InstanceSettings";
import { InstanceExperimentalSettings } from "./pages/InstanceExperimentalSettings";
import { ProfileSettings } from "./pages/ProfileSettings";
import { PluginManager } from "./pages/PluginManager";
import { PluginSettings } from "./pages/PluginSettings";
import { AdapterManager } from "./pages/AdapterManager";
import { PluginPage } from "./pages/PluginPage";
import { OrgChart } from "./pages/OrgChart";
import { Assets } from "./pages/Assets";
import { AssetDetail } from "./pages/AssetDetail";
import { NewAsset } from "./pages/NewAsset";
import { Pipeline } from "./pages/Pipeline";
import { Forecast } from "./pages/Forecast";
import { Demos } from "./pages/Demos";
import { Channels } from "./pages/Channels";
import { Attribution } from "./pages/Attribution";
import { Funnel } from "./pages/Funnel";
import { CrmHygiene } from "./pages/CrmHygiene";
import { WinLoss } from "./pages/WinLoss";
import { Invoices } from "./pages/Invoices";
import { Campaigns } from "./pages/Campaigns";
import { Targeting } from "./pages/Targeting";
import { Personas } from "./pages/Personas";
import { Products } from "./pages/Products";
import { JustDial } from "./pages/JustDial";
import { Linkedin } from "./pages/Linkedin";
import { Buckets } from "./pages/Buckets";
import { Icps } from "./pages/Icps";
import { Competitors } from "./pages/Competitors";
import { IdeaInbox } from "./pages/IdeaInbox";
import { RssFeeds } from "./pages/RssFeeds";
import { Bofu } from "./pages/Bofu";
import { ContentBriefs } from "./pages/ContentBriefs";
import { Mentions } from "./pages/Mentions";
import { Reviews } from "./pages/Reviews";
import { Sov } from "./pages/Sov";
import { Backlinks } from "./pages/Backlinks";
import { BacklinkProspects } from "./pages/BacklinkProspects";
import { BlogAutomation } from "./pages/BlogAutomation";
import { HookBank } from "./pages/HookBank";
import { YoutubeIdeas } from "./pages/YoutubeIdeas";
import { YoutubeTrends } from "./pages/YoutubeTrends";
import { YoutubeScripts } from "./pages/YoutubeScripts";
import { YoutubeTitles } from "./pages/YoutubeTitles";
import { YoutubeThumbnails } from "./pages/YoutubeThumbnails";
import { YoutubeShorts } from "./pages/YoutubeShorts";
import { YoutubePerformance } from "./pages/YoutubePerformance";
import { RocketInbox } from "./pages/RocketInbox";
import { Approval } from "./pages/Approval";
import { ReplyDrafts } from "./pages/ReplyDrafts";
import { ReplyMining } from "./pages/ReplyMining";
import { Renewals } from "./pages/Renewals";
import { ChangelogQueue } from "./pages/ChangelogQueue";
import { Newsletter } from "./pages/Newsletter";
import { PressReleases } from "./pages/PressReleases";
import { AgnbHealth } from "./pages/AgnbHealth";
import { Producers } from "./pages/Producers";
import { AgnbSync } from "./pages/AgnbSync";
import { AgnbEvents } from "./pages/AgnbEvents";
import { WebhooksCatalog } from "./pages/WebhooksCatalog";
import { ApiAudit } from "./pages/ApiAudit";
import { EntityAudit } from "./pages/EntityAudit";
import { PendingActions } from "./pages/PendingActions";
import { AgnbNotifications } from "./pages/AgnbNotifications";
import { HumanTeam } from "./pages/HumanTeam";
import { MyQueue } from "./pages/MyQueue";
import { Backlog } from "./pages/Backlog";
import { RoutingRules } from "./pages/RoutingRules";
import { Throughput } from "./pages/Throughput";
import { Csv } from "./pages/Csv";
import { Rocket } from "./pages/Rocket";
import { Subjects } from "./pages/Subjects";
import { Experiments } from "./pages/Experiments";
import { BucketCompare } from "./pages/BucketCompare";
import { Cohorts } from "./pages/Cohorts";
import { Tokens } from "./pages/Tokens";
import { Quota } from "./pages/Quota";
import { ContentPerformance } from "./pages/ContentPerformance";
import { Workflows } from "./pages/Workflows";
import { CommentTriage } from "./pages/CommentTriage";
import { NewAgent } from "./pages/NewAgent";
import { AuthPage } from "./pages/Auth";
import { LandingPage } from "./pages/Landing";
import { BoardClaimPage } from "./pages/BoardClaim";
import { CliAuthPage } from "./pages/CliAuth";
import { InviteLandingPage } from "./pages/InviteLanding";
import { JoinRequestQueue } from "./pages/JoinRequestQueue";
import { NotFoundPage } from "./pages/NotFound";
import { useCompany } from "./context/CompanyContext";
import { useDialogActions } from "./context/DialogContext";
import { loadLastInboxTab } from "./lib/inbox";
import { shouldRedirectCompanylessRouteToOnboarding } from "./lib/onboarding-route";

function boardRoutes() {
  return (
    <>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="dashboard/live" element={<DashboardLive />} />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="companies" element={<Companies />} />
      <Route path="company/settings" element={<CompanySettings />} />
      <Route path="company/settings/environments" element={<CompanyEnvironments />} />
      <Route path="company/settings/cloud-upstream" element={<CloudUpstream />} />
      <Route path="company/settings/members" element={<CompanyAccess />} />
      <Route path="company/settings/access" element={<CompanyAccessLegacyRoute />} />
      <Route path="company/settings/cloud-upstream" element={<CloudUpstream />} />
      <Route path="company/settings/invites" element={<CompanyInvites />} />
      <Route path="company/export/*" element={<CompanyExport />} />
      <Route path="company/import" element={<CompanyImport />} />
      <Route path="company/settings/secrets" element={<Secrets />} />
      <Route path="company/settings/:settingsRoutePath/*" element={<CompanySettingsPluginPage />} />
      <Route path="skills/*" element={<CompanySkills />} />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="plugins/:pluginId" element={<PluginPage />} />
      <Route path="org" element={<OrgChart />} />
      <Route path="assets" element={<Assets />} />
      <Route path="assets/new" element={<NewAsset />} />
      <Route path="assets/:assetId" element={<AssetDetail />} />
      <Route path="pipeline" element={<Pipeline />} />
      <Route path="forecast" element={<Forecast />} />
      <Route path="demos" element={<Demos />} />
      <Route path="channels" element={<Channels />} />
      <Route path="attribution" element={<Attribution />} />
      <Route path="funnel" element={<Funnel />} />
      <Route path="crm-hygiene" element={<CrmHygiene />} />
      <Route path="win-loss" element={<WinLoss />} />
      <Route path="invoices" element={<Invoices />} />
      <Route path="campaigns" element={<Campaigns />} />
      <Route path="targeting" element={<Targeting />} />
      <Route path="personas" element={<Personas />} />
      <Route path="products" element={<Products />} />
      <Route path="justdial" element={<JustDial />} />
      <Route path="linkedin" element={<Linkedin />} />
      <Route path="buckets" element={<Buckets />} />
      <Route path="icps" element={<Icps />} />
      <Route path="competitors" element={<Competitors />} />
      <Route path="idea-inbox" element={<IdeaInbox />} />
      <Route path="rss-feeds" element={<RssFeeds />} />
      <Route path="bofu" element={<Bofu />} />
      <Route path="content" element={<ContentBriefs />} />
      <Route path="mentions" element={<Mentions />} />
      <Route path="reviews" element={<Reviews />} />
      <Route path="sov" element={<Sov />} />
      <Route path="backlinks" element={<Backlinks />} />
      <Route path="backlink-prospects" element={<BacklinkProspects />} />
      <Route path="blog-automation" element={<BlogAutomation />} />
      <Route path="linkedin-hooks" element={<HookBank />} />
      <Route path="youtube" element={<YoutubeIdeas />} />
      <Route path="youtube-trends" element={<YoutubeTrends />} />
      <Route path="youtube-scripts" element={<YoutubeScripts />} />
      <Route path="youtube-titles" element={<YoutubeTitles />} />
      <Route path="youtube-thumbnails" element={<YoutubeThumbnails />} />
      <Route path="youtube-shorts" element={<YoutubeShorts />} />
      <Route path="youtube-performance" element={<YoutubePerformance />} />
      <Route path="rocket-inbox" element={<RocketInbox />} />
      <Route path="rocket-approval" element={<Approval />} />
      <Route path="reply-drafts" element={<ReplyDrafts />} />
      <Route path="reply-mining" element={<ReplyMining />} />
      <Route path="renewals" element={<Renewals />} />
      <Route path="changelog-queue" element={<ChangelogQueue />} />
      <Route path="newsletter" element={<Newsletter />} />
      <Route path="press-releases" element={<PressReleases />} />
      <Route path="agnb-health" element={<AgnbHealth />} />
      <Route path="producers" element={<Producers />} />
      <Route path="agnb-sync" element={<AgnbSync />} />
      <Route path="events" element={<AgnbEvents />} />
      <Route path="webhooks-catalog" element={<WebhooksCatalog />} />
      <Route path="audit" element={<ApiAudit />} />
      <Route path="entity-audit" element={<EntityAudit />} />
      <Route path="pending-actions" element={<PendingActions />} />
      <Route path="agnb-notifications" element={<AgnbNotifications />} />
      <Route path="human-team" element={<HumanTeam />} />
      <Route path="my-queue" element={<MyQueue />} />
      <Route path="backlog" element={<Backlog />} />
      <Route path="routing-rules" element={<RoutingRules />} />
      <Route path="throughput" element={<Throughput />} />
      <Route path="csv" element={<Csv />} />
      <Route path="rocket" element={<Rocket />} />
      <Route path="subjects" element={<Subjects />} />
      <Route path="experiments" element={<Experiments />} />
      <Route path="bucket-compare" element={<BucketCompare />} />
      <Route path="cohorts" element={<Cohorts />} />
      <Route path="tokens" element={<Tokens />} />
      <Route path="quota" element={<Quota />} />
      <Route path="content-performance" element={<ContentPerformance />} />
      <Route path="workflows" element={<Workflows />} />
      <Route path="comment-triage" element={<CommentTriage />} />
      <Route path="agents" element={<Navigate to="/agents/all" replace />} />
      <Route path="agents/all" element={<Agents />} />
      <Route path="agents/active" element={<Agents />} />
      <Route path="agents/paused" element={<Agents />} />
      <Route path="agents/error" element={<Agents />} />
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
      <Route path="routines/:routineId" element={<RoutineDetail />} />
      <Route path="execution-workspaces/:workspaceId" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/services" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/configuration" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/issues" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/routines" element={<ExecutionWorkspaceDetail />} />
      <Route path="goals" element={<Goals />} />
      <Route path="goals/:goalId" element={<GoalDetail />} />
      <Route path="approvals" element={<Navigate to="/approvals/pending" replace />} />
      <Route path="approvals/pending" element={<Approvals />} />
      <Route path="approvals/all" element={<Approvals />} />
      <Route path="approvals/:approvalId" element={<ApprovalDetail />} />
      <Route path="costs" element={<Costs />} />
      <Route path="activity" element={<Activity />} />
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

function InboxRootRedirect() {
  return <Navigate to={`/inbox/${loadLastInboxTab()}`} replace />;
}

function LegacySettingsRedirect() {
  const location = useLocation();
  return <Navigate to={`/instance/settings/general${location.search}${location.hash}`} replace />;
}

function OnboardingRoutePage() {
  const { companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const matchedCompany = companyPrefix
    ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase()) ?? null
    : null;

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
                ? openOnboarding({ initialStep: 2, companyId: matchedCompany.id })
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
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
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

function UnprefixedBoardRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
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

export function App() {
  return (
    <>
      <Routes>
        <Route path="auth" element={<LandingPage />} />
        <Route path="auth/login" element={<AuthPage />} />
        <Route path="board-claim/:token" element={<BoardClaimPage />} />
        <Route path="cli-auth/:id" element={<CliAuthPage />} />
        <Route path="invite/:token" element={<InviteLandingPage />} />
        <Route path="tests/perf/long-thread" element={<IssueChatLongThreadPerf />} />
        <Route path="ux-lab/cloud-upstream" element={<CloudUpstreamUxLab />} />
        <Route path="ux-lab/bootstrap-setup" element={<BootstrapSetupUxLab />} />

        <Route element={<CloudAccessGate />}>
          <Route index element={<CompanyRootRedirect />} />
          <Route path="onboarding" element={<OnboardingRoutePage />} />
          <Route path="instance" element={<Navigate to="/instance/settings/general" replace />} />
          <Route path="instance/settings" element={<Layout />}>
            <Route index element={<Navigate to="general" replace />} />
            <Route path="profile" element={<ProfileSettings />} />
            <Route path="general" element={<InstanceGeneralSettings />} />
            <Route path="access" element={<InstanceAccess />} />
            <Route path="heartbeats" element={<InstanceSettings />} />
            <Route path="experimental" element={<InstanceExperimentalSettings />} />
            <Route path="plugins" element={<PluginManager />} />
            <Route path="plugins/:pluginId" element={<PluginSettings />} />
            <Route path="adapters" element={<AdapterManager />} />
          </Route>
          <Route path="companies" element={<UnprefixedBoardRedirect />} />
          <Route path="issues" element={<UnprefixedBoardRedirect />} />
          <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
          <Route path="routines" element={<UnprefixedBoardRedirect />} />
          <Route path="routines/:routineId" element={<UnprefixedBoardRedirect />} />
          <Route path="u/:userSlug" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/*" element={<UnprefixedBoardRedirect />} />
          <Route path="assets" element={<UnprefixedBoardRedirect />} />
          <Route path="assets/new" element={<UnprefixedBoardRedirect />} />
          <Route path="assets/:assetId" element={<UnprefixedBoardRedirect />} />
          <Route path="pipeline" element={<UnprefixedBoardRedirect />} />
          <Route path="forecast" element={<UnprefixedBoardRedirect />} />
          <Route path="demos" element={<UnprefixedBoardRedirect />} />
          <Route path="channels" element={<UnprefixedBoardRedirect />} />
          <Route path="attribution" element={<UnprefixedBoardRedirect />} />
          <Route path="funnel" element={<UnprefixedBoardRedirect />} />
          <Route path="crm-hygiene" element={<UnprefixedBoardRedirect />} />
          <Route path="win-loss" element={<UnprefixedBoardRedirect />} />
          <Route path="invoices" element={<UnprefixedBoardRedirect />} />
          <Route path="campaigns" element={<UnprefixedBoardRedirect />} />
          <Route path="targeting" element={<UnprefixedBoardRedirect />} />
          <Route path="personas" element={<UnprefixedBoardRedirect />} />
          <Route path="products" element={<UnprefixedBoardRedirect />} />
          <Route path="justdial" element={<UnprefixedBoardRedirect />} />
          <Route path="linkedin" element={<UnprefixedBoardRedirect />} />
          <Route path="buckets" element={<UnprefixedBoardRedirect />} />
          <Route path="icps" element={<UnprefixedBoardRedirect />} />
          <Route path="competitors" element={<UnprefixedBoardRedirect />} />
          <Route path="idea-inbox" element={<UnprefixedBoardRedirect />} />
          <Route path="rss-feeds" element={<UnprefixedBoardRedirect />} />
          <Route path="bofu" element={<UnprefixedBoardRedirect />} />
          <Route path="content" element={<UnprefixedBoardRedirect />} />
          <Route path="mentions" element={<UnprefixedBoardRedirect />} />
          <Route path="reviews" element={<UnprefixedBoardRedirect />} />
          <Route path="sov" element={<UnprefixedBoardRedirect />} />
          <Route path="backlinks" element={<UnprefixedBoardRedirect />} />
          <Route path="backlink-prospects" element={<UnprefixedBoardRedirect />} />
          <Route path="blog-automation" element={<UnprefixedBoardRedirect />} />
          <Route path="linkedin-hooks" element={<UnprefixedBoardRedirect />} />
          <Route path="youtube" element={<UnprefixedBoardRedirect />} />
          <Route path="youtube-trends" element={<UnprefixedBoardRedirect />} />
          <Route path="youtube-scripts" element={<UnprefixedBoardRedirect />} />
          <Route path="youtube-titles" element={<UnprefixedBoardRedirect />} />
          <Route path="youtube-thumbnails" element={<UnprefixedBoardRedirect />} />
          <Route path="youtube-shorts" element={<UnprefixedBoardRedirect />} />
          <Route path="youtube-performance" element={<UnprefixedBoardRedirect />} />
          <Route path="rocket-inbox" element={<UnprefixedBoardRedirect />} />
          <Route path="rocket-approval" element={<UnprefixedBoardRedirect />} />
          <Route path="reply-drafts" element={<UnprefixedBoardRedirect />} />
          <Route path="reply-mining" element={<UnprefixedBoardRedirect />} />
          <Route path="renewals" element={<UnprefixedBoardRedirect />} />
          <Route path="changelog-queue" element={<UnprefixedBoardRedirect />} />
          <Route path="newsletter" element={<UnprefixedBoardRedirect />} />
          <Route path="press-releases" element={<UnprefixedBoardRedirect />} />
          <Route path="agnb-health" element={<UnprefixedBoardRedirect />} />
          <Route path="agnb-sync" element={<UnprefixedBoardRedirect />} />
          <Route path="events" element={<UnprefixedBoardRedirect />} />
          <Route path="webhooks-catalog" element={<UnprefixedBoardRedirect />} />
          <Route path="audit" element={<UnprefixedBoardRedirect />} />
          <Route path="entity-audit" element={<UnprefixedBoardRedirect />} />
          <Route path="pending-actions" element={<UnprefixedBoardRedirect />} />
          <Route path="agnb-notifications" element={<UnprefixedBoardRedirect />} />
          <Route path="human-team" element={<UnprefixedBoardRedirect />} />
          <Route path="my-queue" element={<UnprefixedBoardRedirect />} />
          <Route path="backlog" element={<UnprefixedBoardRedirect />} />
          <Route path="routing-rules" element={<UnprefixedBoardRedirect />} />
          <Route path="throughput" element={<UnprefixedBoardRedirect />} />
          <Route path="csv" element={<UnprefixedBoardRedirect />} />
          <Route path="rocket" element={<UnprefixedBoardRedirect />} />
          <Route path="subjects" element={<UnprefixedBoardRedirect />} />
          <Route path="experiments" element={<UnprefixedBoardRedirect />} />
          <Route path="bucket-compare" element={<UnprefixedBoardRedirect />} />
          <Route path="cohorts" element={<UnprefixedBoardRedirect />} />
          <Route path="tokens" element={<UnprefixedBoardRedirect />} />
          <Route path="quota" element={<UnprefixedBoardRedirect />} />
          <Route path="content-performance" element={<UnprefixedBoardRedirect />} />
          <Route path="workflows" element={<UnprefixedBoardRedirect />} />
          <Route path="comment-triage" element={<UnprefixedBoardRedirect />} />
          <Route path="settings" element={<LegacySettingsRedirect />} />
          <Route path="settings/*" element={<LegacySettingsRedirect />} />
          <Route path="agents" element={<UnprefixedBoardRedirect />} />
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
      <OnboardingWizard />
    </>
  );
}
