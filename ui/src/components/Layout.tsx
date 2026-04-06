import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeedbackModal } from "./FeedbackModal";
import { BugReportModal } from "./BugReportModal";
import { ChangelogModal, ChangelogTrigger } from "./ChangelogModal";
import { useQuery } from "@tanstack/react-query";
import { Bug, Moon, Settings, Sun } from "lucide-react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "@/lib/router";
import { CookieSettingsLink } from "./CookieConsent";
import { CompanyRail } from "./CompanyRail";
import { Sidebar } from "./Sidebar";
import { InstanceSidebar } from "./InstanceSidebar";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { PropertiesPanel } from "./PropertiesPanel";
import { CommandPalette } from "./CommandPalette";
import { NewIssueDialog } from "./NewIssueDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { NewGoalDialog } from "./NewGoalDialog";
import { NewAgentDialog } from "./NewAgentDialog";
import { HireAgentDialog } from "./HireAgentDialog";
import { ToastViewport } from "./ToastViewport";
import { MobileBottomNav } from "./MobileBottomNav";
import { WorktreeBanner } from "./WorktreeBanner";
import { DevRestartBanner } from "./DevRestartBanner";
import { AskAIButton } from "./AskAIButton";
import { NotificationCenter, NotificationBell, useNotifications } from "./NotificationCenter";
import { SampleDataBanner } from "./SampleDataToggle";
import { GuidedTour, useGuidedTour, isFirstRun, markFirstRunSeen } from "./GuidedTour";
import { WelcomeScreen, hasSeenWelcome } from "./WelcomeScreen";
// FirstLoginWizard removed - redundant with onboarding wizard
import { useChordNavigation } from "../hooks/useKeyboardPowerUser";
import { useDialog } from "../context/DialogContext";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useTheme } from "../context/ThemeContext";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useCompanyPageMemory } from "../hooks/useCompanyPageMemory";
import { usePrefetch } from "../hooks/usePrefetch";
import { healthApi } from "../api/health";
import { shouldSyncCompanySelectionFromRoute } from "../lib/company-selection";
import {
  DEFAULT_INSTANCE_SETTINGS_PATH,
  normalizeRememberedInstanceSettingsPath,
} from "../lib/instance-settings";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { NotFoundPage } from "../pages/NotFound";
import { Button } from "@/components/ui/button";
import { useMeAccess } from "../hooks/useMeAccess";

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
  const { theme, toggleTheme } = useTheme();
  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  usePrefetch(selectedCompanyId);
  const navigate = useNavigate();
  const location = useLocation();
  const { isInstanceAdmin } = useMeAccess();
  const isInstanceSettingsRoute = location.pathname.startsWith("/instance/");
  const onboardingTriggered = useRef(false);
  const lastMainScrollTop = useRef(0);
  const [mobileNavVisible, setMobileNavVisible] = useState(true);
  const [instanceSettingsTarget, setInstanceSettingsTarget] = useState<string>(() => readRememberedInstanceSettingsPath());
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [notifCenterOpen, setNotifCenterOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [showWelcome, setShowWelcome] = useState(() => !hasSeenWelcome());
  // FirstLoginWizard state removed
  const guidedTour = useGuidedTour();
  const notifs = useNotifications();
  const nextTheme = theme === "dark" ? "light" : "dark";
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

  useEffect(() => {
    if (!isMobile) {
      setMobileNavVisible(true);
      return;
    }
    lastMainScrollTop.current = 0;
    setMobileNavVisible(true);
  }, [isMobile]);

  // Swipe gesture to open/close sidebar on mobile
  useEffect(() => {
    if (!isMobile) return;

    const EDGE_ZONE = 30; // px from left edge to start open-swipe
    const MIN_DISTANCE = 50; // minimum horizontal swipe distance
    const MAX_VERTICAL = 75; // max vertical drift before we ignore

    let startX = 0;
    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0]!;
      startX = t.clientX;
      startY = t.clientY;
    };

    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0]!;
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);

      if (dy > MAX_VERTICAL) return; // vertical scroll, ignore

      // Swipe right from left edge → open
      if (!sidebarOpen && startX < EDGE_ZONE && dx > MIN_DISTANCE) {
        setSidebarOpen(true);
        return;
      }

      // Swipe left when open → close
      if (sidebarOpen && dx < -MIN_DISTANCE) {
        setSidebarOpen(false);
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [isMobile, sidebarOpen, setSidebarOpen]);

  const updateMobileNavVisibility = useCallback((currentTop: number) => {
    const delta = currentTop - lastMainScrollTop.current;

    if (currentTop <= 24) {
      setMobileNavVisible(true);
    } else if (delta > 8) {
      setMobileNavVisible(false);
    } else if (delta < -8) {
      setMobileNavVisible(true);
    }

    lastMainScrollTop.current = currentTop;
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setMobileNavVisible(true);
      lastMainScrollTop.current = 0;
      return;
    }

    const onScroll = () => {
      updateMobileNavVisibility(window.scrollY || document.documentElement.scrollTop || 0);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, [isMobile, updateMobileNavVisibility]);

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
                  "overflow-hidden transition-[width] duration-100 ease-out",
                  !sidebarOpen && "w-0"
                )}
                style={sidebarOpen ? { width: sidebarWidth } : undefined}
              >
                {isInstanceSettingsRoute ? <InstanceSidebar /> : <Sidebar />}
              </div>
              {/* Resize handle - always visible on desktop, dragging expands/collapses sidebar */}
              {!isMobile && (
                <div
                  className="w-2 h-full cursor-col-resize group shrink-0 flex items-center justify-center hover:bg-accent/30 active:bg-accent/50 transition-colors"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const startX = e.clientX;
                    const startW = sidebarOpen ? sidebarWidth : 0;
                    const onMove = (ev: MouseEvent) => {
                      const newW = startW + (ev.clientX - startX);
                      if (newW > 120 && !sidebarOpen) {
                        setSidebarOpen(true);
                        setSidebarWidth(Math.max(newW, 180));
                      } else if (newW < 60 && sidebarOpen) {
                        setSidebarOpen(false);
                      } else if (sidebarOpen) {
                        setSidebarWidth(newW);
                      }
                    };
                    const onUp = () => {
                      document.removeEventListener("mousemove", onMove);
                      document.removeEventListener("mouseup", onUp);
                    };
                    document.addEventListener("mousemove", onMove);
                    document.addEventListener("mouseup", onUp);
                  }}
                >
                  <div className="w-0.5 h-10 rounded-full bg-border group-hover:bg-ring/60 group-active:bg-ring transition-colors" />
                </div>
              )}
            </div>
          </nav>
        )}

        <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "h-full flex-1")}>
          <header
            className={cn(
              isMobile && "sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85",
              focusMode && !isMobile && "hidden",
            )}
            role="banner"
          >
            <div className="flex items-center">
              <div className="flex-1 min-w-0">
                <BreadcrumbBar />
              </div>
              <div className="flex items-center gap-1 pr-4 shrink-0">
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
                "flex-1 px-3 py-2 md:px-4 md:py-3",
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
          <footer role="contentinfo" className="flex items-center justify-center gap-3 px-4 py-1 border-t border-border text-[11px] text-muted-foreground shrink-0 print:hidden">
            <span className="opacity-60">IronWorks</span>
            <span className="text-border/50">·</span>
            <Link to="/terms" className="hover:text-foreground transition-colors">Terms</Link>
            <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
            <Link to="/aup" className="hover:text-foreground transition-colors">AUP</Link>
            <span className="text-border/50">·</span>
            <button type="button" onClick={() => setBugReportOpen(true)} className="inline-flex items-center gap-1 hover:text-foreground transition-colors"><Bug className="h-3 w-3" />Report a Bug</button>
              <ChangelogTrigger onClick={() => setChangelogOpen(true)} />
              {isInstanceAdmin && (
                <>
                  <span className="text-border/50">·</span>
                  <Link to={instanceSettingsTarget} className="hover:text-foreground transition-colors" title="Settings">Settings</Link>
                  <Link to="/manage" className="hover:text-foreground transition-colors" title="Admin">Admin</Link>
                </>
              )}
              <span className="text-border/50">·</span>
              <button type="button" onClick={toggleTheme} className="hover:text-foreground transition-colors" aria-label={`Switch to ${nextTheme} mode`}>
                {theme === "dark" ? "Light" : "Dark"}
              </button>
          </footer>
        </div>
      </div>
      {isMobile && <MobileBottomNav visible={mobileNavVisible} />}
      <CommandPalette />
      <NewIssueDialog />
      <NewProjectDialog />
      <NewGoalDialog />
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
      <AskAIButton />
    </div>
  );
}
