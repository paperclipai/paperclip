import { useCallback, useRef } from "react";

import { navigateTopLevel } from "./browserNavigation";

/**
 * Every window Paperclip opens for a sign-in reuses this name, so a second
 * attempt replaces the abandoned tab instead of stacking another one up.
 */
const AUTHORIZATION_WINDOW_NAME = "paperclip-connection-oauth";
/** Omitting the feature string is what makes a browser open a tab, not a popup. */
const POPUP_FEATURES = "popup,width=720,height=760,resizable=yes,scrollbars=yes";

export type AuthorizationWindowKind = "tab" | "popup";

export interface AuthorizationWindow {
  /**
   * Claim the window synchronously from the click that starts sign-in, before
   * anything is awaited.
   */
  reserve: () => void;
  /** Hand a prepared authorization URL to the claimed window. */
  open: (url: string) => boolean;
  /**
   * Hand a prepared authorization URL to the claimed window, or, when the
   * browser refused to give us one, to this one. `prepare` runs against the
   * window that will actually navigate, so state sign-in needs to find on the
   * way back — a pending Cloud handoff — is written where it will be read.
   */
  navigateTo: (url: string, prepare?: (destination: Window) => void) => void;
  /**
   * The claimed window, for handoff state that has to be written inside it and
   * for watching it close. Null once nothing is claimed; a claimed window that
   * the operator has since closed is still returned, so callers can tell "gone"
   * apart from "never opened".
   */
  current: () => Window | null;
  close: () => void;
  /** Drop the claim without closing, so a real link can own the navigation. */
  forget: () => void;
}

/**
 * Open a connector sign-in beside Paperclip instead of on top of it.
 *
 * Authorization always hands the operator to a page Paperclip does not own, so
 * it gets its own tab: the board keeps its wizard step, its pending queries and
 * its place in the app, and the operator returns to a page that is still where
 * they left it rather than to a cold reload.
 *
 * The window is reserved on the click rather than opened with the authorization
 * URL once it arrives. Transient user activation expires while the server mints
 * the URL — a `connect` call, a `startOAuth` call and, for managed connectors, a
 * Cloud handoff round-trip — and a `window.open` after those awaits is exactly
 * what a popup blocker eats. Callers that get `false` back from `open` have a
 * blocked browser and should offer a real `target="_blank"` link instead.
 */
export function useAuthorizationWindow(kind: AuthorizationWindowKind = "tab"): AuthorizationWindow {
  const windowRef = useRef<Window | null>(null);
  const features = kind === "popup" ? POPUP_FEATURES : undefined;

  const reserve = useCallback(() => {
    if (windowRef.current?.closed === false) return;
    windowRef.current = window.open("about:blank", AUTHORIZATION_WINDOW_NAME, features);
  }, [features]);

  const open = useCallback((url: string) => {
    const reserved = windowRef.current;
    try {
      if (reserved && !reserved.closed) {
        reserved.location.assign(url);
        reserved.focus();
        return true;
      }
      // Nothing was reserved, or it was closed while the URL was being prepared.
      // One direct attempt is still worth making: the click may be recent enough
      // that the browser allows it.
      const opened = window.open(url, AUTHORIZATION_WINDOW_NAME, features);
      windowRef.current = opened;
      opened?.focus();
      return Boolean(opened);
    } catch {
      // A window we no longer control is the same dead end as a blocked one.
      return false;
    }
  }, [features]);

  const navigateTo = useCallback((url: string, prepare?: (destination: Window) => void) => {
    const reserved = windowRef.current;
    if (reserved && !reserved.closed) {
      try {
        prepare?.(reserved);
        reserved.location.assign(url);
        reserved.focus();
        return;
      } catch {
        // A window we can no longer drive is no better than one we never got.
      }
    }
    prepare?.(window);
    navigateTopLevel(url);
  }, []);

  const current = useCallback(() => windowRef.current, []);

  const close = useCallback(() => {
    windowRef.current?.close();
    windowRef.current = null;
  }, []);

  const forget = useCallback(() => {
    windowRef.current = null;
  }, []);

  return { reserve, open, navigateTo, current, close, forget };
}
