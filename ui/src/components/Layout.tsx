import { useCallback, useEffect, useRef, useState, type UIEvent } from "react";
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
import { Button } from "@/components/ui/button";

export function Layout() {
  const { sidebarOpen, setSidebarOpen, toggleSidebar, isMobile } = useSidebar();
  const { openNewIssue, openOnboarding } = useDialog();
  const { togglePanelVisible } = usePanel();
  const { companies, loading: companiesLoading, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { theme, toggleTheme } = useTheme();
  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const onboardingTriggered = useRef(false);
  const lastMainScrollTop = useRef(0);
  const [mobileNavVisible, setMobileNavVisible] = useState(true);
  const nextTheme = theme === "dark" ? "light" : "dark";
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

    const requestedPrefix = companyPrefix.toUpperCase();
    const matched = companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix);

    if (!matched) {
      const fallback =
        (selectedCompanyId ? companies.find((company) => company.id === selectedCompanyId) : null)
        ?? companies[0]!;
      navigate(`/${fallback.issuePrefix}/dashboard`, { replace: true });
      return;
    }

    if (companyPrefix !== matched.issuePrefix) {
      const suffix = location.pathname.replace(/^\/[^/]+/, "");
      navigate(`/${matched.issuePrefix}${suffix}${location.search}`, { replace: true });
      return;
    }

    if (selectedCompanyId !== matched.id) {
      setSelectedCompanyId(matched.id, { source: "route_sync" });
    }
  }, [
    companyPrefix,
    companies,
    companiesLoading,
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

  const handleMainScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      if (!isMobile) return;

      const currentTop = event.currentTarget.scrollTop;
      const delta = currentTop - lastMainScrollTop.current;

      if (currentTop <= 24) {
        setMobileNavVisible(true);
      } else if (delta > 8) {
        setMobileNavVisible(false);
      } else if (delta < -8) {
        setMobileNavVisible(true);
      }

      lastMainScrollTop.current = currentTop;
    },
    [isMobile],
  );

  return (
    <div className="relative flex h-dvh overflow-hidden bg-background pt-[env(safe-area-inset-top)] text-foreground">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--primary)_9%,transparent),transparent)]" />
      <div className="pointer-events-none absolute inset-x-6 top-5 hidden h-px bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--primary)_24%,transparent),transparent)] md:block" />
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
          className="fixed inset-0 z-40 bg-black/55 backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
        />
      )}

      {/* Keep the chrome panels separate so navigation reads as a switchboard beside the active workspace. */}
      {isMobile ? (
        <div
          className={cn(
            "fixed inset-y-2 left-2 z-50 flex max-w-[calc(100vw-1rem)] flex-col overflow-hidden pt-[env(safe-area-inset-top)] transition-transform duration-150 ease-out",
            sidebarOpen ? "translate-x-0" : "-translate-x-[calc(100%+1rem)]",
          )}
        >
          <div className="flex min-h-0 flex-1 gap-2 overflow-hidden">
            <CompanyRail />
            <Sidebar />
          </div>
          <div className="paperclip-panel mt-2 rounded-[calc(var(--radius)+0.4rem)] border px-3 py-2">
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
        <div className="flex h-full shrink-0 flex-col px-3 py-3 pr-0">
          <div className="flex min-h-0 flex-1 gap-2">
            <CompanyRail />
            <div
              className={cn(
                "overflow-hidden transition-[width,opacity] duration-150 ease-out",
                sidebarOpen ? "w-64 opacity-100" : "w-0 opacity-0",
              )}
            >
              <Sidebar />
            </div>
          </div>
          <div className="paperclip-panel mt-2 rounded-[calc(var(--radius)+0.4rem)] border px-3 py-2">
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
      )}

      <div className="flex h-full min-w-0 flex-1 flex-col px-3 py-3 pl-3">
        <div className="paperclip-panel-strong relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[calc(var(--radius)+0.9rem)]">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--primary)_42%,transparent),transparent)]" />
          <BreadcrumbBar />
          <div className="flex min-h-0 flex-1">
          <main
            id="main-content"
            tabIndex={-1}
            className={cn(
              "flex-1 overflow-auto px-4 pb-4 pt-4 md:px-6 md:pb-6 md:pt-5",
              isMobile && "pb-[calc(6.25rem+env(safe-area-inset-bottom))]",
            )}
            onScroll={handleMainScroll}
          >
            <Outlet />
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
      <ToastViewport />
    </div>
  );
}
