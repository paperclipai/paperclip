import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Moon, Sun } from "lucide-react";
import { Outlet, useLocation, useNavigate, useParams } from "@/lib/router";
import { CompanyRail } from "./CompanyRail";
import { Sidebar } from "./Sidebar";
import { SidebarNavItem } from "./SidebarNavItem";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { PropertiesPanel } from "./PropertiesPanel";
import { CommandPalette } from "./CommandPalette";
import { NewIssueDialog } from "./NewIssueDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { NewGoalDialog } from "./NewGoalDialog";
import { NewAgentDialog } from "./NewAgentDialog";
import { ToastViewport } from "./ToastViewport";
import { MobileBottomNav } from "./MobileBottomNav";
import { useDialog } from "../context/DialogContext";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useTheme } from "../context/ThemeContext";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useCompanyPageMemory } from "../hooks/useCompanyPageMemory";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { NotFoundPage } from "../pages/NotFound";
import { ErrorBoundary } from "./ErrorBoundary";
import { Button } from "@/components/ui/button";

type ContentWidth = "focused" | "full";
const CONTENT_WIDTH_KEY = "outpost.contentWidth";
const CONTENT_ZOOM_KEY = "outpost.contentZoom";
const ZOOM_LEVELS = [100, 110, 125, 150] as const;
type ZoomLevel = (typeof ZOOM_LEVELS)[number];

interface ContentWidthContextValue {
  contentWidth: ContentWidth;
  toggleContentWidth: () => void;
  forceFullWidth: () => void;
  releaseFullWidth: () => void;
  zoom: ZoomLevel;
  cycleZoom: () => void;
}

const ContentWidthContext = createContext<ContentWidthContextValue>({
  contentWidth: "focused",
  toggleContentWidth: () => {},
  forceFullWidth: () => {},
  releaseFullWidth: () => {},
  zoom: 100,
  cycleZoom: () => {},
});

export function useContentWidth() {
  return useContext(ContentWidthContext);
}

export { ZOOM_LEVELS };

