import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { type NotificationCueType, playCue } from "../lib/notificationSounds";

const STORAGE_KEY = "paperclip.notificationSounds";

export interface NotificationSoundsPrefs {
  notificationSoundsEnabled: boolean;
  attentionSoundsEnabled: boolean;
}

const DEFAULT_PREFS: NotificationSoundsPrefs = {
  notificationSoundsEnabled: true,
  attentionSoundsEnabled: true,
};

function loadPrefs(): NotificationSoundsPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<NotificationSoundsPrefs>;
    return {
      notificationSoundsEnabled: parsed.notificationSoundsEnabled ?? DEFAULT_PREFS.notificationSoundsEnabled,
      attentionSoundsEnabled: parsed.attentionSoundsEnabled ?? DEFAULT_PREFS.attentionSoundsEnabled,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: NotificationSoundsPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage errors
  }
}

export interface NotificationSoundsContextValue {
  prefs: NotificationSoundsPrefs;
  setPrefs: (update: Partial<NotificationSoundsPrefs>) => void;
  triggerCue: (type: NotificationCueType) => void;
}

const NotificationSoundsContext = createContext<NotificationSoundsContextValue>({
  prefs: DEFAULT_PREFS,
  setPrefs: () => undefined,
  triggerCue: () => undefined,
});

export function NotificationSoundsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsState] = useState<NotificationSoundsPrefs>(loadPrefs);

  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  const setPrefs = useCallback((update: Partial<NotificationSoundsPrefs>) => {
    setPrefsState((prev) => ({ ...prev, ...update }));
  }, []);

  const triggerCue = useCallback((type: NotificationCueType) => {
    if (type === "done" && !prefs.notificationSoundsEnabled) return;
    if (type === "attention" && !prefs.attentionSoundsEnabled) return;
    void playCue(type);
  }, [prefs.notificationSoundsEnabled, prefs.attentionSoundsEnabled]);

  const value = useMemo(
    () => ({ prefs, setPrefs, triggerCue }),
    [prefs, setPrefs, triggerCue],
  );

  return (
    <NotificationSoundsContext.Provider value={value}>
      {children}
    </NotificationSoundsContext.Provider>
  );
}

export function useNotificationSounds(): NotificationSoundsContextValue {
  return useContext(NotificationSoundsContext);
}
