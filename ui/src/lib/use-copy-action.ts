import { t,  useTranslation  } from "@/i18n";
import { useCallback, useEffect, useRef, useState } from "react";

import { copyTextToClipboard } from "./clipboard";
import { withLiveToastPresentation } from "./live-update-toast";
import { useOptionalToastActions } from "../context/ToastContext";

export type CopyStatus = "idle" | "copied" | "failed";

/** How long a "Copied" state stays up before the control returns to rest. */
const RESET_MS = 1500;

/**
 * Inline copy feedback for a control that stays on screen after the click.
 *
 * Success is earned, never assumed. The status only turns `copied` once the
 * clipboard write resolves, so a blocked or insecure clipboard reads as a
 * failure rather than a confirmation of something that never happened — the
 * line `AdapterLoginChrome.test.tsx` already holds for its own copy button.
 */
export function useCopyAction(resetMs: number = RESET_MS) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timerRef = useRef<number | null>(null);
  /**
   * Which click owns the visible status. Clipboard writes can resolve out of
   * order, so without this a slow first copy could land after a fast second
   * one and report the wrong attempt — or reset the status while the newer
   * copy was still showing.
   */
  const latestCopyRef = useRef(0);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      const token = ++latestCopyRef.current;
      let next: CopyStatus = "copied";
      try {
        await copyTextToClipboard(text);
      } catch {
        next = "failed";
      }
      // A newer click has taken over the control; report this outcome to the
      // caller but leave the display to whoever the reader is watching.
      if (latestCopyRef.current !== token) return next;
      setStatus(next);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        if (latestCopyRef.current !== token) return;
        setStatus("idle");
        timerRef.current = null;
      }, resetMs);
      return next;
    },
    [resetMs],
  );

  return {
    status,
    copied: status === "copied",
    failed: status === "failed",
    copy,
  };
}

/**
 * Copy feedback for a control that disappears on click — a menu item, mostly.
 *
 * An inline "Copied" swap would unmount with the menu before anyone read it,
 * so the confirmation goes to the toast viewport instead. Same rule as above:
 * the success toast waits for the write to resolve.
 */
export function useCopyToast() {
  useTranslation("display");
  const toastActions = useOptionalToastActions();
  const pushToast = toastActions?.pushToast;

  return useCallback(
    async (text: string, copiedTitle?: string) => {
      try {
        await copyTextToClipboard(text);
        pushToast?.(withLiveToastPresentation({
          get title() { return copiedTitle ?? t("final-configuration:copySuccess"); },
          tone: "success",
          dedupeKey: `copy:${copiedTitle ?? "Copied"}`,
        }));
        return true;
      } catch {
        pushToast?.(withLiveToastPresentation({
          get "title"() { return t("display:copy_1cea87e8dc68"); },
          get "body"() { return t("display:copy_0f8704b1a7c8"); },
          tone: "error",
          dedupeKey: "copy-failed",
        }));
        return false;
      }
    },
    [pushToast],
  );
}
