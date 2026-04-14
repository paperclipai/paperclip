import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { FeedbackModal } from "./FeedbackModal";
import { BugReportModal } from "./BugReportModal";
import { ChangelogModal, ChangelogTrigger } from "./ChangelogModal";
import { StatusBar } from "./StatusBar";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate, useParams } from "@/lib/router";
import { CompanyRail } from "./CompanyRail";
import { Sidebar } from "./Sidebar";
import { InstanceSidebar } from "./InstanceSidebar";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { PropertiesPanel } from "./PropertiesPanel";
import { CommandPalette } from "./CommandPalette";
const NewIssueDialog = lazy(() => import("./NewIssueDialog").then((m) => ({ default: m.NewIssueDialog })));
const NewProjectDialog = lazy(() => import("./NewProjectDialog").then((m) => ({ default: m.NewProjectDialog })));
const NewGoalDialog = lazy(() => import("./NewGoalDialog").then((m) => ({ default: m.NewGoalDialog })));
import { NewAgentDialog } from "./NewAgentDialog";
import { HireAgentDialog } from "./HireAgentDialog";
import { ToastViewport } from "./ToastViewport";
import { MobileBottomNav } from "./MobileBottomNav";
import { WorktreeBanner } from "./WorktreeBanner";
import { DevRestartBanner } from "./DevRestartBanner";
import { AskAIHeaderButton, AskAIPanel } from "./AskAIButton";
import { NotificationCenter, NotificationBell, useNotifications } from "./NotificationCenter";
import { SampleDataBanner } from "./SampleDataToggle";
import { GuidedTour, useGuidedTour } from "./GuidedTour";
import { WelcomeScreen, hasSeenWelcome } from "./WelcomeScreen";
import { useChordNavigation } from "../hooks/useKeyboardPowerUser";
import { useDialog } from "../context/DialogContext";
import { useToast } from "../context/ToastContext";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useCompanyPageMemory } from "../hooks/useCompanyPageMemory";
import { usePrefetch } from "../hooks/usePrefetch";
import { healthApi } from "../api/health";
import { registerRateLimitToast } from "../api/client";
import { shouldSyncCompanySelectionFromRoute } from "../lib/company-selection";
import { DEFAULT_INSTANCE_SETTINGS_PATH, normalizeRememberedInstanceSettingsPath } from "../lib/instance-settings";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { NotFoundPage } from "../pages/NotFound";
import { useMeAccess } from "../hooks/useMeAccess";
import { useMobileSwipe } from "./layout/useMobileSwipe";
import { useMobileNavVisibility } from "./layout/useMobileNavVisibility";

const INSTANCE_SETTINGS_MEMORY_KEY = "ironworks.lastInstanceSettingsPath";

function readRememberedInstanceSettingsPath(): string {
  if (typeof window === "undefined") return DEFAULT_INSTANCE_SETTINGS_PATH;
  try {
    return normalizeRememberedInstanceSettingsPath(window.localStorage.getItem(INSTANCE_SETTINGS_MEMORY_KEY));
  } catch {
    return DEFAULT_INSTANCE_SETTINGS_PATH;
  }
}