export function Layout() {
  const { sidebarOpen, setSidebarOpen, toggleSidebar, isMobile } = useSidebar();
  const { openNewIssue, openOnboarding } = useDialog();
  const { togglePanelVisible } = usePanel();
  const {
    companies,
    loading: companiesLoading,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId,
  } = useCompany();
  const { theme, toggleTheme } = useTheme();
  const showCompanyRail = companies.length > 1;
  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const onboardingTriggered = useRef(false);
  const lastMainScrollTop = useRef(0);
  const [mobileNavVisible, setMobileNavVisible] = useState(true);
  const nextTheme = theme === "dark" ? "light" : "dark";
  const [contentWidth, setContentWidth] = useState<ContentWidth>(() => {
    try {
      const stored = localStorage.getItem(CONTENT_WIDTH_KEY);
      return stored === "full" ? "full" : "focused";
    } catch { return "focused"; }
  });
  const toggleContentWidth = useCallback(() => {
    setContentWidth((prev) => {
      const next = prev === "focused" ? "full" : "focused";
      try { localStorage.setItem(CONTENT_WIDTH_KEY, next); } catch {}
      return next;
    });
  }, []);
  const [zoom, setZoom] = useState<ZoomLevel>(() => {
    try {
      const stored = Number(localStorage.getItem(CONTENT_ZOOM_KEY));
      return (ZOOM_LEVELS as readonly number[]).includes(stored) ? (stored as ZoomLevel) : 100;
    } catch { return 100; }
  });
  const cycleZoom = useCallback(() => {
    setZoom((prev) => {
      const idx = ZOOM_LEVELS.indexOf(prev);
      const next = ZOOM_LEVELS[(idx + 1) % ZOOM_LEVELS.length]!;
      try { localStorage.setItem(CONTENT_ZOOM_KEY, String(next)); } catch {}
      return next;
    });
  }, []);
  const fullWidthForceCount = useRef(0);
  const [fullWidthForced, setFullWidthForced] = useState(false);
  const forceFullWidth = useCallback(() => {
    fullWidthForceCount.current += 1;
    setFullWidthForced(true);
  }, []);
  const releaseFullWidth = useCallback(() => {
    fullWidthForceCount.current = Math.max(0, fullWidthForceCount.current - 1);
    if (fullWidthForceCount.current === 0) setFullWidthForced(false);
  }, []);
  const effectiveContentWidth: ContentWidth = fullWidthForced ? "full" : contentWidth;
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

    if (selectedCompanyId !== matchedCompany.id) {
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
    selectedCompanyId,
    setSelectedCompanyId,
  ]);

  const togglePanel = togglePanelVisible;

  // Cmd+1..9 to switch companies
  const switchCompany = useCallback(
    (index: number) => {
      if (index < companies.length) {
        setSelectedCompanyId(companies[index]!.id);
      }
    },
    [companies, setSelectedCompanyId],
  );

  useCompanyPageMemory();

  useKeyboardShortcuts({
    onNewIssue: () => openNewIssue(),
    onToggleSidebar: toggleSidebar,
    onTogglePanel: togglePanel,
    onToggleContentWidth: toggleContentWidth,
    onSwitchCompany: switchCompany,
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
    const root = document.documentElement;
    if (zoom !== 100) {
      root.style.zoom = String(zoom / 100);
    } else {
      root.style.removeProperty("zoom");
    }
    return () => {
      root.style.removeProperty("zoom");
    };
  }, [zoom]);

  return (
    <ContentWidthContext.Provider value={{ contentWidth: effectiveContentWidth, toggleContentWidth, forceFullWidth, releaseFullWidth, zoom, cycleZoom }}>
    <div
      className={cn(
        "bg-background text-foreground pt-[env(safe-area-inset-top)]",
        isMobile ? "min-h-dvh" : "flex h-dvh overflow-hidden",
      )}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to Main Content
      </a>
      {/* Mobile backdrop */}
      {isMobile && sidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/50"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
        />
      )}

      {/* Combined sidebar area: company rail + inner sidebar + docs bar */}
      {isMobile ? (
        <div
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] transition-transform duration-100 ease-out",
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {showCompanyRail && <CompanyRail />}
            <Sidebar />
          </div>
          <div className="border-t border-r border-border px-3 py-2 bg-background">
            <div className="flex items-center gap-1">
              <SidebarNavItem
                to="/docs"
                label="Documentation"
                icon={BookOpen}
                className="flex-1 min-w-0"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground shrink-0"
                onClick={toggleTheme}
                aria-label={`Switch to ${nextTheme} mode`}
                title={`Switch to ${nextTheme} mode`}
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex shrink-0 h-full">
          {showCompanyRail && <CompanyRail />}
          <div
            className={cn(
              "overflow-hidden transition-[width] duration-100 ease-out flex flex-col",
              sidebarOpen ? "w-60" : "w-0"
            )}
          >
            <div className="w-60 flex-1 min-h-0">
              <Sidebar />
            </div>
            <div className="w-60 border-t border-r border-border px-3 py-2 shrink-0">
              <div className="flex items-center gap-1">
                <SidebarNavItem
                  to="/docs"
                  label="Documentation"
                  icon={BookOpen}
                  className="flex-1 min-w-0"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground shrink-0"
                  onClick={toggleTheme}
                  aria-label={`Switch to ${nextTheme} mode`}
                  title={`Switch to ${nextTheme} mode`}
                >
                  {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
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
            tabIndex={-1}
            className={cn(
              "flex-1",
              fullWidthForced ? "p-0" : "p-4 md:p-6",
              isMobile ? "overflow-visible pb-[calc(5rem+env(safe-area-inset-bottom))]" : "overflow-auto",
            )}
          >
            <ErrorBoundary>
              <div
                className={cn(
                  "w-full transition-[max-width] duration-200",
                  effectiveContentWidth === "focused" && "max-w-[1100px] mx-auto",
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
              </div>
            </ErrorBoundary>
          </main>
          <PropertiesPanel />
        </div>
      </div>
      {isMobile && <MobileBottomNav visible={mobileNavVisible} />}
      <CommandPalette />
      <NewIssueDialog />
      <NewProjectDialog />
      <NewGoalDialog />
      <NewAgentDialog />
      <ToastViewport />
    </div>
    </ContentWidthContext.Provider>
  );
}
