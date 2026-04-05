import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Outlet, useLocation, useNavigate, useParams } from "@/lib/router";
import { AppSidebar } from "./AppSidebar";
import { BreadcrumbBar } from "../BreadcrumbBar";
import { PropertiesPanel } from "../PropertiesPanel";
import { CommandPalette } from "../CommandPalette";
import { MobileBottomNav } from "../MobileBottomNav";
import { NewIssueDialog } from "../NewIssueDialog";
import { NewProjectDialog } from "../NewProjectDialog";
import { NewGoalDialog } from "../NewGoalDialog";
import { NewAgentDialog } from "../NewAgentDialog";
import { ToastViewport } from "../ToastViewport";
import { WorktreeBanner } from "../WorktreeBanner";
import { DevRestartBanner } from "../DevRestartBanner";
import { InstanceSidebar } from "../InstanceSidebar";
import { useDialog } from "../../context/DialogContext";
import { GeneralSettingsProvider } from "../../context/GeneralSettingsContext";
import { usePanel } from "../../context/PanelContext";
import { useCompany } from "../../context/CompanyContext";
import { useSidebar } from "../../context/SidebarContext";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useCompanyPageMemory } from "../../hooks/useCompanyPageMemory";
import { healthApi } from "../../api/health";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { shouldSyncCompanySelectionFromRoute } from "../../lib/company-selection";
import {
  DEFAULT_INSTANCE_SETTINGS_PATH,
  normalizeRememberedInstanceSettingsPath,
} from "../../lib/instance-settings";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { NotFoundPage } from "../../pages/NotFound";
import { slideFromLeft } from "../../motion/transitions";

// ── Electron detection ───────────────────────────────────────────────────────

declare global {
  interface Window {
    electronAPI?: {
      platform?: string;
      [key: string]: unknown;
    };
  }
}

function getElectronClasses(): string {
  if (typeof window === "undefined" || !window.electronAPI) return "";
  const platform = window.electronAPI.platform ?? "";
  if (platform === "darwin") return "electron mac";
  if (platform === "win32") return "electron win";
  return "electron linux";
}

// ── Instance settings memory ─────────────────────────────────────────────────

const INSTANCE_SETTINGS_MEMORY_KEY = "paperclip.lastInstanceSettingsPath";

function readRememberedInstanceSettingsPath(): string {
  if (typeof window === "undefined") return DEFAULT_INSTANCE_SETTINGS_PATH;
  try {
    return normalizeRememberedInstanceSettingsPath(
      window.localStorage.getItem(INSTANCE_SETTINGS_MEMORY_KEY),
    );
  } catch {
    return DEFAULT_INSTANCE_SETTINGS_PATH;
  }
}

// ── AppShell ─────────────────────────────────────────────────────────────────

