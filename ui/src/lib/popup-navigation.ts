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
export function navigatePopupWindow(popup: Window, target: string): void {
  try {
    popup.location.assign(target);
    return;
  } catch {
    // Cross-origin access or missing assign method
  }
  try {
    popup.location.href = target;
    return;
  } catch {
    // Fallback if location object is restricted
  }
  try {
    (popup as unknown as { location: string }).location = target;
  } catch {
    try {
      window.open(target, popup.name);
    } catch {
      // Ignore if window.open fails
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
