import { useSyncExternalStore } from "react";

/**
 * Per-browser choice of the key that sends a message or comment.
 * - `"enter"`: Return sends, Shift+Return inserts a newline.
 * - `"mod-enter"`: Cmd/Ctrl+Return sends, Return inserts a newline.
 *
 * Until the user picks one, each composer keeps its own default.
 */
export type SubmitKeyMode = "enter" | "mod-enter";

export const SUBMIT_KEY_STORAGE_KEY = "paperclip.submitKey";
const changeEventName = "paperclip:submit-key-preference";
// Fallback for browsers where localStorage throws (blocked storage).
let memoryValue: string | null = null;

function parseMode(raw: string | null): SubmitKeyMode | null {
  return raw === "enter" || raw === "mod-enter" ? raw : null;
}

export function getSubmitKeyPreference(): SubmitKeyMode | null {
  try {
    return parseMode(window.localStorage.getItem(SUBMIT_KEY_STORAGE_KEY));
  } catch {
    return parseMode(memoryValue);
  }
}

export function setSubmitKeyPreference(mode: SubmitKeyMode) {
  memoryValue = mode;
  try {
    window.localStorage.setItem(SUBMIT_KEY_STORAGE_KEY, mode);
  } catch {
    /* The choice still applies to this tab without storage. */
  }
  window.dispatchEvent(new Event(changeEventName));
}

export function subscribeSubmitKeyPreference(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SUBMIT_KEY_STORAGE_KEY) callback();
  };
  window.addEventListener(changeEventName, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(changeEventName, callback);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSubmitKeyPreference(): SubmitKeyMode | null {
  return useSyncExternalStore(subscribeSubmitKeyPreference, getSubmitKeyPreference, () => null);
}

/** The user's choice when set, otherwise the composer's own default. */
export function useResolvedSubmitKey(fallback: SubmitKeyMode): SubmitKeyMode {
  return useSubmitKeyPreference() ?? fallback;
}

export interface SubmitKeyEventLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}

/**
 * True when the key combination should send the message in `mode`.
 * Cmd/Ctrl+Return sends in both modes; plain Return sends only in `"enter"` mode.
 * IME composition (choosing a candidate with Return) never sends.
 */
export function isSubmitKeyEvent(event: SubmitKeyEventLike, mode: SubmitKeyMode): boolean {
  if (event.key !== "Enter") return false;
  if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return false;
  if (event.metaKey || event.ctrlKey) return true;
  if (mode === "mod-enter") return false;
  return !event.shiftKey && !event.altKey;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Human label for the send shortcut, e.g. "Return" or "⌘Return" / "Ctrl+Return". */
export function submitShortcutLabel(mode: SubmitKeyMode, mac = isMacPlatform()): string {
  if (mode === "enter") return "Return";
  return mac ? "⌘Return" : "Ctrl+Return";
}
