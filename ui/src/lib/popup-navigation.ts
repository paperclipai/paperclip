/**
 * Safely navigates an existing popup window, returning the active navigated window handle
 * (or `null` when the popup is unusable or every navigation strategy fails).
 *
 * Browsers restrict cross-origin property reads on the `Location` object.
 * When a popup has already navigated to an external domain (e.g. GitHub or an OAuth provider),
 * accessing `popup.location.assign` throws a `SecurityError`.
 *
 * In contrast, setting `popup.location.href` is explicitly permitted cross-origin
 * by the HTML Living Standard. If location writes still fail and `window.open` opens
 * a replacement handle, that new handle is returned so callers track and focus it.
 */
export function navigatePopupWindow(popup: Window | null | undefined, target: string): Window | null {
  if (!popup || popup.closed) return null;
  try {
    popup.location.assign(target);
    return popup;
  } catch {
    // Cross-origin access or missing assign method
  }
  try {
    popup.location.href = target;
    return popup;
  } catch {
    // Fallback if location object is restricted
  }
  try {
    (popup as unknown as { location: string }).location = target;
    return popup;
  } catch {
    try {
      if (typeof window !== "undefined" && typeof window.open === "function") {
        let targetName = "";
        try {
          targetName = popup.name ?? "";
        } catch {
          // Reading popup.name can fail on cross-origin handles; fall back to an unnamed window.
        }
        const opened = window.open(target, targetName);
        if (!opened) return null;
        if (opened !== popup) {
          try {
            popup.close();
          } catch {
            // Ignore close errors on superseded cross-origin popup handles.
          }
        }
        return opened;
      }
      return null;
    } catch {
      return null;
    }
  }
}


/**
 * Safely focuses an existing popup window, swallowing any cross-origin restrictions.
 */
export function focusPopupWindow(popup: Window): void {
  try {
    popup.focus();
  } catch {
    // Cross-origin or closed popup focus errors are ignored
  }
}
