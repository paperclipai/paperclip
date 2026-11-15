import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { usePaneWidthReset } from "@/hooks/usePaneWidthReset";

function readWidth(storageKey: string): number | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    const value = stored === null ? NaN : Number(stored);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Geometry and resize behavior for the proposed shell's contextual pane. */
export function DesignPageAside({ children, title, maximized, storageKey }: {
  children: ReactNode;
  title: string;
  maximized: boolean;
  storageKey: string;
}) {
  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number | null>(() => readWidth(storageKey));
  const [bounds, setBounds] = useState({ min: 0, max: 0, step: 0 });
  const [actualWidth, setActualWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const { resetting, startReset, cancelReset, onResetTransitionEnd } = usePaneWidthReset();
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(width);

  const persistWidth = useCallback((next: number | null) => {
    try {
      if (next === null) window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, String(next));
    } catch {
      // Resizing still works when browser storage is unavailable.
    }
  }, [storageKey]);

  useLayoutEffect(() => {
    cancelReset();
    const stored = readWidth(storageKey);
    widthRef.current = stored;
    setWidth(stored);
  }, [storageKey, cancelReset]);

  useLayoutEffect(() => { cancelReset(); }, [maximized, cancelReset]);

  useLayoutEffect(() => {
    const aside = asideRef.current;
    const shell = aside?.parentElement;
    const sidebar = shell?.querySelector<HTMLElement>(":scope > .design-page-navigation");
    if (!aside || !shell || !sidebar) return;
    const measure = () => {
      const style = getComputedStyle(aside);
      const min = parseFloat(style.getPropertyValue("--design-page-aside-min-width"));
      const mainMin = parseFloat(style.getPropertyValue("--design-page-main-min-width"));
      const step = parseFloat(style.getPropertyValue("--design-page-aside-resize-step"));
      const max = Math.max(min, shell.clientWidth - sidebar.getBoundingClientRect().width - mainMin);
      setBounds(previous => previous.min === min && previous.max === max && previous.step === step ? previous : { min, max, step });
      setActualWidth(Math.round(aside.getBoundingClientRect().width));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    observer.observe(sidebar);
    observer.observe(aside);
    return () => observer.disconnect();
  }, []);

  const clamp = (next: number) => Math.round(Math.min(bounds.max, Math.max(bounds.min, next)));
  const updateWidth = (next: number | null) => {
    widthRef.current = next;
    setWidth(next);
  };
  const finishResize = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    persistWidth(widthRef.current);
  };
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startWidth = asideRef.current!.getBoundingClientRect().width;
    cancelReset();
    if (resetting) updateWidth(startWidth);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth };
    setDragging(true);
  };
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    updateWidth(clamp(drag.startWidth + drag.startX - event.clientX));
  };
  const resetWidth = () => {
    startReset();
    updateWidth(null);
    persistWidth(null);
  };
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    // Read the current geometry so consecutive key presses do not wait for ResizeObserver.
    const currentWidth = asideRef.current!.getBoundingClientRect().width;
    const next = event.key === "ArrowLeft" ? currentWidth + bounds.step
      : event.key === "ArrowRight" ? currentWidth - bounds.step
      : event.key === "Home" ? bounds.min
      : event.key === "End" ? bounds.max : null;
    if (next === null) return;
    event.preventDefault();
    cancelReset();
    const clamped = clamp(next);
    updateWidth(clamped);
    persistWidth(clamped);
  };

  return <aside ref={asideRef} className="design-page-aside" aria-label={title}
    data-width-resetting={resetting && !maximized && !dragging || undefined} onTransitionEnd={onResetTransitionEnd} style={{
    "--design-page-aside-user-width": width === null ? undefined : `${width}px`,
    "--design-page-aside-available-width": bounds.max ? `${bounds.max}px` : undefined,
  } as CSSProperties}>
    {!maximized && <div
      role="separator" aria-label="Resize right sidebar" aria-orientation="vertical"
      aria-controls="design-page-aside-content" aria-valuemin={bounds.min} aria-valuemax={bounds.max} aria-valuenow={actualWidth}
      tabIndex={0} data-dragging={dragging ? "" : undefined}
      className="pane-resize-handle design-page-aside-resize group absolute inset-y-0 z-20 cursor-col-resize touch-none outline-none"
      onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={finishResize}
      onPointerCancel={finishResize} onLostPointerCapture={finishResize}
      onDoubleClick={resetWidth} onKeyDown={resizeWithKeyboard}
    >
      <div className={`mx-auto h-full w-0.5 transition-colors ${dragging ? "bg-ring" : "bg-transparent group-hover:bg-ring group-focus-visible:bg-ring"}`} />
    </div>}
    {children}
  </aside>;
}
