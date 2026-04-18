import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router";
import { TitleBar } from "./TitleBar";
import { NavigationRail } from "./NavigationRail";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { ErrorBoundary } from "./ErrorBoundary";
import { useSidebar } from "@/context/SidebarContext";

export function AppShell() {
  const { toggleSidebar } = useSidebar();
  const navigate = useNavigate();

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        navigate("/settings");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [toggleSidebar, navigate]);

  const openPalette = () => {
    const toggle = (window as unknown as Record<string, unknown>).__archonos_toggle_palette;
    if (typeof toggle === "function") toggle();
  };

  return (
    <div className="flex h-screen w-screen flex-col" style={{ background: "var(--bg)" }}>
      <TitleBar onSearchClick={openPalette} />
      <div className="flex min-h-0 flex-1">
        <NavigationRail />
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-8">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}
