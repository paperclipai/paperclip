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

/** Visual severity of a toast notification. Controls color and default TTL. */
export type ToastTone = "info" | "success" | "warn" | "error";

/** Optional call-to-action link rendered inside a toast. */
export interface ToastAction {
  /** Human-readable label for the link. */
  label: string;
  /** URL the link navigates to when clicked. */
  href: string;
}

/**
 * Input shape accepted by {@link ToastContextValue.pushToast}.
 *
 * Only `title` is required. All other fields have sensible defaults.
 */
export interface ToastInput {
  /**
   * Stable identifier for this toast. When provided, a second call with the
   * same `id` replaces the existing toast rather than creating a new one.
   * Also used as the dedupe key if `dedupeKey` is not set.
   */
  id?: string;
  /**
   * Explicit dedupe key. Two toasts with the same `dedupeKey` emitted within
   * {@link DEDUPE_WINDOW_MS} milliseconds will be collapsed into one.
   *
   * Defaults to `id` if provided, otherwise built from
   * `"${tone}|${title}|${body}|${action.href}"`.
   */
  dedupeKey?: string;
  /** Primary text shown in the toast (required). */
  title: string;
  /** Optional secondary text below the title. */
  body?: string;
  /**
   * Visual severity. Determines default TTL and accent color.
   * @default "info"
   */
  tone?: ToastTone;
  /**
   * How long the toast is visible in milliseconds.
   * Clamped to [{@link MIN_TTL_MS}, {@link MAX_TTL_MS}].
   * Defaults to {@link DEFAULT_TTL_BY_TONE}[tone].
   */
  ttlMs?: number;
  /** Optional call-to-action link. */
  action?: ToastAction;
}

/**
 * A fully resolved toast item stored in React state.
 *
 * Fields mirror {@link ToastInput} but all optional properties are
 * normalised to their resolved values.
 */
export interface ToastItem {
  /** Unique identifier, used to dismiss or replace the toast. */
  id: string;
  /** Primary text. */
  title: string;
  /** Optional secondary text. */
  body?: string;
  /** Resolved severity tone. */
  tone: ToastTone;
  /** Resolved TTL in milliseconds (clamped, finite). */
  ttlMs: number;
  /** Optional call-to-action link. */
  action?: ToastAction;
  /** Unix timestamp (ms) when the toast was added to state. */
  createdAt: number;
}

/** Value exposed by {@link ToastContext} and returned by {@link useToast}. */
interface ToastContextValue {
  /** Current list of active toasts, newest first. */
  toasts: ToastItem[];
  /**
   * Adds a new toast or replaces an existing one with the same `id`.
   *
   * Duplicate toasts (same dedupe key within {@link DEDUPE_WINDOW_MS}) are
   * silently dropped. When the toast stack reaches {@link MAX_TOASTS} the
   * oldest entry is evicted.
   *
   * @returns The toast `id` on success, or `null` when the toast was deduped.
   */
  pushToast: (input: ToastInput) => string | null;
  /** Immediately removes a toast by its `id` and cancels its auto-dismiss timer. */
  dismissToast: (id: string) => void;
  /** Removes all active toasts and cancels all pending timers. */
  clearToasts: () => void;
}

/**
 * Default auto-dismiss duration for each tone (milliseconds).
 *
 * Error toasts linger longest to ensure the user has time to read them.
 * Success toasts dismiss quickly since they confirm an already-visible action.
 */
const DEFAULT_TTL_BY_TONE: Record<ToastTone, number> = {
  info: 4000,
  success: 3500,
  warn: 8000,
  error: 10000,
};

/** Minimum allowed TTL (ms). Prevents toasts that flash too briefly to read. */
const MIN_TTL_MS = 1500;
/** Maximum allowed TTL (ms). Prevents toasts that block the UI indefinitely. */
const MAX_TTL_MS = 15000;
/** Maximum number of toasts visible simultaneously. Oldest is evicted when exceeded. */
const MAX_TOASTS = 5;
/**
 * Deduplication window (ms). A second toast with the same dedupe key emitted
 * within this window is silently dropped.
 */
