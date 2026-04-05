import { useEffect, useCallback, useRef } from "react";
import { useBeforeUnload } from "react-router-dom";

/**
 * Warns the user when they try to navigate away or close the tab while
 * there are unsaved changes.
 *
 * Usage:
 *   const { markDirty, markClean } = useUnsavedChanges(isDirty);
 *
 * Or pass a boolean directly:
 *   useUnsavedChanges(formHasChanges);
 */
export function useUnsavedChanges(
  dirty: boolean,
  message = "You have unsaved changes. Are you sure you want to leave?",
) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Native browser beforeunload (handles tab close / hard refresh)
  useBeforeUnload(
    useCallback(
      (event) => {
        if (dirtyRef.current) {
          event.preventDefault();
        }
      },
      [],
    ),
  );

  // Handle in-app popstate navigation (back/forward browser buttons)
  useEffect(() => {
    if (!dirty) return;

    const handlePopState = (event: PopStateEvent) => {
      if (dirtyRef.current) {
        // eslint-disable-next-line no-alert
        const confirmed = window.confirm(message);
        if (!confirmed) {
          // Push state back to prevent navigation
          event.preventDefault();
          window.history.pushState(null, "", window.location.href);
        }
      }
    };

    // Push a dummy state so we can intercept back navigation
    window.history.pushState(null, "", window.location.href);
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [dirty, message]);
}
