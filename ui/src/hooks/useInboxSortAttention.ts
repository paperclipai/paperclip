import { useCallback, useEffect, useRef } from "react";

export const INBOX_SORT_IDLE_COMMIT_MS = 150_000;
export const INBOX_SORT_HIDDEN_COMMIT_MS = 30_000;

export type InboxSortCommitReason =
  | "mount"
  | "idle"
  | "visibility"
  | "view-identity-change"
  | "manual-refresh";

type UseInboxSortAttentionOptions = {
  viewIdentity: string;
  onCommit: (reason: InboxSortCommitReason) => void;
  idleCommitMs?: number;
  hiddenCommitMs?: number;
};

export type InboxSortAttention = {
  /** Call for pointer, keyboard, hover, archive, expand/collapse, or scroll activity. */
  noteInteraction: () => void;
  /** Commit immediately at an explicit refresh boundary. */
  commitManualRefresh: () => void;
};

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * Owns the attention boundaries at which the inbox may safely adopt a newly
 * computed sort order. The caller owns order reconciliation and calls
 * `noteInteraction` for activity scoped to the inbox list.
 */
export function useInboxSortAttention({
  viewIdentity,
  onCommit,
  idleCommitMs = INBOX_SORT_IDLE_COMMIT_MS,
  hiddenCommitMs = INBOX_SORT_HIDDEN_COMMIT_MS,
}: UseInboxSortAttentionOptions): InboxSortAttention {
  const onCommitRef = useRef(onCommit);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hiddenAtRef = useRef<number | null>(null);
  const committedInitialViewRef = useRef(false);
  const previousViewIdentityRef = useRef(viewIdentity);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const restartIdleTimer = useCallback(() => {
    clearIdleTimer();
    if (!isDocumentVisible()) return;

    // Re-arm after each idle commit so an inbox left untouched keeps adopting the
    // freshly computed order every interval, rather than freezing at the first
    // idle snapshot until the next interaction or attention boundary.
    const armIdleTimer = () => {
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null;
        if (!isDocumentVisible()) return;
        onCommitRef.current("idle");
        armIdleTimer();
      }, idleCommitMs);
    };
    armIdleTimer();
  }, [clearIdleTimer, idleCommitMs]);

  const noteInteraction = useCallback(() => {
    restartIdleTimer();
  }, [restartIdleTimer]);

  const commitManualRefresh = useCallback(() => {
    onCommitRef.current("manual-refresh");
    restartIdleTimer();
  }, [restartIdleTimer]);

  useEffect(() => {
    if (!committedInitialViewRef.current) {
      committedInitialViewRef.current = true;
      onCommitRef.current("mount");
    } else if (previousViewIdentityRef.current !== viewIdentity) {
      onCommitRef.current("view-identity-change");
    }

    previousViewIdentityRef.current = viewIdentity;
    restartIdleTimer();
    return clearIdleTimer;
  }, [clearIdleTimer, restartIdleTimer, viewIdentity]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    if (document.visibilityState !== "visible") {
      hiddenAtRef.current = Date.now();
      clearIdleTimer();
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        hiddenAtRef.current = Date.now();
        clearIdleTimer();
        return;
      }

      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (hiddenAt !== null && Date.now() - hiddenAt >= hiddenCommitMs) {
        onCommitRef.current("visibility");
      }
      restartIdleTimer();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [clearIdleTimer, hiddenCommitMs, restartIdleTimer]);

  return { noteInteraction, commitManualRefresh };
}