export function AppShell() {
  const { sidebarOpen, setSidebarOpen, toggleSidebar, isMobile } = useSidebar();
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
  const navigate = useNavigate();
  const location = useLocation();

  const isInstanceSettingsRoute = location.pathname.startsWith("/instance/");

  const onboardingTriggered = useRef(false);
  const lastMainScrollTop = useRef(0);

  const [mobileNavVisible, setMobileNavVisible] = useState(true);
  const [instanceSettingsTarget, setInstanceSettingsTarget] = useState<string>(
    () => readRememberedInstanceSettingsPath(),
  );

  const electronClasses = useMemo(() => getElectronClasses(), []);

  // ── Company prefix route matching ──────────────────────────────────────────

  const matchedCompany = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return (
      companies.find(
        (company) => company.issuePrefix.toUpperCase() === requestedPrefix,
      ) ?? null
    );
  }, [companies, companyPrefix]);

  const hasUnknownCompanyPrefix =
    Boolean(companyPrefix) &&
    !companiesLoading &&
    companies.length > 0 &&
    !matchedCompany;

  // ── Health query ───────────────────────────────────────────────────────────

  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as
        | { devServer?: { enabled?: boolean } }
        | undefined;
      return data?.devServer?.enabled ? 2000 : false;
    },
    refetchIntervalInBackground: true,
  });

  const keyboardShortcutsEnabled =
    useQuery({
      queryKey: queryKeys.instance.generalSettings,
      queryFn: () => instanceSettingsApi.getGeneral(),
    }).data?.keyboardShortcuts === true;

  // ── Onboarding trigger ─────────────────────────────────────────────────────

  useEffect(() => {
    if (companiesLoading || onboardingTriggered.current) return;
    if (health?.deploymentMode === "authenticated") return;
    if (companies.length === 0) {
      onboardingTriggered.current = true;
      openOnboarding();
    }
  }, [companies, companiesLoading, openOnboarding, health?.deploymentMode]);

  // ── Company prefix → selection sync ───────────────────────────────────────

  useEffect(() => {
    if (!companyPrefix || companiesLoading || companies.length === 0) return;

    if (!matchedCompany) {
      const fallback =
        (selectedCompanyId
          ? companies.find((company) => company.id === selectedCompanyId)
          : null) ??
        companies[0] ??
        null;
      if (fallback && selectedCompanyId !== fallback.id) {
        setSelectedCompanyId(fallback.id, { source: "route_sync" });
      }
      return;
    }

    if (companyPrefix !== matchedCompany.issuePrefix) {
      const suffix = location.pathname.replace(/^\/[^/]+/, "");
      navigate(
        `/${matchedCompany.issuePrefix}${suffix}${location.search}`,
        { replace: true },
      );
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

  // ── Hooks ──────────────────────────────────────────────────────────────────

  useCompanyPageMemory();

  useKeyboardShortcuts({
    enabled: keyboardShortcutsEnabled,
    onNewIssue: () => openNewIssue(),
    onToggleSidebar: toggleSidebar,
    onTogglePanel: togglePanelVisible,
  });

  // ── Body overflow ──────────────────────────────────────────────────────────

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = isMobile ? "visible" : "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile]);

  // ── Mobile bottom nav visibility on scroll ─────────────────────────────────

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
      updateMobileNavVisibility(
        window.scrollY || document.documentElement.scrollTop || 0,
      );
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isMobile, updateMobileNavVisibility]);

  useEffect(() => {
    if (!isMobile) {
      setMobileNavVisible(true);
      return;
    }
    lastMainScrollTop.current = 0;
    setMobileNavVisible(true);
  }, [isMobile]);

  // ── Mobile swipe gesture ───────────────────────────────────────────────────

  useEffect(() => {
    if (!isMobile) return;

    const EDGE_ZONE = 30;
    const MIN_DISTANCE = 50;
    const MAX_VERTICAL = 75;

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

      if (dy > MAX_VERTICAL) return;

      if (!sidebarOpen && startX < EDGE_ZONE && dx > MIN_DISTANCE) {
        setSidebarOpen(true);
        return;
      }

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

  // ── Instance settings memory ───────────────────────────────────────────────

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

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <GeneralSettingsProvider value={{ keyboardShortcutsEnabled }}>
      <div
        className={cn(
          "bg-background text-foreground pt-[env(safe-area-inset-top)]",
          isMobile ? "min-h-dvh" : "flex h-dvh flex-col overflow-hidden",
          electronClasses,
        )}
      >
        {/* Skip to main content — accessibility */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-2xl focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Skip to Main Content
        </a>

        {/* Banners */}
        <WorktreeBanner />
        <DevRestartBanner devServer={health?.devServer} />

        {/* Main layout body */}
        <div
          className={cn(
            "min-h-0 flex-1",
            isMobile ? "w-full" : "flex overflow-hidden",
          )}
        >
          {/* ── Mobile sidebar overlay backdrop ── */}
          <AnimatePresence>
            {isMobile && sidebarOpen && (
              <motion.button
                key="sidebar-backdrop"
                type="button"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] cursor-default"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close sidebar"
              />
            )}
          </AnimatePresence>

          {/* ── Mobile sidebar — animated slide from left ── */}
          {isMobile ? (
            <AnimatePresence>
              {sidebarOpen && (
                <motion.div
                  key="mobile-sidebar"
                  variants={slideFromLeft}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden pt-[env(safe-area-inset-top)]"
                  style={{ width: 240 }}
                >
                  {isInstanceSettingsRoute ? (
                    <InstanceSidebar />
                  ) : (
                    <AppSidebar
                      health={health}
                      instanceSettingsTarget={instanceSettingsTarget}
                      onNavigate={() => setSidebarOpen(false)}
                    />
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          ) : (
            /* ── Desktop sidebar — collapsible with width transition ── */
            <div
              className={cn(
                "flex h-full shrink-0 flex-col overflow-hidden transition-[width] duration-150 ease-out border-r border-border/60",
                sidebarOpen ? "w-60" : "w-0",
              )}
            >
              <div className="flex-1 min-h-0 w-60">
                {isInstanceSettingsRoute ? (
                  <InstanceSidebar />
                ) : (
                  <AppSidebar
                    health={health}
                    instanceSettingsTarget={instanceSettingsTarget}
                  />
                )}
              </div>
            </div>
          )}

          {/* ── Center: breadcrumb + main content + properties panel ── */}
          <div
            className={cn(
              "flex min-w-0 flex-col",
              isMobile ? "w-full" : "h-full flex-1",
            )}
          >
            {/* Breadcrumb bar — sticky on mobile */}
            <div
              className={cn(
                isMobile &&
                  "sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85",
              )}
            >
              <BreadcrumbBar />
            </div>

            {/* Content row: main + optional right panel */}
            <div className={cn(isMobile ? "block" : "flex flex-1 min-h-0")}>
              <main
                id="main-content"
                tabIndex={-1}
                className={cn(
                  "flex-1 p-4 md:p-6 focus:outline-none",
                  isMobile
                    ? "overflow-visible pb-[calc(5rem+env(safe-area-inset-bottom))]"
                    : "overflow-auto",
                )}
              >
                {hasUnknownCompanyPrefix ? (
                  <NotFoundPage
                    scope="invalid_company_prefix"
                    requestedPrefix={
                      companyPrefix ?? selectedCompany?.issuePrefix
                    }
                  />
                ) : (
                  <Outlet />
                )}
              </main>

              {/* Right properties panel */}
              <PropertiesPanel />
            </div>
          </div>
        </div>

        {/* ── Mobile bottom nav ── */}
        {isMobile && <MobileBottomNav visible={mobileNavVisible} />}

        {/* ── Global overlays ── */}
        <CommandPalette />
        <NewIssueDialog />
        <NewProjectDialog />
        <NewGoalDialog />
        <NewAgentDialog />
        <ToastViewport />
      </div>
    </GeneralSettingsProvider>
  );
}
