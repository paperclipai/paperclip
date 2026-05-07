import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

const STORAGE_KEY = "paperclip:panel-visible";
const WIDTH_STORAGE_KEY = "paperclip:panel-width";
const DEFAULT_PANEL_WIDTH = 320;
const MIN_PANEL_WIDTH = 240;
const MAX_PANEL_WIDTH = 600;

function clampPanelWidth(width: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, width));
}

interface PanelContextValue {
  panelContent: ReactNode | null;
  panelVisible: boolean;
  panelWidth: number;
  openPanel: (content: ReactNode) => void;
  closePanel: () => void;
  setPanelWidth: (width: number) => void;
  setPanelVisible: (visible: boolean) => void;
  togglePanelVisible: () => void;
}

const PanelContext = createContext<PanelContextValue | null>(null);

function readPreference(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function writePreference(visible: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(visible));
  } catch {
    // Ignore storage failures.
  }
}

function readPanelWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_PANEL_WIDTH;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_PANEL_WIDTH;
    return clampPanelWidth(parsed);
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
}

function writePanelWidth(width: number) {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Ignore storage failures.
  }
}

export function PanelProvider({ children }: { children: ReactNode }) {
  const [panelContent, setPanelContent] = useState<ReactNode | null>(null);
  const [panelVisible, setPanelVisibleState] = useState(readPreference);
  const [panelWidth, setPanelWidthState] = useState(readPanelWidth);

  const openPanel = useCallback((content: ReactNode) => {
    setPanelContent(content);
  }, []);

  const closePanel = useCallback(() => {
    setPanelContent(null);
  }, []);

  const setPanelVisible = useCallback((visible: boolean) => {
    setPanelVisibleState(visible);
    writePreference(visible);
  }, []);

  const setPanelWidth = useCallback((width: number) => {
    const clamped = clampPanelWidth(width);
    setPanelWidthState(clamped);
    writePanelWidth(clamped);
  }, []);

  const togglePanelVisible = useCallback(() => {
    setPanelVisibleState((prev) => {
      const next = !prev;
      writePreference(next);
      return next;
    });
  }, []);

  return (
    <PanelContext.Provider
      value={{
        panelContent,
        panelVisible,
        panelWidth,
        openPanel,
        closePanel,
        setPanelWidth,
        setPanelVisible,
        togglePanelVisible,
      }}
    >
      {children}
    </PanelContext.Provider>
  );
}

export function usePanel() {
  const ctx = useContext(PanelContext);
  if (!ctx) {
    throw new Error("usePanel must be used within PanelProvider");
  }
  return ctx;
}
