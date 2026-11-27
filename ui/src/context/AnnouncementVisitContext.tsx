import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const IDLE_MS = 30 * 60_000;
const ReturningUser = createContext<string | null>(null);

export function useReturningAnnouncementUser(userId: string | null) {
  const returningUser = useContext(ReturningUser);
  return userId !== null && userId === returningUser;
}

export function AnnouncementVisitProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const [returningUser, setReturningUser] = useState<string | null>(null);
  useEffect(() => {
    setReturningUser(null);
    if (!userId) return;
    const key = `paperclip.board-visit.v1:${encodeURIComponent(userId)}`;
    const returnedKey = `${key}:returned`;
    const listeners = new AbortController();
    const options = { capture: true, passive: true, signal: listeners.signal };
    let lastActivity = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;

    function finish() {
      clearTimeout(pending);
      pending = undefined;
      listeners.abort();
      setReturningUser(userId);
    }

    function saveActivity() {
      clearTimeout(pending);
      pending = undefined;
      try {
        const saved = Number(localStorage.getItem(key)) || 0;
        if (lastActivity > saved) localStorage.setItem(key, String(lastActivity));
      } catch { return; }
    }

    function activity() {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (!lastActivity || now - lastActivity >= IDLE_MS) {
        try {
          if (localStorage.getItem(returnedKey) === "1") {
            finish();
            return;
          }
          const previous = Math.max(lastActivity, Number(localStorage.getItem(key)) || 0);
          if (previous > 0 && now - previous >= IDLE_MS) {
            localStorage.setItem(returnedKey, "1");
            finish();
            return;
          }
          lastActivity = now;
          saveActivity();
        } catch { return; }
        return;
      }
      lastActivity = now;
      pending ??= setTimeout(saveActivity, 1000);
    }

    function visibility() {
      if (document.visibilityState === "hidden") saveActivity();
      else activity();
    }

    for (const event of ["keydown", "pointerdown", "pointermove", "wheel", "input", "pageshow"]) {
      window.addEventListener(event, activity, options);
    }
    window.addEventListener("focus", activity, { signal: listeners.signal });
    window.addEventListener("pagehide", saveActivity, options);
    document.addEventListener("visibilitychange", visibility, options);
    window.addEventListener("storage", (event) => {
      if (event.key === returnedKey && event.newValue === "1") finish();
    }, options);
    activity();
    return () => {
      if (pending !== undefined) saveActivity();
      listeners.abort();
    };
  }, [userId]);

  return <ReturningUser.Provider value={returningUser === userId ? userId : null}>{children}</ReturningUser.Provider>;
}
