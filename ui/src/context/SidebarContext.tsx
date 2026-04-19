import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type SidebarSide = "left" | "right";

interface SidebarContextValue {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  sidebarSide: SidebarSide;
  setSidebarSide: (side: SidebarSide) => void;
  toggleSidebarSide: () => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  resetSidebarWidth: () => void;
  isMobile: boolean;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

const MOBILE_BREAKPOINT = 768;
export const SIDEBAR_WIDTH_DEFAULT = 240;
export const SIDEBAR_WIDTH_MIN = 208;
export const SIDEBAR_WIDTH_MAX = 420;

const SIDEBAR_SIDE_STORAGE_KEY = "paperclip.sidebarSide";
const SIDEBAR_WIDTH_STORAGE_KEY = "paperclip.sidebarWidth";

function getInitialMobileState() {
  if (typeof window === "undefined") return false;
  return window.innerWidth < MOBILE_BREAKPOINT;
}

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

function readSidebarWidth() {
  if (typeof window === "undefined") return SIDEBAR_WIDTH_DEFAULT;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) return SIDEBAR_WIDTH_DEFAULT;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_WIDTH_DEFAULT;
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function readSidebarSide(): SidebarSide {
  if (typeof window === "undefined") return "left";
  try {
    return window.localStorage.getItem(SIDEBAR_SIDE_STORAGE_KEY) === "right" ? "right" : "left";
  } catch {
    return "left";
  }
}

function persistSidebarSide(side: SidebarSide) {
  try {
    window.localStorage.setItem(SIDEBAR_SIDE_STORAGE_KEY, side);
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isMobile, setIsMobile] = useState(getInitialMobileState);
  const [sidebarOpen, setSidebarOpen] = useState(() => !getInitialMobileState());
  const [sidebarSide, setSidebarSideState] = useState<SidebarSide>(readSidebarSide);
  const [sidebarWidth, setSidebarWidthState] = useState(readSidebarWidth);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      setSidebarOpen(!e.matches);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);
  const setSidebarSide = useCallback((side: SidebarSide) => {
    setSidebarSideState(side);
    persistSidebarSide(side);
  }, []);
  const toggleSidebarSide = useCallback(() => {
    setSidebarSideState((current) => {
      const next = current === "left" ? "right" : "left";
      persistSidebarSide(next);
      return next;
    });
  }, []);
  const setSidebarWidth = useCallback((width: number) => {
    const nextWidth = clampSidebarWidth(width);
    setSidebarWidthState(nextWidth);
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, []);
  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
  }, [setSidebarWidth]);

  return (
    <SidebarContext.Provider
      value={{
        sidebarOpen,
        setSidebarOpen,
        toggleSidebar,
        sidebarSide,
        setSidebarSide,
        toggleSidebarSide,
        sidebarWidth,
        setSidebarWidth,
        resetSidebarWidth,
        isMobile,
      }}
    >
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
