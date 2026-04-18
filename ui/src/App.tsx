import { Suspense, lazy } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { authApi } from "./api/auth";
import { healthApi } from "./api/health";
import { queryKeys } from "./lib/queryKeys";
import { useCompany } from "./context/CompanyContext";
import { useDialog } from "./context/DialogContext";
import { loadLastInboxTab } from "./lib/inbox";
import { createIssueDetailPath, readLegacyIssueDetailIdentifier } from "./lib/issueDetailBreadcrumb";
import { shouldRedirectCompanylessRouteToOnboarding } from "./lib/onboarding-route";

const Layout = lazy(() => import("./components/Layout").then((module) => ({ default: module.Layout })));
const OnboardingWizard = lazy(() =>
  import("./components/OnboardingWizard").then((module) => ({ default: module.OnboardingWizard })),
);
const Dashboard = lazy(() => import("./pages/Dashboard").then((module) => ({ default: module.Dashboard })));
const Roadmap = lazy(() => import("./pages/Roadmap").then((module) => ({ default: module.Roadmap })));
const Companies = lazy(() => import("./pages/Companies").then((module) => ({ default: module.Companies })));
const Agents = lazy(() => import("./pages/Agents").then((module) => ({ default: module.Agents })));
const AgentDetail = lazy(() => import("./pages/AgentDetail").then((module) => ({ default: module.AgentDetail })));
const Projects = lazy(() => import("./pages/Projects").then((module) => ({ default: module.Projects })));
const ProjectDetail = lazy(() => import("./pages/ProjectDetail").then((module) => ({ default: module.ProjectDetail })));
const ProjectWorkspaceDetail = lazy(() =>
  import("./pages/ProjectWorkspaceDetail").then((module) => ({ default: module.ProjectWorkspaceDetail })),
);
const Issues = lazy(() => import("./pages/Issues").then((module) => ({ default: module.Issues })));
const IssueDetail = lazy(() => import("./pages/IssueDetail").then((module) => ({ default: module.IssueDetail })));
const Routines = lazy(() => import("./pages/Routines").then((module) => ({ default: module.Routines })));
const RoutineDetail = lazy(() => import("./pages/RoutineDetail").then((module) => ({ default: module.RoutineDetail })));
const ExecutionWorkspaceDetail = lazy(() =>
  import("./pages/ExecutionWorkspaceDetail").then((module) => ({ default: module.ExecutionWorkspaceDetail })),
);
const Goals = lazy(() => import("./pages/Goals").then((module) => ({ default: module.Goals })));
const GoalDetail = lazy(() => import("./pages/GoalDetail").then((module) => ({ default: module.GoalDetail })));
const Approvals = lazy(() => import("./pages/Approvals").then((module) => ({ default: module.Approvals })));
const ApprovalDetail = lazy(() =>
  import("./pages/ApprovalDetail").then((module) => ({ default: module.ApprovalDetail })),
);
const Costs = lazy(() => import("./pages/Costs").then((module) => ({ default: module.Costs })));
const Activity = lazy(() => import("./pages/Activity").then((module) => ({ default: module.Activity })));
const Inbox = lazy(() => import("./pages/Inbox").then((module) => ({ default: module.Inbox })));
const CompanySettings = lazy(() =>
  import("./pages/CompanySettings").then((module) => ({ default: module.CompanySettings })),
);
const CompanySkills = lazy(() =>
  import("./pages/CompanySkills").then((module) => ({ default: module.CompanySkills })),
);
const CompanyExport = lazy(() =>
  import("./pages/CompanyExport").then((module) => ({ default: module.CompanyExport })),
);
const CompanyImport = lazy(() =>
  import("./pages/CompanyImport").then((module) => ({ default: module.CompanyImport })),
);
const DesignGuide = lazy(() =>
  import("./pages/DesignGuide").then((module) => ({ default: module.DesignGuide })),
);
const InstanceGeneralSettings = lazy(() =>
  import("./pages/InstanceGeneralSettings").then((module) => ({ default: module.InstanceGeneralSettings })),
);
const InstanceSettings = lazy(() =>
  import("./pages/InstanceSettings").then((module) => ({ default: module.InstanceSettings })),
);
const InstanceExperimentalSettings = lazy(() =>
  import("./pages/InstanceExperimentalSettings").then((module) => ({ default: module.InstanceExperimentalSettings })),
);
const AdapterManager = lazy(() =>
  import("./pages/AdapterManager").then((module) => ({ default: module.AdapterManager })),
);
const PluginManager = lazy(() =>
  import("./pages/PluginManager").then((module) => ({ default: module.PluginManager })),
);
const PluginSettings = lazy(() =>
  import("./pages/PluginSettings").then((module) => ({ default: module.PluginSettings })),
);
const PluginPage = lazy(() => import("./pages/PluginPage").then((module) => ({ default: module.PluginPage })));
const IssueChatUxLab = lazy(() =>
  import("./pages/IssueChatUxLab").then((module) => ({ default: module.IssueChatUxLab })),
);
const RunTranscriptUxLab = lazy(() =>
  import("./pages/RunTranscriptUxLab").then((module) => ({ default: module.RunTranscriptUxLab })),
);
const OrgChart = lazy(() => import("./pages/OrgChart").then((module) => ({ default: module.OrgChart })));
const NewAgent = lazy(() => import("./pages/NewAgent").then((module) => ({ default: module.NewAgent })));
const AuthPage = lazy(() => import("./pages/Auth").then((module) => ({ default: module.AuthPage })));
const BoardClaimPage = lazy(() =>
  import("./pages/BoardClaim").then((module) => ({ default: module.BoardClaimPage })),
);
const CliAuthPage = lazy(() => import("./pages/CliAuth").then((module) => ({ default: module.CliAuthPage })));
const InviteLandingPage = lazy(() =>
  import("./pages/InviteLanding").then((module) => ({ default: module.InviteLandingPage })),
);
const NotFoundPage = lazy(() => import("./pages/NotFound").then((module) => ({ default: module.NotFoundPage })));

