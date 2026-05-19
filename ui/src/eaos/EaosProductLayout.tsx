import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation } from "@/lib/router";
import { CommandPalette } from "@/components/CommandPalette";
import { DevRestartBanner } from "@/components/DevRestartBanner";
import { WorktreeBanner } from "@/components/WorktreeBanner";
import { ToastViewport } from "@/components/ToastViewport";
import { GeneralSettingsProvider } from "@/context/GeneralSettingsContext";
import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { scheduleMainContentFocus } from "@/lib/main-content-focus";
import { cn } from "@/lib/utils";

// LET-415: EaosProductLayout is the full-screen product-route layout for the
// canonical Enterprise Agent OS shell at `/eaos` and `/agent-os`. It is a
// deliberately thin wrapper: NO Paperclip board sidebar, NO breadcrumb bar,
// NO properties panel, NO mobile bottom nav. Andrii's correction
// (Telegram 2026-05-18) requires the EAOS surface to occupy the entire
// viewport without the LET/board frame.
//
// What this layout still provides:
//   - The page-level `<main id="main-content">` landmark (so the inner
//     EaosShell can keep rendering its banner/navigation/region/contentinfo
//     section-level landmarks unchanged).
//   - The global CommandPalette so the EAOS top-bar's ⌘K trigger keeps
//     working.
//   - Toast viewport, dev/restart banners, and the GeneralSettings context
//     consumed by descendants.
//
// What it intentionally omits: the Paperclip kernel/admin sidebar, breadcrumb
// bar, new-issue/project/goal dialogs, properties panel, and mobile bottom
// nav — those are board-app chrome, not EAOS product chrome.
export function EaosProductLayout() {
  const location = useLocation();
  const mainContentRef = useRef<HTMLElement | null>(null);

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
    if (typeof document === "undefined") return;
    return scheduleMainContentFocus(mainContentRef.current);
  }, [location.pathname]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <GeneralSettingsProvider value={{ keyboardShortcutsEnabled }}>
      <div
        className={cn(
          "flex h-dvh w-screen flex-col overflow-hidden bg-background text-foreground pt-[env(safe-area-inset-top)]",
        )}
        data-testid="eaos-product-layout"
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Skip to Main Content
        </a>
        <WorktreeBanner />
        <DevRestartBanner devServer={health?.devServer} />
        <main
          id="main-content"
          ref={mainContentRef}
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
        >
          <Outlet />
        </main>
      </div>
      <CommandPalette />
      <ToastViewport />
    </GeneralSettingsProvider>
  );
}
