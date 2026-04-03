import { lazy, Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Layout } from "./components/Layout";
const OnboardingWizard = lazy(() => import("./components/OnboardingWizard").then(m => ({ default: m.OnboardingWizard })));
import { PageSkeleton } from "./components/PageSkeleton";
import { authApi } from "./api/auth";
import { healthApi } from "./api/health";
// Eagerly loaded — frequently accessed list pages
import { Dashboard } from "./pages/Dashboard";
import { Companies } from "./pages/Companies";
import { Agents } from "./pages/Agents";
import { Projects } from "./pages/Projects";
import { Issues } from "./pages/Issues";
import { Routines } from "./pages/Routines";
import { Goals } from "./pages/Goals";
import { Approvals } from "./pages/Approvals";
const Playbooks = lazy(() => import("./pages/Playbooks").then(m => ({ default: m.Playbooks })));
const Library = lazy(() => import("./pages/Library").then(m => ({ default: m.Library })));
import { Inbox } from "./pages/Inbox";
import { Activity } from "./pages/Activity";
// Lazily loaded — detail / heavy pages
const AgentDetail = lazy(() => import("./pages/AgentDetail").then(m => ({ default: m.AgentDetail })));
const ProjectDetail = lazy(() => import("./pages/ProjectDetail").then(m => ({ default: m.ProjectDetail })));
const IssueDetail = lazy(() => import("./pages/IssueDetail").then(m => ({ default: m.IssueDetail })));
const RoutineDetail = lazy(() => import("./pages/RoutineDetail").then(m => ({ default: m.RoutineDetail })));
const ExecutionWorkspaceDetail = lazy(() => import("./pages/ExecutionWorkspaceDetail").then(m => ({ default: m.ExecutionWorkspaceDetail })));
const GoalDetail = lazy(() => import("./pages/GoalDetail").then(m => ({ default: m.GoalDetail })));
const ApprovalDetail = lazy(() => import("./pages/ApprovalDetail").then(m => ({ default: m.ApprovalDetail })));
const Costs = lazy(() => import("./pages/Costs").then(m => ({ default: m.Costs })));
const AgentPerformance = lazy(() => import("./pages/AgentPerformance").then(m => ({ default: m.AgentPerformance })));
const BoardBriefing = lazy(() => import("./pages/BoardBriefing").then(m => ({ default: m.BoardBriefing })));
const KnowledgeBase = lazy(() => import("./pages/KnowledgeBase").then(m => ({ default: m.KnowledgeBase })));
const CompanySettings = lazy(() => import("./pages/CompanySettings").then(m => ({ default: m.CompanySettings })));
const CompanySkills = lazy(() => import("./pages/CompanySkills").then(m => ({ default: m.CompanySkills })));
const CompanyExport = lazy(() => import("./pages/CompanyExport").then(m => ({ default: m.CompanyExport })));
const CompanyImport = lazy(() => import("./pages/CompanyImport").then(m => ({ default: m.CompanyImport })));
const SetupPage = lazy(() => import("./pages/Setup").then(m => ({ default: m.SetupPage })));
const DesignGuide = lazy(() => import("./pages/DesignGuide").then(m => ({ default: m.DesignGuide })));
const OrgChart = lazy(() => import("./pages/OrgChart").then(m => ({ default: m.OrgChart })));
const NewAgent = lazy(() => import("./pages/NewAgent").then(m => ({ default: m.NewAgent })));
const RunTranscriptUxLab = lazy(() => import("./pages/RunTranscriptUxLab").then(m => ({ default: m.RunTranscriptUxLab })));
const PluginManager = lazy(() => import("./pages/PluginManager").then(m => ({ default: m.PluginManager })));
const PluginSettings = lazy(() => import("./pages/PluginSettings").then(m => ({ default: m.PluginSettings })));
const PluginPage = lazy(() => import("./pages/PluginPage").then(m => ({ default: m.PluginPage })));
const InstanceGeneralSettings = lazy(() => import("./pages/InstanceGeneralSettings").then(m => ({ default: m.InstanceGeneralSettings })));
const InstanceSettings = lazy(() => import("./pages/InstanceSettings").then(m => ({ default: m.InstanceSettings })));
const InstanceExperimentalSettings = lazy(() => import("./pages/InstanceExperimentalSettings").then(m => ({ default: m.InstanceExperimentalSettings })));
const PrivacySettings = lazy(() => import("./pages/PrivacySettings").then(m => ({ default: m.PrivacySettings })));
// Admin panel — lazy loaded, instance admin only
const AdminLayout = lazy(() => import("./pages/admin/AdminLayout"));
const AdminDashboard = lazy(() => import("./pages/admin/AdminDashboard"));
const AdminCompanies = lazy(() => import("./pages/admin/AdminCompanies"));
const AdminUsers = lazy(() => import("./pages/admin/AdminUsers"));
const AdminMonitoring = lazy(() => import("./pages/admin/AdminMonitoring"));
const AdminAuditLog = lazy(() => import("./pages/admin/AdminAuditLog"));
const AdminAnalytics = lazy(() => import("./pages/admin/AdminAnalytics"));
const AdminSupport = lazy(() => import("./pages/admin/AdminSupport"));
import { CookieConsentBanner } from "./components/CookieConsent";
import { PrivacyPolicy } from "./pages/PrivacyPolicy";
import { TermsOfService } from "./pages/TermsOfService";
import { AcceptableUsePolicy } from "./pages/AcceptableUsePolicy";
import { DataProcessingAgreement } from "./pages/DataProcessingAgreement";
import { ServiceLevelAgreement } from "./pages/ServiceLevelAgreement";
import { LegalIndex } from "./pages/LegalIndex";
import { AuthPage } from "./pages/Auth";
import { BoardClaimPage } from "./pages/BoardClaim";
import { CliAuthPage } from "./pages/CliAuth";
import { InviteLandingPage } from "./pages/InviteLanding";
import { UserInviteAcceptPage } from "./pages/UserInviteAccept";
import { NotFoundPage } from "./pages/NotFound";
import { queryKeys } from "./lib/queryKeys";
import { useCompany } from "./context/CompanyContext";
import { useDialog } from "./context/DialogContext";
import { loadLastInboxTab } from "./lib/inbox";
import { shouldRedirectCompanylessRouteToOnboarding } from "./lib/onboarding-route";

