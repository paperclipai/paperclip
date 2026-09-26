/**
 * Safely navigates an existing popup window.
 *
 * Browsers restrict cross-origin property reads on the `Location` object.
 * When a popup has already navigated to an external domain (e.g. GitHub or an OAuth provider),
 * accessing `popup.location.assign` throws a `SecurityError`.
 *
 * In contrast, setting `popup.location.href` is explicitly permitted cross-origin
 * by the HTML Living Standard.
 */
export function navigatePopupWindow(popup: Window | null | undefined, target: string): boolean {
  if (!popup || popup.closed) return false;
  try {
    popup.location.assign(target);
    return true;
  } catch {
    // Cross-origin access or missing assign method
  }
  try {
    popup.location.href = target;
    return true;
  } catch {
    // Fallback if location object is restricted
  }
  try {
    (popup as unknown as { location: string }).location = target;
    return true;
  } catch {
    try {
      if (typeof window !== "undefined" && typeof window.open === "function") {
        const opened = window.open(target, popup.name);
        return Boolean(opened);
      }
      return false;
    } catch {
      return false;
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