function BootstrapPendingPage({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Instance setup required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasActiveInvite
            ? "No instance admin exists yet. A bootstrap invite is already active. Check your Orchestrero startup logs for the first admin invite URL, or run this command to rotate it:"
            : "No instance admin exists yet. Run this command in your Orchestrero environment to generate the first admin invite URL:"}
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`pnpm paperclipai auth bootstrap-ceo`}
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
      <Route path="roadmap" element={<Roadmap />} />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="companies" element={<Companies />} />
      <Route path="company/settings" element={<CompanySettings />} />
      <Route path="company/export/*" element={<CompanyExport />} />
      <Route path="company/import" element={<CompanyImport />} />
      <Route path="skills/*" element={<CompanySkills />} />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="plugins/:pluginId" element={<PluginPage />} />
      <Route path="org" element={<OrgChart />} />
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
      <Route path="issues" element={<Issues />} />
      <Route path="issues/all" element={<Navigate to="/issues" replace />} />
      <Route path="issues/active" element={<Navigate to="/issues" replace />} />
      <Route path="issues/backlog" element={<Navigate to="/issues" replace />} />
      <Route path="issues/done" element={<Navigate to="/issues" replace />} />
      <Route path="issues/recent" element={<Navigate to="/issues" replace />} />
      <Route path="issues/:issueId" element={<IssueDetail />} />
      <Route path="routines" element={<Routines />} />
      <Route path="routines/:routineId" element={<RoutineDetail />} />
      <Route path="execution-workspaces/:workspaceId" element={<ExecutionWorkspaceDetail />} />
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
      <Route path="inbox/all" element={<Inbox />} />
      <Route path="inbox/new" element={<Navigate to="/inbox/mine" replace />} />
      <Route path="design-guide" element={<DesignGuide />} />
      <Route path="tests/ux/chat" element={<IssueChatUxLab />} />
      <Route path="tests/ux/runs" element={<RunTranscriptUxLab />} />
      <Route path="instance/settings/adapters" element={<AdapterManager />} />
      <Route path=":pluginRoutePath" element={<PluginPage />} />
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
  const legacyIssueIdentifier = location.pathname === "/issues"
    ? readLegacyIssueDetailIdentifier(location.search)
    : null;

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

  if (legacyIssueIdentifier) {
    return <Navigate to={`/${targetCompany.issuePrefix}${createIssueDetailPath(legacyIssueIdentifier)}`} replace />;
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
    <Suspense
      fallback={
        <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
          Loading…
        </div>
      }
    >
      <>
        <Routes>
          <Route path="auth" element={<AuthPage />} />
          <Route path="board-claim/:token" element={<BoardClaimPage />} />
          <Route path="cli-auth/:id" element={<CliAuthPage />} />
          <Route path="invite/:token" element={<InviteLandingPage />} />

          <Route element={<CloudAccessGate />}>
            <Route index element={<CompanyRootRedirect />} />
            <Route path="onboarding" element={<OnboardingRoutePage />} />
            <Route path="instance" element={<Navigate to="/instance/settings/general" replace />} />
            <Route path="instance/settings" element={<Layout />}>
              <Route index element={<Navigate to="general" replace />} />
              <Route path="general" element={<InstanceGeneralSettings />} />
              <Route path="heartbeats" element={<InstanceSettings />} />
              <Route path="experimental" element={<InstanceExperimentalSettings />} />
              <Route path="plugins" element={<PluginManager />} />
              <Route path="plugins/:pluginId" element={<PluginSettings />} />
              <Route path="adapters" element={<AdapterManager />} />
            </Route>
            <Route path="companies" element={<UnprefixedBoardRedirect />} />
            <Route path="roadmap" element={<UnprefixedBoardRedirect />} />
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
            <Route path="projects/:projectId/workspaces" element={<UnprefixedBoardRedirect />} />
            <Route path="projects/:projectId/workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
            <Route path="projects/:projectId/configuration" element={<UnprefixedBoardRedirect />} />
            <Route path="execution-workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
            <Route path="tests/ux/chat" element={<UnprefixedBoardRedirect />} />
            <Route path="tests/ux/runs" element={<UnprefixedBoardRedirect />} />
            <Route path=":companyPrefix" element={<Layout />}>
              {boardRoutes()}
            </Route>
            <Route path="*" element={<NotFoundPage scope="global" />} />
          </Route>
        </Routes>
        <OnboardingWizard />
      </>
    </Suspense>
  );
}
