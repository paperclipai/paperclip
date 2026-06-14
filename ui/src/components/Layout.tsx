import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate, useNavigationType, useParams } from "@/lib/router";
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
import { ResizableSidebarPane } from "./ResizableSidebarPane";
import { SidebarAccountMenu } from "./SidebarAccountMenu";
import { useDialogActions } from "../context/DialogContext";
import { GeneralSettingsProvider } from "../context/GeneralSettingsContext";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useOrg } from "../context/OrgContext";
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
import { pinDocumentScrollToZero } from "../lib/pin-document-scroll";
import { cn } from "../lib/utils";
import { NotFoundPage } from "../pages/NotFound";
import { PluginSlotMount, resolveRouteSidebarSlot, usePluginSlots } from "../plugins/slots";

const INSTANCE_SETTINGS_MEMORY_KEY = "paperclip.lastInstanceSettingsPath";

function getCompanyRouteSegment(pathname: string, companyPrefix: string | undefined): string | null {
  if (!companyPrefix) return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  if (segments[0]?.toUpperCase() !== companyPrefix.toUpperCase()) return null;
  return segments[1]?.toLowerCase() ?? null;
}

function readRememberedInstanceSettingsPath(): string {
  if (typeof window === "undefined") return DEFAULT_INSTANCE_SETTINGS_PATH;
  try {
    return normalizeRememberedInstanceSettingsPath(window.localStorage.getItem(INSTANCE_SETTINGS_MEMORY_KEY));
  } catch {
    return DEFAULT_INSTANCE_SETTINGS_PATH;
  }
}

// Detect whether the viewport is narrower than the `lg` Tailwind breakpoint
// (1024px). Used to show/hide the mobile bottom-nav and off-canvas sidebar
// on both phones (<768px) and tablets (768px–1023px).
function useIsNarrow() {
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < 1024);
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1023px)");
    const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isNarrow;
}

