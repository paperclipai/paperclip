import { useCallback, useEffect, useRef, useState } from "react";

export type AutosaveState = "idle" | "saving" | "saved" | "error";

const SAVING_DELAY_MS = 250;
const SAVED_LINGER_MS = 1600;

export function useAutosaveIndicator() {
  const [state, setState] = useState<AutosaveState>("idle");
  const saveIdRef = useRef(0);
  const savingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (savingTimerRef.current) {
      clearTimeout(savingTimerRef.current);
      savingTimerRef.current = null;
    }
    if (clearSavedTimerRef.current) {
      clearTimeout(clearSavedTimerRef.current);
      clearSavedTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const reset = useCallback(() => {
    saveIdRef.current += 1;
    clearTimers();
    setState("idle");
  }, [clearTimers]);

  const markDirty = useCallback(() => {
    clearTimers();
    setState("idle");
  }, [clearTimers]);

  const runSave = useCallback(async (save: () => Promise<void>) => {
    const saveId = saveIdRef.current + 1;
    saveIdRef.current = saveId;
    clearTimers();
    savingTimerRef.current = setTimeout(() => {
      if (saveIdRef.current === saveId) {
        setState("saving");
      }
    }, SAVING_DELAY_MS);

    try {
      await save();
      if (saveIdRef.current !== saveId) return;
      clearTimers();
      setState("saved");
      clearSavedTimerRef.current = setTimeout(() => {
        if (saveIdRef.current === saveId) {
          setState("idle");
        }
      }, SAVED_LINGER_MS);
    } catch (error) {
      if (saveIdRef.current !== saveId) throw error;
      clearTimers();
      setState("error");
      throw error;
    }
  }, [clearTimers]);

  return {
    state,
    markDirty,
    reset,
    runSave,
  };
}
