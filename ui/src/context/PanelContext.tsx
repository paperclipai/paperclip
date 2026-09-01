import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { SidePanelContentMode } from "@/components/side-panel";

const STORAGE_KEY = "paperclip:panel-visible";

interface PanelContextValue {
  panelContent: ReactNode | null;
  panelContentMode: SidePanelContentMode;
  panelVisible: boolean;
  openPanel: (content: ReactNode, options?: { contentMode?: SidePanelContentMode }) => void;
  closePanel: () => void;
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

export function PanelProvider({ children }: { children: ReactNode }) {
  const [panelContent, setPanelContent] = useState<ReactNode | null>(null);
  const [panelContentMode, setPanelContentMode] = useState<SidePanelContentMode>("padded");
  const [panelVisible, setPanelVisibleState] = useState(readPreference);

  const openPanel = useCallback((content: ReactNode, options?: { contentMode?: SidePanelContentMode }) => {
    setPanelContent(content);
    setPanelContentMode(options?.contentMode ?? "padded");
  }, []);

  const closePanel = useCallback(() => {
    setPanelContent(null);
    setPanelContentMode("padded");
  }, []);

  const setPanelVisible = useCallback((visible: boolean) => {
    setPanelVisibleState(visible);
    writePreference(visible);
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
      value={{ panelContent, panelContentMode, panelVisible, openPanel, closePanel, setPanelVisible, togglePanelVisible }}
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