// Suspense wrapper for lazy-loaded pages
function LazyPage({ children, variant = "detail" }: { children: React.ReactNode; variant?: "detail" | "list" | "dashboard" }) {
  return <Suspense fallback={<PageSkeleton variant={variant} />}>{children}</Suspense>;
}

function BootstrapPendingPage({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Instance setup required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasActiveInvite
            ? "No instance admin exists yet. A bootstrap invite is already active. Check your Ironworks startup logs for the first admin invite URL, or run this command to rotate it:"
            : "No instance admin exists yet. Run this command in your Ironworks environment to generate the first admin invite URL:"}
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`pnpm ironworksai auth bootstrap-ceo`}
        </pre>
      </div>
    </div>
  );
}

function CloudAccessGate() {
  const location = useLocation();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as
        | { deploymentMode?: "local_trusted" | "authenticated"; bootstrapStatus?: "ready" | "bootstrap_pending" }
        | undefined;
      return data?.deploymentMode === "authenticated" && data.bootstrapStatus === "bootstrap_pending"
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  if (healthQuery.isLoading || (isAuthenticatedMode && sessionQuery.isLoading)) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  if (healthQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error ? healthQuery.error.message : "Failed to load app state"}
      </div>
    );
  }

  if (isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending") {
    return <BootstrapPendingPage hasActiveInvite={healthQuery.data.bootstrapInviteActive} />;
  }

  if (isAuthenticatedMode && !sessionQuery.data) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  return <Outlet />;
}

