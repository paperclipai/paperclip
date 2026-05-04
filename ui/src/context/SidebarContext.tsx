import { createContext, useCallback, useContext, useState, useEffect, type ReactNode } from "react";

interface SidebarContextValue {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  isMobile: boolean;
  /** Desktop-only: sidebar is visible but narrow (icons only) */
  collapsed: boolean;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

const MOBILE_BREAKPOINT = 768;
const SIDEBAR_STORAGE_KEY = "paperclip:sidebar-open";

function readSidebarPref(): boolean | null {
  try {
    const v = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return v === "true" ? true : v === "false" ? false : null;
  } catch { return null; }
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  const [sidebarOpen, setSidebarOpenRaw] = useState(() => {
    if (window.innerWidth < MOBILE_BREAKPOINT) return false;
    return readSidebarPref() ?? true;
  });

  const setSidebarOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    setSidebarOpenRaw((prev) => {
      const next = typeof open === "function" ? open(prev) : open;
      if (!isMobile) {
        try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next)); } catch {}
      }
      return next;
    });
  }, [isMobile]);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (e.matches) {
        setSidebarOpenRaw(false);
      } else {
        setSidebarOpenRaw(readSidebarPref() ?? true);
      }
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), [setSidebarOpen]);

  const collapsed = !isMobile && !sidebarOpen;

  return (
    <SidebarContext.Provider value={{ sidebarOpen, setSidebarOpen, toggleSidebar, isMobile, collapsed }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used within SidebarProvider");
  }
  return ctx;
}
