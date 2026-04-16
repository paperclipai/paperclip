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

interface ToastActionsContextValue {
  pushToast: (input: ToastInput) => string | null;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

interface ToastContextValue extends ToastActionsContextValue {
  toasts: ToastItem[];
}

const DEFAULT_TTL_BY_TONE: Record<ToastTone, number> = {
  info: 4000,
  success: 3500,
  warn: 8000,
  error: 10000,
};
const MIN_TTL_MS = 1500;
const MAX_TTL_MS = 15000;
const MAX_TOASTS = 5;
const DEDUPE_WINDOW_MS = 3500;
const DEDUPE_MAX_AGE_MS = 20000;

const ToastStateContext = createContext<ToastItem[] | null>(null);
const ToastActionsContext = createContext<ToastActionsContextValue | null>(null);

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
  const dedupeRef = useRef(new Map<string, number>());

  const clearTimer = useCallback((id: string) => {
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timersRef.current.delete(id);
    }
  }, []);

  const dismissToast = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    },
    [clearTimer],
  );

  const clearToasts = useCallback(() => {
    for (const handle of timersRef.current.values()) {
      window.clearTimeout(handle);
    }
    timersRef.current.clear();
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

      const timeout = window.setTimeout(() => {
        dismissToast(id);
      }, ttlMs);
      timersRef.current.set(id, timeout);
      return id;
    },
    [clearTimer, dismissToast],
  );

  useEffect(() => () => {
    for (const handle of timersRef.current.values()) {
      window.clearTimeout(handle);
    }
    timersRef.current.clear();
  }, []);

  const actions = useMemo<ToastActionsContextValue>(
    () => ({
      pushToast,
      dismissToast,
      clearToasts,
    }),
    [pushToast, dismissToast, clearToasts],
  );

  return (
    <ToastActionsContext.Provider value={actions}>
      <ToastStateContext.Provider value={toasts}>{children}</ToastStateContext.Provider>
    </ToastActionsContext.Provider>
  );
}

export function useToastState() {
  const context = useContext(ToastStateContext);
  if (!context) {
    throw new Error("useToastState must be used within a ToastProvider");
  }
  return context;
}

export function useToastActions() {
  const context = useContext(ToastActionsContext);
  if (!context) {
    throw new Error("useToastActions must be used within a ToastProvider");
  }
  return context;
}

export function useToast() {
  const toasts = useToastState();
  const actions = useToastActions();
  return useMemo<ToastContextValue>(() => ({ toasts, ...actions }), [toasts, actions]);
}
