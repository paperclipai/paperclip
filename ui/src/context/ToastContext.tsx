import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "info" | "success" | "warn" | "error";

export interface ToastAction {
  label: string;
  href: string;
}

export interface ToastInput {
  id?: string;
  dedupeKey?: string;
  title: string;
  body?: string;
  tone?: ToastTone;
  ttlMs?: number;
  action?: ToastAction;
}

export interface ToastItem {
  id: string;
  title: string;
  body?: string;
  tone: ToastTone;
  ttlMs: number;
  action?: ToastAction;
  createdAt: number;
}

interface ToastContextValue {
  toasts: ToastItem[];
  pushToast: (input: ToastInput) => string | null;
  dismissToast: (id: string) => void;
  pauseToast: (id: string) => void;
  resumeToast: (id: string) => void;
  clearToasts: () => void;
}

const DEFAULT_TTL_BY_TONE: Record<ToastTone, number> = {
  info: 6000,
  success: 5500,
  warn: 10000,
  error: 12000,
};
const MIN_TTL_MS = 1500;
const MAX_TTL_MS = 15000;
const MAX_TOASTS = 5;
const DEDUPE_WINDOW_MS = 3500;
const DEDUPE_MAX_AGE_MS = 20000;

const ToastContext = createContext<ToastContextValue | null>(null);

function normalizeTtl(value: number | undefined, tone: ToastTone) {
  const fallback = DEFAULT_TTL_BY_TONE[tone];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(value)));
}

function generateToastId() {
  return `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef(new Map<string, number>());
  const timerStartedAtRef = useRef(new Map<string, number>());
  const remainingMsRef = useRef(new Map<string, number>());
  const dedupeRef = useRef(new Map<string, number>());

  const clearTimer = useCallback((id: string) => {
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timersRef.current.delete(id);
    }
    timerStartedAtRef.current.delete(id);
  }, []);

  const getRemainingMs = useCallback((id: string) => {
    const remainingMs = remainingMsRef.current.get(id);
    if (remainingMs === undefined) return 0;

    const startedAt = timerStartedAtRef.current.get(id);
    if (startedAt === undefined) {
      return remainingMs;
    }

    return Math.max(0, remainingMs - (Date.now() - startedAt));
  }, []);

  const dismissToast = useCallback(
    (id: string) => {
      clearTimer(id);
      remainingMsRef.current.delete(id);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    },
    [clearTimer],
  );

  const startTimer = useCallback((id: string, delayMs: number) => {
    const normalizedDelayMs = Math.max(0, Math.floor(delayMs));
    clearTimer(id);

    if (normalizedDelayMs === 0) {
      dismissToast(id);
      return;
    }

    remainingMsRef.current.set(id, normalizedDelayMs);
    timerStartedAtRef.current.set(id, Date.now());

    const timeout = window.setTimeout(() => {
      dismissToast(id);
    }, normalizedDelayMs);
    timersRef.current.set(id, timeout);
  }, [clearTimer, dismissToast]);

  const pauseToast = useCallback((id: string) => {
    if (!timersRef.current.has(id)) return;
    const remainingMs = getRemainingMs(id);
    clearTimer(id);
    remainingMsRef.current.set(id, remainingMs);
  }, [clearTimer, getRemainingMs]);

  const resumeToast = useCallback((id: string) => {
    if (timersRef.current.has(id)) return;
    const remainingMs = remainingMsRef.current.get(id);
    if (remainingMs === undefined) return;
    startTimer(id, remainingMs);
  }, [startTimer]);

  const clearToasts = useCallback(() => {
    for (const handle of timersRef.current.values()) {
      window.clearTimeout(handle);
    }
    timersRef.current.clear();
    timerStartedAtRef.current.clear();
    remainingMsRef.current.clear();
    setToasts([]);
  }, []);

  const pushToast = useCallback(
    (input: ToastInput) => {
      const now = Date.now();
      const tone = input.tone ?? "info";
      const ttlMs = normalizeTtl(input.ttlMs, tone);
      const dedupeKey =
        input.dedupeKey ?? input.id ?? `${tone}|${input.title}|${input.body ?? ""}|${input.action?.href ?? ""}`;

      for (const [key, ts] of dedupeRef.current.entries()) {
        if (now - ts > DEDUPE_MAX_AGE_MS) {
          dedupeRef.current.delete(key);
        }
      }

      const lastSeen = dedupeRef.current.get(dedupeKey);
      if (lastSeen && now - lastSeen < DEDUPE_WINDOW_MS) {
        return null;
      }
      dedupeRef.current.set(dedupeKey, now);

      const id = input.id ?? generateToastId();
      clearTimer(id);

      setToasts((prev) => {
        const nextToast: ToastItem = {
          id,
          title: input.title,
          body: input.body,
          tone,
          ttlMs,
          action: input.action,
          createdAt: now,
        };

        const withoutCurrent = prev.filter((toast) => toast.id !== id);
        return [nextToast, ...withoutCurrent].slice(0, MAX_TOASTS);
      });

      startTimer(id, ttlMs);
      return id;
    },
    [clearTimer, startTimer],
  );

  useEffect(() => {
    const activeToastIds = new Set(toasts.map((toast) => toast.id));

    for (const id of Array.from(timersRef.current.keys())) {
      if (!activeToastIds.has(id)) {
        clearTimer(id);
      }
    }

    for (const id of Array.from(remainingMsRef.current.keys())) {
      if (!activeToastIds.has(id)) {
        remainingMsRef.current.delete(id);
      }
    }
  }, [toasts, clearTimer]);

  useEffect(() => () => {
    for (const handle of timersRef.current.values()) {
      window.clearTimeout(handle);
    }
    timersRef.current.clear();
    timerStartedAtRef.current.clear();
    remainingMsRef.current.clear();
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      toasts,
      pushToast,
      dismissToast,
      pauseToast,
      resumeToast,
      clearToasts,
    }),
    [toasts, pushToast, dismissToast, pauseToast, resumeToast, clearToasts],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