function boardRoutes() {
  return (
    <>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="companies" element={<Companies />} />
      <Route path="company/settings" element={<LazyPage><CompanySettings /></LazyPage>} />
      <Route path="company/export/*" element={<LazyPage><CompanyExport /></LazyPage>} />
      <Route path="company/import" element={<LazyPage><CompanyImport /></LazyPage>} />
      <Route path="skills/*" element={<LazyPage><CompanySkills /></LazyPage>} />
      <Route path="library" element={<LazyPage variant="list"><Library /></LazyPage>} />
      <Route path="playbooks" element={<LazyPage variant="list"><Playbooks /></LazyPage>} />
      <Route path="privacy-settings" element={<LazyPage><PrivacySettings /></LazyPage>} />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="plugins/:pluginId" element={<LazyPage><PluginPage /></LazyPage>} />
      <Route path="org" element={<LazyPage><OrgChart /></LazyPage>} />
      <Route path="agents" element={<Navigate to="/agents/all" replace />} />
      <Route path="agents/all" element={<Agents />} />
      <Route path="agents/active" element={<Agents />} />
      <Route path="agents/paused" element={<Agents />} />
      <Route path="agents/error" element={<Agents />} />
      <Route path="agents/new" element={<LazyPage><NewAgent /></LazyPage>} />
      <Route path="agents/:agentId" element={<LazyPage><AgentDetail /></LazyPage>} />
      <Route path="agents/:agentId/:tab" element={<LazyPage><AgentDetail /></LazyPage>} />
      <Route path="agents/:agentId/runs/:runId" element={<LazyPage><AgentDetail /></LazyPage>} />
      <Route path="projects" element={<Projects />} />
      <Route path="projects/:projectId" element={<LazyPage><ProjectDetail /></LazyPage>} />
      <Route path="projects/:projectId/overview" element={<LazyPage><ProjectDetail /></LazyPage>} />
      <Route path="projects/:projectId/issues" element={<LazyPage><ProjectDetail /></LazyPage>} />
      <Route path="projects/:projectId/issues/:filter" element={<LazyPage><ProjectDetail /></LazyPage>} />
      <Route path="projects/:projectId/configuration" element={<LazyPage><ProjectDetail /></LazyPage>} />
      <Route path="projects/:projectId/budget" element={<LazyPage><ProjectDetail /></LazyPage>} />
      <Route path="issues" element={<Issues />} />
      <Route path="issues/all" element={<Navigate to="/issues" replace />} />
      <Route path="issues/active" element={<Navigate to="/issues" replace />} />
      <Route path="issues/backlog" element={<Navigate to="/issues" replace />} />
      <Route path="issues/done" element={<Navigate to="/issues" replace />} />
      <Route path="issues/recent" element={<Navigate to="/issues" replace />} />
      <Route path="issues/:issueId" element={<LazyPage><IssueDetail /></LazyPage>} />
      <Route path="routines" element={<Routines />} />
      <Route path="routines/:routineId" element={<LazyPage><RoutineDetail /></LazyPage>} />
      <Route path="execution-workspaces/:workspaceId" element={<LazyPage><ExecutionWorkspaceDetail /></LazyPage>} />
      <Route path="goals" element={<Goals />} />
      <Route path="goals/:goalId" element={<LazyPage><GoalDetail /></LazyPage>} />
      <Route path="approvals" element={<Navigate to="/approvals/pending" replace />} />
      <Route path="approvals/pending" element={<Approvals />} />
      <Route path="approvals/all" element={<Approvals />} />
      <Route path="approvals/:approvalId" element={<LazyPage><ApprovalDetail /></LazyPage>} />
      <Route path="costs" element={<LazyPage variant="list"><Costs /></LazyPage>} />
      <Route path="performance" element={<LazyPage><AgentPerformance /></LazyPage>} />
      <Route path="board-briefing" element={<LazyPage><BoardBriefing /></LazyPage>} />
      <Route path="knowledge" element={<LazyPage variant="list"><KnowledgeBase /></LazyPage>} />
      <Route path="activity" element={<Activity />} />
      <Route path="inbox" element={<InboxRootRedirect />} />
      <Route path="inbox/mine" element={<Inbox />} />
      <Route path="inbox/recent" element={<Inbox />} />
      <Route path="inbox/unread" element={<Inbox />} />
      <Route path="inbox/all" element={<Inbox />} />
      <Route path="inbox/new" element={<Navigate to="/inbox/mine" replace />} />
      <Route path="design-guide" element={<LazyPage><DesignGuide /></LazyPage>} />
      <Route path="tests/ux/runs" element={<LazyPage><RunTranscriptUxLab /></LazyPage>} />
      <Route path=":pluginRoutePath" element={<LazyPage><PluginPage /></LazyPage>} />
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
  const { openOnboarding } = useDialog();
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
                ? openOnboarding({ initialStep: 3, companyId: matchedCompany.id })
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
  const { openOnboarding } = useDialog();

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Create your first company</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Get started by creating a company.
        </p>
        <div className="mt-4">
          <Button onClick={() => openOnboarding()}>New Company</Button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="privacy" element={<PrivacyPolicy />} />
        <Route path="terms" element={<TermsOfService />} />
        <Route path="aup" element={<AcceptableUsePolicy />} />
        <Route path="dpa" element={<DataProcessingAgreement />} />
        <Route path="sla" element={<ServiceLevelAgreement />} />
        <Route path="legal" element={<LegalIndex />} />
        <Route path="auth" element={<AuthPage />} />
        <Route path="setup" element={<LazyPage><SetupPage /></LazyPage>} />
        <Route path="board-claim/:token" element={<BoardClaimPage />} />
        <Route path="cli-auth/:id" element={<CliAuthPage />} />
        <Route path="invite/:token" element={<InviteLandingPage />} />
        <Route path="user-invite/:token" element={<UserInviteAcceptPage />} />

        <Route element={<CloudAccessGate />}>
          <Route index element={<CompanyRootRedirect />} />
          <Route path="onboarding" element={<OnboardingRoutePage />} />
          <Route path="instance" element={<Navigate to="/instance/settings/general" replace />} />
          <Route path="instance/settings" element={<Layout />}>
            <Route index element={<Navigate to="general" replace />} />
            <Route path="general" element={<LazyPage><InstanceGeneralSettings /></LazyPage>} />
            <Route path="heartbeats" element={<LazyPage><InstanceSettings /></LazyPage>} />
            <Route path="experimental" element={<LazyPage><InstanceExperimentalSettings /></LazyPage>} />
            <Route path="plugins" element={<LazyPage><PluginManager /></LazyPage>} />
            <Route path="plugins/:pluginId" element={<LazyPage><PluginSettings /></LazyPage>} />
          </Route>
          <Route path="manage" element={<LazyPage><AdminLayout /></LazyPage>}>
            <Route index element={<LazyPage variant="dashboard"><AdminDashboard /></LazyPage>} />
            <Route path="companies" element={<LazyPage variant="list"><AdminCompanies /></LazyPage>} />
            <Route path="users" element={<LazyPage variant="list"><AdminUsers /></LazyPage>} />
            <Route path="monitoring" element={<LazyPage><AdminMonitoring /></LazyPage>} />
            <Route path="audit" element={<LazyPage><AdminAuditLog /></LazyPage>} />
            <Route path="analytics" element={<LazyPage><AdminAnalytics /></LazyPage>} />
            <Route path="support" element={<LazyPage><AdminSupport /></LazyPage>} />
          </Route>
          <Route path="companies" element={<UnprefixedBoardRedirect />} />
          <Route path="issues" element={<UnprefixedBoardRedirect />} />
          <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
          <Route path="routines" element={<UnprefixedBoardRedirect />} />
          <Route path="routines/:routineId" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/*" element={<UnprefixedBoardRedirect />} />
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
          <Route path="projects/:projectId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="library" element={<UnprefixedBoardRedirect />} />
          <Route path="playbooks" element={<UnprefixedBoardRedirect />} />
          <Route path="performance" element={<UnprefixedBoardRedirect />} />
          <Route path="knowledge" element={<UnprefixedBoardRedirect />} />
          <Route path="tests/ux/runs" element={<UnprefixedBoardRedirect />} />
          <Route path=":companyPrefix" element={<Layout />}>
            {boardRoutes()}
          </Route>
          <Route path="*" element={<NotFoundPage scope="global" />} />
        </Route>
      </Routes>
      <Suspense fallback={null}><OnboardingWizard /></Suspense>
      <CookieConsentBanner />
    </>
  );
}
