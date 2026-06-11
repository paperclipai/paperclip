import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate, useNavigationType, useParams } from "@/lib/router";
import { Sidebar } from "./Sidebar";
import { CompanySettingsSidebar } from "./CompanySettingsSidebar";
import { CompanySettingsNav } from "./access/CompanySettingsNav";
import { ToolsSidebar } from "./ToolsSidebar";
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
import { StandaloneBrowserControls } from "./StandaloneBrowserControls";
import { SidebarShell } from "./SidebarShell";
import { SecondarySidebar } from "./SecondarySidebar";
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
  resetNavigationScroll,
  shouldResetScrollOnNavigation,
} from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { scheduleMainContentFocus } from "../lib/main-content-focus";
import { cn } from "../lib/utils";
import { NotFoundPage } from "../pages/NotFound";
import { PluginSlotMount, resolveRouteSidebarSlot, usePluginSlots } from "../plugins/slots";

function getCompanyRouteSegment(pathname: string, companyPrefix: string | undefined): string | null {
  if (!companyPrefix) return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  if (segments[0]?.toUpperCase() !== companyPrefix.toUpperCase()) return null;
  return segments[1]?.toLowerCase() ?? null;
}

export function Layout() {
  const {
    sidebarOpen,
    setSidebarOpen,
    toggleSidebar,
    toggleCollapsed,
    collapsed,
    peeking,
    setPeeking,
    isMobile,
    setForceCollapsed,
  } = useSidebar();
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
  const {
    companyPrefix,
    pluginRoutePath: matchedPluginRoutePath,
  } = useParams<{ companyPrefix: string; pluginRoutePath?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const isCompanySettingsRoute = location.pathname.includes("/company/settings");
  const isToolsRoute = getCompanyRouteSegment(location.pathname, companyPrefix) === "tools";
  const onboardingTriggered = useRef(false);
  const lastMainScrollTop = useRef(0);
  const previousPathname = useRef<string | null>(null);
  const mainContentRef = useRef<HTMLElement | null>(null);
  const [mobileNavVisible, setMobileNavVisible] = useState(true);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const matchedCompany = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix) ?? null;
  }, [companies, companyPrefix]);
  const hasUnknownCompanyPrefix =
    Boolean(companyPrefix) && !companiesLoading && companies.length > 0 && !matchedCompany;
  const pluginRoutePath = useMemo(
    () => matchedPluginRoutePath?.toLowerCase() ?? getCompanyRouteSegment(location.pathname, companyPrefix),
    [companyPrefix, location.pathname, matchedPluginRoutePath],
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
  // Takeover routes (company settings, plugin `routeSidebar`) no longer replace
  // the app `<Sidebar/>`. Instead the host collapses it to its rail and renders
  // the contextual sidebar in a second pane (PAP-10695). One resolver drives
  // both desktop (SecondarySidebar) and mobile (off-canvas drawer).
  const secondarySidebar = isCompanySettingsRoute ? (
    <CompanySettingsSidebar />
  ) : isToolsRoute ? (
    <ToolsSidebar />
  ) : routeSidebarSlot ? (
    <PluginSlotMount
      slot={routeSidebarSlot}
      context={sidebarContext}
      className="h-full w-full"
      missingBehavior="placeholder"
    />
  ) : null;
  const hasSecondarySidebar = secondarySidebar != null;
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

  // A secondary sidebar always collapses the app sidebar to its rail (still
  // peek-able) — a hard invariant that overrides the user pin while the route
  // is active, but does NOT mutate the persisted preference. Clearing the force
  // on cleanup restores the user's expanded/collapsed choice when navigating
  // off the takeover route (PAP-10694).
  useLayoutEffect(() => {
    setForceCollapsed(hasSecondarySidebar);
    return () => setForceCollapsed(false);
  }, [hasSecondarySidebar, setForceCollapsed]);

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
  // Cmd/Ctrl+B: collapse/expand the pinned rail on desktop; on mobile keep
  // toggling the off-canvas drawer.
  const toggleCollapse = useCallback(() => {
    if (isMobile) {
      toggleSidebar();
    } else {
      toggleCollapsed();
    }
  }, [isMobile, toggleSidebar, toggleCollapsed]);
  const openSearch = useCallback(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));
  }, []);

  // Peek (hover flyout) triggers for the collapsed rail. Opening has a tiny
  // delay so a pointer merely sweeping across the rail doesn't flash it open;
  // closing is debounced to avoid flicker on the rail→overlay seam. Keyboard
  // focus opens immediately so tabbing reaches the full nav. Context gates the
  // effective `peeking` to desktop + collapsed + hover-capable pointers, so
  // these handlers are inert otherwise.
  const peekTimer = useRef<number | null>(null);
  // Whether the pointer is currently over the peek panel. Used to keep the peek
  // open across focus changes (e.g. navigation steals focus to <main>) as long as
  // the user is still hovering — it should only close when they actually mouse off
  // (PAP-10676).
  const pointerInsidePanel = useRef(false);
  // When the user explicitly collapses while the pointer is still over the panel,
  // suppress re-peeking until the pointer actually leaves — otherwise the lingering
  // hover immediately re-expands the rail and the collapse "doesn't take" until the
  // mouse moves away (PAP-10676). Re-armed on the next genuine pointer-leave.
  const suppressPeekRef = useRef(false);
  const clearPeekTimer = useCallback(() => {
    if (peekTimer.current !== null) {
      window.clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
  }, []);
  const openPeek = useCallback(() => {
    clearPeekTimer();
    peekTimer.current = window.setTimeout(() => setPeeking(true), 50);
  }, [clearPeekTimer, setPeeking]);
  const openPeekImmediate = useCallback(() => {
    clearPeekTimer();
    setPeeking(true);
  }, [clearPeekTimer, setPeeking]);
  const closePeek = useCallback(() => {
    clearPeekTimer();
    peekTimer.current = window.setTimeout(() => setPeeking(false), 120);
  }, [clearPeekTimer, setPeeking]);
  // Tracked even while expanded so that, at the moment of collapse, we know
  // whether the pointer is over the panel and should suppress the re-peek.
  const handlePanelPointerEnter = useCallback(() => {
    pointerInsidePanel.current = true;
    if (collapsed && !suppressPeekRef.current) openPeek();
  }, [collapsed, openPeek]);
  const handlePanelPointerLeave = useCallback(() => {
    pointerInsidePanel.current = false;
    suppressPeekRef.current = false; // pointer left — re-arm peek for the next hover
    closePeek();
  }, [closePeek]);
  const handlePanelFocus = useCallback(() => {
    if (suppressPeekRef.current) return;
    openPeekImmediate();
  }, [openPeekImmediate]);
  // Close on focus leaving the panel only when the pointer isn't hovering it.
  // Clicking a rail/peek nav item moves focus to <main> on navigation; if the
  // mouse is still over the flyout we keep it open until the pointer leaves.
  const handlePanelBlur = useCallback(() => {
    if (pointerInsidePanel.current) return;
    closePeek();
  }, [closePeek]);

  // Tidy up any pending peek timer on unmount.
  useEffect(() => clearPeekTimer, [clearPeekTimer]);

  // An explicit collapse must be atomic: cancel any in-flight/active peek, and if
  // the pointer is still over the panel suppress re-peeking until it leaves, so the
  // rail doesn't immediately re-expand under the lingering hover (PAP-10676).
  const wasCollapsed = useRef(collapsed);
  useEffect(() => {
    if (collapsed !== wasCollapsed.current) {
      if (collapsed) {
        clearPeekTimer();
        setPeeking(false);
        suppressPeekRef.current = pointerInsidePanel.current;
      } else {
        suppressPeekRef.current = false;
      }
      wasCollapsed.current = collapsed;
    }
  }, [collapsed, clearPeekTimer, setPeeking]);

  // Intentionally do NOT close the peek on navigation: clicking a nav item means
  // the pointer is still over the flyout, so it should stay open until the user
  // actually mouses off (handled by onPanelMouseLeave) or blurs out / hits Escape
  // (PAP-10676). Auto-closing here made the sidebar collapse on every page change.

  // Escape closes an open peek without trapping the pointer.
  useEffect(() => {
    if (!peeking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearPeekTimer();
        setPeeking(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [peeking, clearPeekTimer, setPeeking]);

  useCompanyPageMemory();

  useKeyboardShortcuts({
    enabled: keyboardShortcutsEnabled,
    onNewIssue: () => openNewIssue(),
    onSearch: openSearch,
    onToggleSidebar: toggleSidebar,
    onToggleCollapse: toggleCollapse,
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
              <div className="w-60 shrink-0 overflow-hidden">
                {hasSecondarySidebar ? secondarySidebar : <Sidebar />}
              </div>
            </div>
            <SidebarAccountMenu
              deploymentMode={health?.deploymentMode}
              version={health?.version}
            />
          </div>
        ) : (
          <SidebarShell
            open={sidebarOpen}
            collapsed={collapsed}
            peeking={peeking}
            resizable
            onPanelMouseEnter={handlePanelPointerEnter}
            onPanelMouseLeave={handlePanelPointerLeave}
            onPanelFocusCapture={collapsed ? handlePanelFocus : undefined}
            onPanelBlurCapture={collapsed ? handlePanelBlur : undefined}
          >
            <div className="flex flex-1 min-h-0">
              <Sidebar />
            </div>
            <SidebarAccountMenu
              deploymentMode={health?.deploymentMode}
              version={health?.version}
            />
          </SidebarShell>
        )}

        {!isMobile && hasSecondarySidebar ? (
          <SecondarySidebar>{secondarySidebar}</SecondarySidebar>
        ) : null}

        <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "h-full flex-1")}>
          <div
            className={cn(
              isMobile && "sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85",
            )}
          >
            <StandaloneBrowserControls mobile={isMobile} />
            <BreadcrumbBar />
            {isMobile && isCompanySettingsRoute ? (
              <div className="border-b border-border px-4 pb-3">
                <CompanySettingsNav />
              </div>
            ) : null}
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
