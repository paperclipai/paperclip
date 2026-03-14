import { useEffect, useState } from "react";

const WORKSPACES_KEY = "paperclip:experimental:workspaces";

export function loadExperimentalWorkspacesEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(WORKSPACES_KEY) === "true";
}

export function saveExperimentalWorkspacesEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WORKSPACES_KEY, enabled ? "true" : "false");
  window.dispatchEvent(new CustomEvent("paperclip:experimental:workspaces", { detail: enabled }));
}

export function useExperimentalWorkspacesEnabled() {
  const [enabled, setEnabled] = useState(loadExperimentalWorkspacesEnabled);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== WORKSPACES_KEY) return;
      setEnabled(loadExperimentalWorkspacesEnabled());
    };
    const handleCustom = () => setEnabled(loadExperimentalWorkspacesEnabled());
    window.addEventListener("storage", handleStorage);
    window.addEventListener("paperclip:experimental:workspaces", handleCustom as EventListener);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("paperclip:experimental:workspaces", handleCustom as EventListener);
    };
  }, []);

  const update = (next: boolean) => {
    saveExperimentalWorkspacesEnabled(next);
    setEnabled(next);
  };

  return { enabled, setEnabled: update };
}
