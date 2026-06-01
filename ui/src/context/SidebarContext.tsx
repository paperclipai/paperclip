import { createContext, useCallback, useContext, useState, useEffect, type ReactNode } from "react";

interface SidebarContextValue {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  isMobile: boolean;
  isNarrow: boolean;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

const MOBILE_BREAKPOINT = 768;
const NARROW_BREAKPOINT = 1024;

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < NARROW_BREAKPOINT);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= NARROW_BREAKPOINT);

  useEffect(() => {
    const mobileMql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const narrowMql = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT - 1}px)`);
    const onMobileChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    const onNarrowChange = (e: MediaQueryListEvent) => {
      setIsNarrow(e.matches);
      // Close off-canvas sidebar when entering narrow viewport, open when leaving
      setSidebarOpen(!e.matches);
    };
    mobileMql.addEventListener("change", onMobileChange);
    narrowMql.addEventListener("change", onNarrowChange);
    return () => {
      mobileMql.removeEventListener("change", onMobileChange);
      narrowMql.removeEventListener("change", onNarrowChange);
    };
  }, []);

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  return (
    <SidebarContext.Provider value={{ sidebarOpen, setSidebarOpen, toggleSidebar, isMobile, isNarrow }}>
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

/**
 * Non-throwing variant: returns `false` when rendered outside a SidebarProvider
 * (e.g. isolated component tests / UX-lab pages). Use this for purely cosmetic
 * responsive tweaks where the absence of a provider should degrade gracefully
 * rather than crash the subtree.
 */
export function useIsMobileSafe(): boolean {
  const ctx = useContext(SidebarContext);
  return ctx?.isMobile ?? false;
}