export function Layout() {
  const { sidebarOpen, setSidebarOpen, toggleSidebar, isMobile, sidebarWidth, setSidebarWidth } = useSidebar();
  const { openNewIssue, openOnboarding } = useDialog();
  const { togglePanelVisible } = usePanel();
  const {
    companies,
    loading: companiesLoading,
    selectedCompany,
    selectedCompanyId,
    selectionSource,
    setSelectedCompanyId,
  } = useCompany();

  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  usePrefetch(selectedCompanyId);
  const { pushToast } = useToast();

  // Register rate limit toast handler for the API client
  useEffect(() => {
    registerRateLimitToast((msg) => pushToast({ title: msg, tone: "warn" }));
  }, [pushToast]);

  const navigate = useNavigate();
  const location = useLocation();
  const { isInstanceAdmin } = useMeAccess();
  const isInstanceSettingsRoute = location.pathname.startsWith("/instance/");
  const onboardingTriggered = useRef(false);
  const [instanceSettingsTarget, setInstanceSettingsTarget] = useState<string>(() => readRememberedInstanceSettingsPath());
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [notifCenterOpen, setNotifCenterOpen] = useState(false);
  const [askAIOpen, setAskAIOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [showWelcome, setShowWelcome] = useState(() => !hasSeenWelcome());
  // FirstLoginWizard state removed
  const guidedTour = useGuidedTour();
  const notifs = useNotifications();
  const matchedCompany = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix) ?? null;
  }, [companies, companyPrefix]);
  const hasUnknownCompanyPrefix =
    Boolean(companyPrefix) && !companiesLoading && companies.length > 0 && !matchedCompany;
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as { devServer?: { enabled?: boolean } } | undefined;
      return data?.devServer?.enabled ? 2000 : false;
    },
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (companiesLoading || onboardingTriggered.current) return;
    if (health?.deploymentMode === "authenticated") return;
    if (companies.length === 0) {
      onboardingTriggered.current = true;
      openOnboarding();
    }
  }, [companies, companiesLoading, openOnboarding, health?.deploymentMode]);

  useEffect(() => {
    if (!companyPrefix || companiesLoading || companies.length === 0) return;

    if (!matchedCompany) {
      const fallback = (selectedCompanyId ? companies.find((company) => company.id === selectedCompanyId) : null)
        ?? companies[0]
        ?? null;
      if (fallback && selectedCompanyId !== fallback.id) {
        setSelectedCompanyId(fallback.id, { source: "route_sync" });
      }
      return;
    }

    if (companyPrefix !== matchedCompany.issuePrefix) {
      const suffix = location.pathname.replace(/^\/[^/]+/, "");
      navigate(`/${matchedCompany.issuePrefix}${suffix}${location.search}`, { replace: true });
      return;
    }

    if (
      shouldSyncCompanySelectionFromRoute({
        selectionSource,
        selectedCompanyId,
        routeCompanyId: matchedCompany.id,
      })
    ) {
      setSelectedCompanyId(matchedCompany.id, { source: "route_sync" });
    }
  }, [
    companyPrefix,
    companies,
    companiesLoading,
    matchedCompany,
    location.pathname,
    location.search,
    navigate,
    selectionSource,
    selectedCompanyId,
    setSelectedCompanyId,
  ]);

  const togglePanel = togglePanelVisible;

  useCompanyPageMemory();

  useKeyboardShortcuts({
    onNewIssue: () => openNewIssue(),
    onToggleSidebar: toggleSidebar,
    onTogglePanel: togglePanel,
    onToggleFocusMode: () => setFocusMode((prev) => !prev),
  });

  // Chord navigation: g then d/i/a/p etc.
  useChordNavigation({
    onNavigate: (path) => navigate(path),
    enabled: true,
  });

  // Mobile swipe and nav visibility (extracted hooks)
  useMobileSwipe(isMobile, sidebarOpen, setSidebarOpen);
  const mobileNavVisible = useMobileNavVisibility(isMobile);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = isMobile ? "visible" : "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile]);

  useEffect(() => {
    if (!location.pathname.startsWith("/instance/settings/")) return;

    const nextPath = normalizeRememberedInstanceSettingsPath(
      `${location.pathname}${location.search}${location.hash}`,
    );
    setInstanceSettingsTarget(nextPath);

    try {
      window.localStorage.setItem(INSTANCE_SETTINGS_MEMORY_KEY, nextPath);
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, [location.hash, location.pathname, location.search]);

  // Welcome screen for first-time users (only if no company exists)
  if (showWelcome && companies.length === 0) {
    return <WelcomeScreen onComplete={() => {
      setShowWelcome(false);
    }} />;
  }

  return (
    <div
      className={cn(
        "bg-background text-foreground pt-[env(safe-area-inset-top)]",
        isMobile ? "min-h-dvh" : "flex h-dvh flex-col overflow-hidden",
      )}
      role="application"
      aria-label="IronWorks Application"
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to Main Content
      </a>
      <SampleDataBanner />
      <WorktreeBanner />
      <DevRestartBanner devServer={health?.devServer} />
      <div className={cn("min-h-0 flex-1", isMobile ? "w-full" : "flex overflow-hidden")}>
        {isMobile && sidebarOpen && (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          />
        )}

        {isMobile ? (
          <nav
            aria-label="Main navigation"
            className={cn(
              "fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] transition-transform duration-100 ease-out",
              sidebarOpen ? "translate-x-0" : "-translate-x-full"
            )}
          >
            <div className="flex flex-1 min-h-0 overflow-hidden">
              <CompanyRail />
              {isInstanceSettingsRoute ? <InstanceSidebar /> : <Sidebar />}
            </div>
          </nav>
        ) : (
          <nav
            aria-label="Main navigation"
            data-tour="sidebar"
            className={cn(
              "flex h-full flex-col shrink-0 transition-all duration-200",
              focusMode && "hidden",
            )}
          >
            <div className="flex flex-1 min-h-0">
              <CompanyRail />
              <div
                className={cn(
                  "overflow-hidden transition-[width] duration-100 ease-out relative",
                  !sidebarOpen && "w-0"
                )}
                style={sidebarOpen ? { width: sidebarWidth } : undefined}
              >
                {isInstanceSettingsRoute ? <InstanceSidebar /> : <Sidebar />}
                {/* Resize drag zone - right edge of sidebar */}
                <div
                  className="absolute top-0 right-0 w-2 h-full cursor-col-resize z-30 hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors border-r border-border/50 hover:border-blue-500/50"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    document.body.style.cursor = "col-resize";
                    document.body.style.userSelect = "none";
                    const startX = e.clientX;
                    const startW = sidebarWidth;
                    const onMove = (ev: MouseEvent) => {
                      const newW = startW + (ev.clientX - startX);
                      if (newW < 60) {
                        setSidebarOpen(false);
                      } else {
                        setSidebarWidth(newW);
                      }
                    };
                    const onUp = () => {
                      document.body.style.cursor = "";
                      document.body.style.userSelect = "";
                      document.removeEventListener("mousemove", onMove);
                      document.removeEventListener("mouseup", onUp);
                    };
                    document.addEventListener("mousemove", onMove);
                    document.addEventListener("mouseup", onUp);
                  }}
                  onDoubleClick={() => setSidebarWidth(300)}
                />
              </div>
            </div>
          </nav>
        )}

        <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "h-full flex-1")}>
          <header
            className={cn(
              "border-b border-border/50 backdrop-blur-sm bg-background/80",
              isMobile && "sticky top-0 z-20",
              focusMode && !isMobile && "hidden",
            )}
            role="banner"
          >
            <div className="flex items-center">
              <div className="flex-1 min-w-0">
                <BreadcrumbBar />
              </div>
              <div className="flex items-center gap-1 pr-4 shrink-0 relative">
                <AskAIHeaderButton onClick={() => setAskAIOpen((v) => !v)} />
                <AskAIPanel open={askAIOpen} onClose={() => setAskAIOpen(false)} />
                <NotificationBell
                  unreadCount={notifs.unreadCount}
                  onClick={() => setNotifCenterOpen(true)}
                />
              </div>
            </div>
          </header>
          <div className={cn(isMobile ? "block" : "flex flex-1 min-h-0")}>
            <main
              id="main-content"
              tabIndex={-1}
              className={cn(
                "flex-1 p-6 scroll-smooth",
                isMobile ? "overflow-visible pb-[calc(5rem+env(safe-area-inset-bottom))]" : "overflow-auto",
              )}
            >
              {hasUnknownCompanyPrefix ? (
                <NotFoundPage
                  scope="invalid_company_prefix"
                  requestedPrefix={companyPrefix ?? selectedCompany?.issuePrefix}
                />
              ) : (
                <Outlet />
              )}
            </main>
            <PropertiesPanel />
          </div>
          <StatusBar
            isInstanceAdmin={isInstanceAdmin}
            instanceSettingsTarget={instanceSettingsTarget}
            onBugReport={() => setBugReportOpen(true)}
            onChangelog={() => setChangelogOpen(true)}
            changelogTrigger={<ChangelogTrigger onClick={() => setChangelogOpen(true)} />}
          />
        </div>
      </div>
      {isMobile && <MobileBottomNav visible={mobileNavVisible} />}
      <CommandPalette />
      <Suspense fallback={null}><NewIssueDialog /></Suspense>
      <Suspense fallback={null}><NewProjectDialog /></Suspense>
      <Suspense fallback={null}><NewGoalDialog /></Suspense>
      <NewAgentDialog />
      <HireAgentDialog />
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <BugReportModal open={bugReportOpen} onClose={() => setBugReportOpen(false)} />
      <ChangelogModal open={changelogOpen} onOpenChange={setChangelogOpen} />
      <NotificationCenter
        open={notifCenterOpen}
        onClose={() => setNotifCenterOpen(false)}
        notifications={notifs.notifications}
        onMarkRead={notifs.markRead}
        onMarkAllRead={notifs.markAllRead}
        onRemove={notifs.removeNotification}
        onClearAll={notifs.clearAll}
        onMuteEntity={notifs.muteEntity}
      />
      <GuidedTour
        active={guidedTour.active}
        currentStep={guidedTour.step}
        onNext={guidedTour.next}
        onPrev={guidedTour.prev}
        onDismiss={guidedTour.dismiss}
      />
      {/* FirstLoginWizard removed - redundant with onboarding wizard */}
      <ToastViewport />
    </div>
  );
}
