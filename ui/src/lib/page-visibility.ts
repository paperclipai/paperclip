import { useSyncExternalStore } from "react";

/**
 * Page-visibility helpers for restore-storm mitigation (PAP-12556 / Phase 1).
 *
 * A tab can be in one of three practical states that matter for polling:
 *   - hidden:   `document.visibilityState !== "visible"` — the user is not looking at it.
 *   - visible:  on screen but not the focused window (e.g. split-screen, another window on top).
 *   - focused:  visible AND `document.hasFocus()` — the tab the user is actively using.
 *
 * The distinction matters because the UX guidance (PAP-12552 §6, "active-tab exemption")
 * requires the focused tab to keep near-normal cadence and minimal jitter, while merely
 * restored/background tabs may slow down and jitter widely. Header value is a
 * non-authoritative observability hint only — never a security signal.
 */

export interface PageVisibility {
  /** `document.visibilityState === "visible"`. */
  visible: boolean;
  /** Visible AND the document currently has focus. */
  focused: boolean;
}

const HIDDEN: PageVisibility = { visible: false, focused: false };

export function getPageVisibility(): PageVisibility {
  if (typeof document === "undefined") {
    // SSR / non-browser: treat as focused so data loads normally.
    return { visible: true, focused: true };
  }
  const visible = document.visibilityState === "visible";
  if (!visible) return HIDDEN;
  const focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
  return { visible: true, focused };
}

/** Stable header value for `X-Paperclip-Tab-Visible`: "focused" | "visible" | "hidden". */
export function getVisibilityHeaderValue(state: PageVisibility = getPageVisibility()): string {
  if (!state.visible) return "hidden";
  return state.focused ? "focused" : "visible";
}

// --- Shared subscription (single set of DOM listeners for all consumers) ---

const listeners = new Set<() => void>();
let cached: PageVisibility = getPageVisibility();
let attached = false;

function sameState(a: PageVisibility, b: PageVisibility): boolean {
  return a.visible === b.visible && a.focused === b.focused;
}

function recompute() {
  const next = getPageVisibility();
  if (sameState(next, cached)) return;
  cached = next;
  for (const listener of listeners) listener();
}

function attach() {
  if (attached || typeof document === "undefined") return;
  attached = true;
  document.addEventListener("visibilitychange", recompute);
  window.addEventListener("focus", recompute);
  window.addEventListener("blur", recompute);
  window.addEventListener("pageshow", recompute);
}

function detach() {
  if (!attached || typeof document === "undefined") return;
  attached = false;
  document.removeEventListener("visibilitychange", recompute);
  window.removeEventListener("focus", recompute);
  window.removeEventListener("blur", recompute);
  window.removeEventListener("pageshow", recompute);
}

/** Subscribe to visibility/focus transitions. Returns an unsubscribe fn. */
export function subscribePageVisibility(listener: () => void): () => void {
  listeners.add(listener);
  attach();
  // Re-sync in case state changed between last recompute and subscription.
  cached = getPageVisibility();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) detach();
  };
}

/** Snapshot for `useSyncExternalStore` — returns a referentially-stable object between changes. */
export function getPageVisibilitySnapshot(): PageVisibility {
  return cached;
}

function getServerSnapshot(): PageVisibility {
  return { visible: true, focused: true };
}

/**
 * React hook returning the current `{ visible, focused }` state, re-rendering on transitions.
 * Backed by a single shared set of DOM listeners regardless of how many components subscribe.
 */
export function usePageVisibility(): PageVisibility {
  return useSyncExternalStore(subscribePageVisibility, getPageVisibilitySnapshot, getServerSnapshot);
}
