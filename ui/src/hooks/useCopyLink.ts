import { useCallback } from "react";
import { useOptionalToastActions } from "../context/ToastContext";

/**
 * Copy an app-relative path to the clipboard as an absolute URL, with
 * toast feedback. The Clipboard API rejects in non-secure contexts and
 * when the clipboard-write permission is denied, so surface the failure
 * instead of swallowing it.
 */
export function useCopyLink() {
  const toastActions = useOptionalToastActions();
  return useCallback(
    (path: string) => {
      navigator.clipboard.writeText(`${window.location.origin}${path}`).then(
        () => {
          toastActions?.pushToast({ title: "Link copied", tone: "success" });
        },
        () => {
          toastActions?.pushToast({
            title: "Copy failed",
            body: "Clipboard is unavailable in this context.",
            tone: "error",
          });
        },
      );
    },
    [toastActions],
  );
}
