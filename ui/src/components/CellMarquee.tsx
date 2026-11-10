import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { cn } from "../lib/utils";

/** Row overlays keep navigation intact; the row reports the cell under the pointer. */
export const HoveredCellContext = createContext<string | null>(null);

/** Shared hit testing for row overlays and ordinary links. Only the cell under
 * the pointer reveals, even when its navigation target covers the whole row. */
export function useCellMarqueeHover() {
  const [hoveredCell, setHoveredCell] = useState<string | null>(null);
  const onMouseMove = (event: ReactMouseEvent<HTMLElement>) => {
    const cell = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-marquee-cell]")).find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && event.clientX >= rect.left && event.clientX < rect.right;
    });
    setHoveredCell(cell?.dataset.marqueeCell ?? null);
  };
  return { hoveredCell, onMouseMove, clearHoveredCell: () => setHoveredCell(null) };
}

export function CellMarquee({ children, cell, active = false, className, slot = "cell-marquee", contentSlot = "cell-marquee-content", tabbable = true, interactWithParent = false, resetKey }: {
  children: ReactNode;
  cell: string;
  active?: boolean;
  className?: string;
  slot?: string;
  contentSlot?: string;
  tabbable?: boolean;
  /** Labels inside links/buttons reuse that control's pointer and keyboard target. */
  interactWithParent?: boolean;
  /** Reset when a parent menu changes state, without replaying on restored focus. */
  resetKey?: string | number | boolean;
}) {
  const hoveredCell = useContext(HoveredCellContext);
  const viewportRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const previousResetKey = useRef(resetKey);
  const ignoreRestoredFocus = useRef(false);
  const [overflow, setOverflow] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [revealComplete, setRevealComplete] = useState(false);
  const [parentHovered, setParentHovered] = useState(false);
  const [parentFocused, setParentFocused] = useState(false);
  const hovered = hoveredCell === cell || parentHovered;
  const activated = hovered || ((active || focused || parentFocused) && (hoveredCell === null || hovered));
  const revealing = overflow > 0 && activated && !dismissed;

  useLayoutEffect(() => {
    if (previousResetKey.current === resetKey) return;
    previousResetKey.current = resetKey;
    const owner = viewportRef.current?.closest<HTMLElement>('a, button, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]');
    // Menus restore focus to their trigger on dismissal. That is not a new
    // request to reveal its label; resume on pointer interaction or a new focus.
    ignoreRestoredFocus.current = true;
    setParentHovered(owner?.matches(":hover") ?? false);
    setFocused(false);
    setParentFocused(false);
  }, [resetKey]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const measure = () => {
      const width = viewport.getBoundingClientRect().width;
      // scrollWidth/clientWidth round to whole pixels even when text-overflow
      // has already clipped a fractional glyph. Measure the contents precisely.
      const range = content.ownerDocument.createRange();
      range.selectNodeContents(content);
      setOverflow(width > 0 ? Math.max(0, range.getBoundingClientRect().width - width) : 0);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    observer?.observe(content);
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      observer?.disconnect();
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [children, className]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!interactWithParent || !viewport) return;
    const control = viewport.closest<HTMLElement>('a, button, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]');
    const owner = control ?? viewport.closest<HTMLElement>("[data-marquee-surface]") ?? viewport;
    const move = (event: MouseEvent) => {
      ignoreRestoredFocus.current = false;
      if (control) { setParentHovered(true); return; }
      const rect = viewport.getBoundingClientRect();
      setParentHovered(event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom);
    };
    const leave = () => setParentHovered(false);
    const focus = () => { if (!ignoreRestoredFocus.current) setParentFocused(true); };
    const blur = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node && owner.contains(event.relatedTarget))) {
        ignoreRestoredFocus.current = false;
        setParentFocused(false);
      }
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setDismissed(true); };
    owner.addEventListener("mouseenter", move);
    owner.addEventListener("mousemove", move);
    owner.addEventListener("mouseleave", leave);
    owner.addEventListener("focus", focus, true);
    owner.addEventListener("blur", blur, true);
    owner.addEventListener("keydown", key);
    return () => {
      owner.removeEventListener("mouseenter", move);
      owner.removeEventListener("mousemove", move);
      owner.removeEventListener("mouseleave", leave);
      owner.removeEventListener("focus", focus, true);
      owner.removeEventListener("blur", blur, true);
      owner.removeEventListener("keydown", key);
    };
  }, [interactWithParent]);
  useEffect(() => setDismissed(false), [hovered, active, focused, parentFocused]);
  useEffect(() => setRevealComplete(false), [revealing, overflow]);

  return (
    <span
      ref={viewportRef}
      data-slot={slot}
      data-cell-marquee
      data-truncated={overflow > 0 ? "true" : undefined}
      data-revealing={revealing ? "true" : undefined}
      data-reveal-complete={revealing && revealComplete ? "true" : undefined}
      className={cn("cell-marquee", className)}
      style={{ "--cell-marquee-overflow": overflow } as CSSProperties}
      tabIndex={tabbable && overflow > 0 ? 0 : undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={event => { if (event.key === "Escape") setDismissed(true); }}
    >
      <span className="cell-marquee-viewport">
        <span
          ref={contentRef}
          data-slot={contentSlot}
          className="cell-marquee-content"
          onTransitionRun={() => setRevealComplete(false)}
          onTransitionEnd={event => { if (event.propertyName === "transform") setRevealComplete(true); }}
          onTransitionCancel={() => setRevealComplete(false)}
        >{children}</span>
      </span>
    </span>
  );
}
