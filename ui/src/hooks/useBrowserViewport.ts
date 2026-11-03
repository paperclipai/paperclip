import { t, useTranslation } from "@/i18n";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  BrowserUseViewportPreset,
  BrowserUseViewportRequest,
  BrowserUseViewportState,
} from "@paperclipai/shared";
import { browserUseApi } from "@/api/browser-use";

// Network scheduling, not animation timing. During a drag the existing frame scales.
const DEBOUNCE_MS = 250;
const LEASE_RENEW_MS = 8000;

/** Preserve aspect ratio even when an unusually large pane exceeds provider bounds. */
export function browserPaneSize(
  width: number,
  height: number,
  chromeHeight: number,
) {
  height -= chromeHeight;
  if (width < 1 || height < 1) return null;
  const scale = Math.min(1, 6144 / width, 3456 / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function useBrowserViewport({
  issueId,
  browserId,
  enabled,
  active,
  frameRef,
}: {
  issueId: string;
  browserId?: string;
  enabled: boolean;
  active: boolean;
  frameRef: RefObject<HTMLIFrameElement | null>;
}) {
  useTranslation();
  const [viewerId] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<BrowserUseViewportState>({
    preset: "fit",
  });
  const stateRef = useRef(state);
  const [error, setError] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);
  const version = useRef(0);
  // Includes release operations, so hiding/reopening cannot race an old resize.
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const select = useRef<(preset: BrowserUseViewportPreset) => void>(() => {});
  const synchronize = useRef<() => void>(() => {});
  const receive = useCallback(
    (next: BrowserUseViewportState, expectedVersion: number) => {
      if (expectedVersion !== version.current) return;
      stateRef.current = next;
      setState(next);
      synchronize.current();
    },
    [],
  );
  useEffect(() => {
    version.current++;
    stateRef.current = { preset: "fit" };
    setState(stateRef.current);
    setError(null);
  }, [browserId]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!enabled || !active || !browserId || !frame) return;
    let disposed = false;
    let paused = false;
    let pumping = false;
    let desiredMode = stateRef.current.preset;
    let pending: BrowserUseViewportRequest | null = null;
    let lastMeasured: { width: number; height: number } | null = null;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const visible = () =>
      !disposed &&
      document.visibilityState !== "hidden" &&
      frame.getClientRects().length > 0 &&
      (!frame.checkVisibility || frame.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    const measure = () => {
      const rect = frame.getBoundingClientRect();
      const chrome =
        parseFloat(
          getComputedStyle(frame).getPropertyValue(
            "--browser-use-viewer-chrome-height",
          ),
        ) || 0;
      return visible()
        ? browserPaneSize(rect.width, rect.height, chrome)
        : null;
    };
    const release = () => {
      tail.current = tail.current
        .catch(() => {})
        .then(() => browserUseApi.releaseViewport(issueId, browserId, viewerId))
        .catch(() => {});
    };
    const pump = () => {
      if (pumping || !pending || !visible()) return;
      pumping = true;
      tail.current = tail.current
        .catch(() => {})
        .then(async () => {
          while (pending && visible()) {
            const request = pending;
            pending = null;
            const revision = version.current;
            const automatic = request.preset === "fit" && !request.takeControl;
            if (!automatic) setResizing(true);
            try {
              const result = await browserUseApi.resize(
                issueId,
                browserId,
                request,
              );
              if (disposed || revision !== version.current) continue;
              stateRef.current = result;
              desiredMode = result.preset;
              setState(result);
              setError(null);
            } catch {
              if (!disposed && revision === version.current) {
                paused = true;
                desiredMode = stateRef.current.preset;
                pending = null;
                setError(
                  "oct5Core.viewportError",
                );
              }
            } finally {
              if (revision === version.current) version.current++;
              if (!disposed) setResizing(false);
            }
          }
        })
        .finally(() => {
          pumping = false;
          if (!disposed && pending) pump();
        });
    };
    const enqueue = (request: BrowserUseViewportRequest) => {
      if (
        request.preset === "fit" &&
        pending?.preset === "fit" &&
        pending.takeControl
      )
        request = { ...request, takeControl: true };
      pending = request;
      version.current++;
      pump();
    };
    const fit = (takeControl = false) => {
      const size = measure();
      if (!size || (!takeControl && (paused || desiredMode !== "fit"))) return;
      enqueue({
        preset: "fit",
        ...size,
        viewerId,
        ...(takeControl ? { takeControl: true } : {}),
      });
    };
    const resized = () => {
      const size = measure();
      if (!size) {
        clearTimeout(debounce);
        pending = null;
        lastMeasured = null;
        release();
        return;
      }
      if (
        lastMeasured &&
        Math.abs(size.width - lastMeasured.width) < 2 &&
        Math.abs(size.height - lastMeasured.height) < 2
      )
        return;
      lastMeasured = size;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = undefined;
        fit();
      }, DEBOUNCE_MS);
    };
    select.current = (preset) => {
      clearTimeout(debounce);
      debounce = undefined;
      pending = null;
      paused = false;
      desiredMode = preset;
      setError(null);
      if (preset === "fit") fit(true);
      else enqueue({ preset, viewerId });
    };
    synchronize.current = () => {
      desiredMode = stateRef.current.preset;
      // A released/expired lease is picked up by the next renewal. Never take over implicitly.
    };
    const visibility = () => {
      clearTimeout(debounce);
      pending = null;
      version.current++;
      if (visible()) {
        lastMeasured = null;
        resized();
      } else release();
    };
    const observer = new ResizeObserver(resized);
    observer.observe(frame);
    document.addEventListener("visibilitychange", visibility);
    // Pagehide also releases ownership when the document leaves the foreground permanently.
    const pagehide = () => {
      clearTimeout(debounce);
      pending = null;
      release();
    };
    window.addEventListener("pagehide", pagehide);
    const renewal = setInterval(() => {
      if (!debounce) fit();
    }, LEASE_RENEW_MS);
    resized();
    return () => {
      disposed = true;
      version.current++;
      pending = null;
      clearTimeout(debounce);
      clearInterval(renewal);
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
      select.current = () => {};
      synchronize.current = () => {};
      setResizing(false);
      release();
    };
  }, [issueId, browserId, enabled, active, frameRef, viewerId]);

  return {
    state,
    error: error ? t(error) : null,
    resizing,
    viewerId,
    version,
    receive,
    select: useCallback(
      (preset: BrowserUseViewportPreset) => select.current(preset),
      [],
    ),
  };
}