const DEDUPE_WINDOW_MS = 3500;
/**
 * Maximum age (ms) for a dedupe record. Entries older than this are purged
 * from the in-memory map to prevent unbounded growth.
 */
const DEDUPE_MAX_AGE_MS = 20000;

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Clamps a caller-supplied TTL to the valid range and falls back to the tone
 * default when the value is absent or non-finite.
 *
 * @param value - Caller-supplied TTL in milliseconds (may be `undefined`).
 * @param tone  - Tone used to look up the fallback default.
 * @returns A finite integer TTL within [{@link MIN_TTL_MS}, {@link MAX_TTL_MS}].
 */
function normalizeTtl(value: number | undefined, tone: ToastTone) {
  const fallback = DEFAULT_TTL_BY_TONE[tone];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(value)));
}

/**
 * Generates a unique toast ID.
 *
 * Combines the current timestamp with a short random suffix to avoid
 * collisions even when multiple toasts are pushed in the same tick.
 */
function generateToastId() {
  return `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Provides toast notification state and controls to the component tree.
 *
 * Mount this once near the root of the application (wrapping the router or
 * layout). Combine with {@link ToastViewport} to render the toast stack.
 *
 * @example
 * ```tsx
 * // main.tsx
 * <ToastProvider>
 *   <App />
 *   <ToastViewport />
 * </ToastProvider>
 * ```
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  /** Map of toast ID → window.setTimeout handle, for cleanup on dismiss. */
  const timersRef = useRef(new Map<string, number>());
  /** Map of dedupe key → timestamp of last seen push. */
  const dedupeRef = useRef(new Map<string, number>());

  /** Cancels and removes the auto-dismiss timer for a given toast ID. */
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

      // Build dedupe key: explicit key > id > auto-constructed from content
      const dedupeKey =
        input.dedupeKey ?? input.id ?? `${tone}|${input.title}|${input.body ?? ""}|${input.action?.href ?? ""}`;

      // Evict stale dedupe records to prevent unbounded growth
      for (const [key, ts] of dedupeRef.current.entries()) {
        if (now - ts > DEDUPE_MAX_AGE_MS) {
          dedupeRef.current.delete(key);
        }
      }

      // Suppress duplicate pushes within the dedup window
      const lastSeen = dedupeRef.current.get(dedupeKey);
      if (lastSeen && now - lastSeen < DEDUPE_WINDOW_MS) {
        return null;
      }
      dedupeRef.current.set(dedupeKey, now);

      const id = input.id ?? generateToastId();
      // Reset the timer if a toast with the same id is being replaced
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

        // Remove any existing toast with the same id, then prepend the new one.
        // Slice to MAX_TOASTS evicts the oldest entry from the tail.
        const withoutCurrent = prev.filter((toast) => toast.id !== id);
        return [nextToast, ...withoutCurrent].slice(0, MAX_TOASTS);
      });

      // Schedule auto-dismiss after the resolved TTL
      const timeout = window.setTimeout(() => {
        dismissToast(id);
      }, ttlMs);
      timersRef.current.set(id, timeout);
      return id;
    },
    [clearTimer, dismissToast],
  );

  // Clean up all timers when the provider unmounts (e.g. during HMR or tests)
  useEffect(() => () => {
    for (const handle of timersRef.current.values()) {
      window.clearTimeout(handle);
    }
    timersRef.current.clear();
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      toasts,
      pushToast,
      dismissToast,
      clearToasts,
    }),
    [toasts, pushToast, dismissToast, clearToasts],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

/**
 * Returns the toast context value for the nearest {@link ToastProvider}.
 *
 * Must be called inside a component that is a descendant of `ToastProvider`.
 * Throws if no provider is found, which is always a programming error.
 *
 * @example
 * ```tsx
 * function SaveButton() {
 *   const { pushToast } = useToast();
 *   return (
 *     <button onClick={() => pushToast({ title: "Saved", tone: "success" })}>
 *       Save
 *     </button>
 *   );
 * }
 * ```
 */
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
