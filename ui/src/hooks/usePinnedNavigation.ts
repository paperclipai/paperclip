import { useCallback, useState, useSyncExternalStore } from "react";

const UPDATED = "paperclip:pinned-navigation-updated";
const EMPTY = "[]";

function read(key: string | null) {
  try { return key ? localStorage.getItem(key) ?? EMPTY : EMPTY; }
  catch { return EMPTY; }
}

function parse(value: string): string[] {
  try {
    const entries: unknown = JSON.parse(value);
    return Array.isArray(entries) ? [...new Set(entries.filter((entry): entry is string => typeof entry === "string"))] : [];
  } catch { return []; }
}

/** Personal browser navigation preference. Stores route names, never work data. */
export function usePinnedNavigation(userId: string | null | undefined) {
  const key = userId ? `paperclip.coordinator.pinned-nav.v1:${encodeURIComponent(userId)}` : null;
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const subscribe = useCallback((notify: () => void) => {
    const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) notify(); };
    const updated = (event: Event) => { if ((event as CustomEvent<string>).detail === key) notify(); };
    window.addEventListener("storage", storage);
    window.addEventListener(UPDATED, updated);
    return () => { window.removeEventListener("storage", storage); window.removeEventListener(UPDATED, updated); };
  }, [key]);
  const snapshot = useSyncExternalStore(subscribe, () => read(key), () => EMPTY);

  function toggle(to: string) {
    if (!key) return;
    const current = parse(read(key));
    const next = current.includes(to) ? current.filter(entry => entry !== to) : [...current, to];
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setFailure(null);
      window.dispatchEvent(new CustomEvent(UPDATED, { detail: key }));
    } catch {
      setFailure({ key, message: "Couldn’t save pinned pages. Allow browser storage and try again." });
    }
  }

  return { pins: parse(snapshot), toggle, canPin: !!key, error: failure?.key === key ? failure.message : null };
}
