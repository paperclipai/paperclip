import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate, useNavigationType, useParams } from "@/lib/router";
import { CompanyRail } from "./CompanyRail";
import { Sidebar } from "./Sidebar";
import { InstanceSidebar } from "./InstanceSidebar";
import { CompanySettingsSidebar } from "./CompanySettingsSidebar";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { PropertiesPanel } from "./PropertiesPanel";
import { CommandPalette } from "./CommandPalette";
import { NewIssueDialog } from "./NewIssueDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { NewGoalDialog } from "./NewGoalDialog";
import { NewAgentDialog } from "./NewAgentDialog";
import { KeyboardShortcutsCheatsheet } from "./KeyboardShortcutsCheatsheet";
import { ToastViewport } from "./ToastViewport";
import { MobileBottomNav } from "./MobileBottomNav";
import { WorktreeBanner } from "./WorktreeBanner";
import { DevRestartBanner } from "./DevRestartBanner";
import { SidebarAccountMenu } from "./SidebarAccountMenu";
import { useDialogActions } from "../context/DialogContext";
import { GeneralSettingsProvider } from "../context/GeneralSettingsContext";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useCompanyPageMemory } from "../hooks/useCompanyPageMemory";
import { healthApi } from "../api/health";
import { instanceSettingsApi } from "../api/instanceSettings";
import { shouldSyncCompanySelectionFromRoute } from "../lib/company-selection";
import {
  DEFAULT_INSTANCE_SETTINGS_PATH,
  normalizeRememberedInstanceSettingsPath,
} from "../lib/instance-settings";
import {
  resetNavigationScroll,
  shouldResetScrollOnNavigation,
} from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { scheduleMainContentFocus } from "../lib/main-content-focus";
import { cn } from "../lib/utils";
import { NotFoundPage } from "../pages/NotFound";

const INSTANCE_SETTINGS_MEMORY_KEY = "paperclip.lastInstanceSettingsPath";

function readRememberedInstanceSettingsPath(): string {
  if (typeof window === "undefined") return DEFAULT_INSTANCE_SETTINGS_PATH;
  try {
    return normalizeRememberedInstanceSettingsPath(window.localStorage.getItem(INSTANCE_SETTINGS_MEMORY_KEY));
  } catch {
    return DEFAULT_INSTANCE_SETTINGS_PATH;
  }
}

export function Layout() {
  const { sidebarOpen, setSidebarOpen, toggleSidebar, isMobile } = useSidebar();
  const { openNewIssue, openOnboarding } = useDialogActions();
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
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const isInstanceSettingsRoute = location.pathname.startsWith("/instance/");
  const isCompanySettingsRoute = location.pathname.includes("/company/settings");
  const onboardingTriggered = useRef(false);
  const lastMainScrollTop = useRef(0);
  const previousPathname = useRef<string | null>(null);
  const mainContentRef = useRef<HTMLElement | null>(null);
  const [mobileNavVisible, setMobileNavVisible] = useState(true);
  const [instanceSettingsTarget, setInstanceSettingsTarget] = useState<string>(() => readRememberedInstanceSettingsPath());
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
  const keyboardShortcutsEnabled = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  }).data?.keyboardShortcuts === true;

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
  const openSearch = useCallback(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));
  }, []);

  useCompanyPageMemory();

  useKeyboardShortcuts({
    enabled: keyboardShortcutsEnabled,
    onNewIssue: () => openNewIssue(),
    onSearch: openSearch,
    onToggleSidebar: toggleSidebar,
    onTogglePanel: togglePanel,
    onShowShortcuts: () => setShortcutsOpen(true),
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

  useEffect(() => {
    if (typeof document === "undefined") return;
    const mainContent = mainContentRef.current;
    return scheduleMainContentFocus(mainContent);
  }, [location.pathname]);

  useEffect(() => {
    const shouldResetScroll = shouldResetScrollOnNavigation({
      previousPathname: previousPathname.current,
      pathname: location.pathname,
      navigationType,
      state: location.state,
    });

    previousPathname.current = location.pathname;

    if (!shouldResetScroll) return;
    resetNavigationScroll(mainContentRef.current);
  }, [location.pathname, navigationType]);

  return (
    <GeneralSettingsProvider value={{ keyboardShortcutsEnabled }}>
      <div
      className={cn(
        "bg-background text-foreground pt-[env(safe-area-inset-top)]",
        isMobile ? "min-h-dvh" : "flex h-dvh flex-col overflow-hidden",
      )}
      >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to Main Content
      </a>
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
          <div
            className={cn(
              "fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] transition-transform duration-100 ease-out",
              sidebarOpen ? "translate-x-0" : "-translate-x-full"
            )}
          >
            <div className="flex flex-1 min-h-0 overflow-hidden">
              <CompanyRail />
              {isInstanceSettingsRoute ? (
                <InstanceSidebar />
              ) : isCompanySettingsRoute ? (
                <CompanySettingsSidebar />
              ) : (
                <Sidebar />
              )}
            </div>
            <SidebarAccountMenu
              deploymentMode={health?.deploymentMode}
              instanceSettingsTarget={instanceSettingsTarget}
              version={health?.version}
            />
          </div>
        ) : (
          <div className="flex h-full flex-col shrink-0">
            <div className="flex flex-1 min-h-0">
              <CompanyRail />
              <div
                className={cn(
                  "overflow-hidden transition-[width] duration-100 ease-out",
                  sidebarOpen ? "w-60" : "w-0"
                )}
              >
                {isInstanceSettingsRoute ? (
                  <InstanceSidebar />
                ) : isCompanySettingsRoute ? (
                  <CompanySettingsSidebar />
                ) : (
                  <Sidebar />
                )}
              </div>
            </div>
            <SidebarAccountMenu
              deploymentMode={health?.deploymentMode}
              instanceSettingsTarget={instanceSettingsTarget}
              version={health?.version}
            />
          </div>
        )}

        <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "h-full flex-1")}>
          <div
            className={cn(
              isMobile && "sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85",
            )}
          >
            <BreadcrumbBar />
          </div>
          <div className={cn(isMobile ? "block" : "flex flex-1 min-h-0")}>
            <main
              id="main-content"
              ref={mainContentRef}
              tabIndex={-1}
              className={cn(
                "flex-1 p-4 outline-none md:p-6",
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
        </div>
      </div>
      {isMobile && <MobileBottomNav visible={mobileNavVisible} />}
      <CommandPalette />
      <NewIssueDialog />
      <NewProjectDialog />
      <NewGoalDialog />
      <NewAgentDialog />
      <KeyboardShortcutsCheatsheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <ToastViewport />
      </div>
    </GeneralSettingsProvider>
  );
}