export function Layout() {
  const { sidebarOpen, setSidebarOpen, toggleSidebar, isMobile } = useSidebar();
  // isNarrow = true on phone AND tablet (<lg / 1024px).
  // isMobile (from SidebarContext) = true only on phone (<md / 768px).
  const isNarrow = useIsNarrow();
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
  const { selectedOrgId, setSelectedOrgId } = useOrg();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const isInstanceSettingsRoute = location.pathname.startsWith("/instance/");
  const isCompanySettingsRoute = location.pathname.includes("/company/settings");
  const onboardingTriggered = useRef(false);
  const lastMainScrollTop = useRef(0);
  const previousPathname = useRef<string | null>(null);
  const previousCompanyRouteSyncState = useRef<{
    pathname: string;
    selectedCompanyId: string | null;
  }>({ pathname: location.pathname, selectedCompanyId });
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
  const pluginRoutePath = useMemo(
    () => getCompanyRouteSegment(location.pathname, companyPrefix),
    [companyPrefix, location.pathname],
  );
  const routeSidebarCompanyId = matchedCompany?.id ?? null;
  const routeSidebarCompanyPrefix = matchedCompany?.issuePrefix ?? null;
  const { slots: routeSidebarSlots } = usePluginSlots({
    slotTypes: ["page", "routeSidebar"],
    companyId: routeSidebarCompanyId,
    enabled: Boolean(routeSidebarCompanyId && pluginRoutePath),
  });
  const routeSidebarSlot = useMemo(
    () => resolveRouteSidebarSlot(routeSidebarSlots, pluginRoutePath),
    [pluginRoutePath, routeSidebarSlots],
  );
  const sidebarContext = useMemo(
    () => ({
      companyId: routeSidebarCompanyId,
      companyPrefix: routeSidebarCompanyPrefix,
    }),
    [routeSidebarCompanyId, routeSidebarCompanyPrefix],
  );
  const companySidebar = routeSidebarSlot ? (
    <PluginSlotMount
      slot={routeSidebarSlot}
      context={sidebarContext}
      className="h-full w-full"
      missingBehavior="placeholder"
    />
  ) : (
    <Sidebar />
  );
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
    const routeChangedSinceSelection =
      previousCompanyRouteSyncState.current.selectedCompanyId === selectedCompanyId &&
      previousCompanyRouteSyncState.current.pathname !== location.pathname;

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
        routeChangedSinceSelection,
      })
    ) {
      setSelectedCompanyId(matchedCompany.id, { source: "route_sync" });
    }
    previousCompanyRouteSyncState.current = {
      pathname: location.pathname,
      selectedCompanyId,
    };
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

  useEffect(() => {
    if (!matchedCompany?.organizationId) return;
    if (selectedOrgId === matchedCompany.organizationId) return;
    // Skip if a different company is selected — we're mid-switch (e.g., the
    // sidebar org switcher just set selectedCompanyId to a company in another
    // org and the URL hasn't caught up yet). Syncing here would revert that
    // manual switch. useCompanyPageMemory will land us on the new company's
    // URL, after which this effect re-runs with the correct matchedCompany.
    if (selectedCompanyId !== null && selectedCompanyId !== matchedCompany.id) return;
    setSelectedOrgId(matchedCompany.organizationId);
  }, [matchedCompany, selectedOrgId, selectedCompanyId, setSelectedOrgId]);

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
    if (!isNarrow) {
      setMobileNavVisible(true);
      return;
    }
    lastMainScrollTop.current = 0;
    setMobileNavVisible(true);
  }, [isNarrow]);

  // Swipe gesture to open/close sidebar on phone+tablet
  useEffect(() => {
    if (!isNarrow) return;

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
  }, [isNarrow, sidebarOpen, setSidebarOpen]);

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
    if (!isNarrow) {
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
  }, [isNarrow, updateMobileNavVisibility]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    // Phone and tablet use window scroll; desktop uses in-element overflow.
    document.body.style.overflow = isNarrow ? "visible" : "clip";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isNarrow]);

  useEffect(() => {
    if (isNarrow) return;
    return pinDocumentScrollToZero();
  }, [isNarrow]);

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
          // Narrow (phone+tablet <lg): window-scroll layout, full height
          // Desktop (>=lg): flex column with overflow-clip for in-element scroll
          isNarrow ? "min-h-dvh" : "flex h-dvh flex-col overflow-clip",
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
        <div className={cn("min-h-0 flex-1", isNarrow ? "w-full" : "flex overflow-clip")}>
          {/* ── Off-canvas overlay backdrop (phone + tablet) ── */}
          {isNarrow && sidebarOpen && (
            <button
              type="button"
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close sidebar"
            />
          )}

          {/* ── Sidebar: off-canvas on narrow (<lg), static on desktop ── */}
          {isNarrow ? (
            // Off-canvas slide-in: glass-blur frosted panel from left edge
            <div
              className={cn(
                "fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden",
                // Safe-area top padding so content clears the notch
                "pt-[env(safe-area-inset-top)]",
                // Glass surface with rounded right edge
                "glass-surface shadow-2xl",
                // Wider on tablet, standard on phone
                "w-72 sm:w-80",
                // Slide-in transition
                "transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
                sidebarOpen ? "translate-x-0" : "-translate-x-full",
              )}
            >
              <div className="flex flex-1 min-h-0 overflow-hidden">
                <div className="w-full overflow-hidden">
                  {isInstanceSettingsRoute ? (
                    <InstanceSidebar />
                  ) : isCompanySettingsRoute ? (
                    <CompanySettingsSidebar />
                  ) : (
                    companySidebar
                  )}
                </div>
              </div>
              <SidebarAccountMenu
                deploymentMode={health?.deploymentMode}
                instanceSettingsTarget={instanceSettingsTarget}
                version={health?.version}
              />
            </div>
          ) : (
            // Desktop static sidebar
            <div className="flex h-full flex-col shrink-0">
              <div className="flex flex-1 min-h-0">
                <ResizableSidebarPane open={sidebarOpen} resizable className="h-full shrink-0">
                  {isInstanceSettingsRoute ? (
                    <InstanceSidebar />
                  ) : isCompanySettingsRoute ? (
                    <CompanySettingsSidebar />
                  ) : (
                    companySidebar
                  )}
                </ResizableSidebarPane>
              </div>
              <SidebarAccountMenu
                deploymentMode={health?.deploymentMode}
                instanceSettingsTarget={instanceSettingsTarget}
                version={health?.version}
              />
            </div>
          )}

          {/* ── Main content column ── */}
          <div className={cn("flex min-w-0 flex-col", isNarrow ? "w-full" : "h-full flex-1")}>
            {/* BreadcrumbBar: sticky + glass on narrow, plain on desktop */}
            <div
              className={cn(
                isNarrow && "sticky top-0 z-20",
              )}
            >
              <BreadcrumbBar />
            </div>

            <div className={cn(isNarrow ? "block" : "flex flex-1 min-h-0")}>
              <main
                id="main-content"
                ref={mainContentRef}
                tabIndex={-1}
                className={cn(
                  "flex-1 p-4 outline-none md:p-6",
                  // Narrow: window-scroll, add bottom clearance for nav bar + safe area
                  // Desktop: in-element scroll
                  isNarrow ? "overflow-visible pb-safe-nav" : "overflow-auto",
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
              {/* PropertiesPanel: bottom-sheet on <lg, side-pane on desktop */}
              <PropertiesPanel />
            </div>
          </div>
        </div>

        {/* MobileBottomNav: visible on phone+tablet (<lg), hidden on desktop via CSS */}
        <MobileBottomNav visible={mobileNavVisible} />

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
