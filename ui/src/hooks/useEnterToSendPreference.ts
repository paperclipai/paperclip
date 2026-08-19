import { useCallback, useEffect, useState } from "react";

export const ENTER_TO_SEND_STORAGE_KEY = "paperclip.composer.enterToSend";

function readStoredEnterToSend(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ENTER_TO_SEND_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredEnterToSend(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ENTER_TO_SEND_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Storage can be unavailable in private contexts; the in-memory value
    // still works for the current session.
  }
}

/**
 * Per-user "Send message on Enter" preference for the issue-thread and
 * comment composers (MarkdownEditor). Persisted to localStorage rather than
 * an instance setting since it's a personal preference, not shared across a
 * company. Default is off so existing Cmd/Ctrl+Enter behavior is unchanged
 * until a user opts in. Synced across tabs via the `storage` event.
 */
export function useEnterToSendPreference(): [boolean, (next: boolean) => void] {
  const [enterToSend, setEnterToSendState] = useState<boolean>(() => readStoredEnterToSend());

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== ENTER_TO_SEND_STORAGE_KEY) return;
      setEnterToSendState(event.newValue === "1");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setEnterToSend = useCallback((next: boolean) => {
    setEnterToSendState(next);
    writeStoredEnterToSend(next);
  }, []);

  return [enterToSend, setEnterToSend];
}
