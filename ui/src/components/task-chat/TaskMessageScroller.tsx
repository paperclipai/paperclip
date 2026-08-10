import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp } from "lucide-react";

const PIN_THRESHOLD_PX = 48;

/** Visibility lifecycle of the scroll-to-latest pill. */
type PillPhase = "hidden" | "in" | "out";

/**
 * True when animations are disabled (prefers-reduced-motion, or environments
 * without matchMedia such as jsdom). In that case the pill's exit animation
 * never fires animationend, so we must unmount immediately.
 */
function motionDisabled(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface TaskMessageScrollerProps {
  children: ReactNode;
  /** Value that changes whenever content that could grow the thread updates. */
  contentKey: unknown;
  className?: string;
  /**
   * Newest-first ordering: newest content sits at the TOP, so the auto-follow
   * edge flips — pin to the top, follow/glide to top, and the pill ("Scroll to
   * newest") rides the top. Default false keeps the bottom-pinned behavior.
   */
  newestFirst?: boolean;
}

/**
 * Scroll container that owns the redesign's auto-follow vs. hold-position rule.
 *
 * Explicit rule: while the viewport is pinned to the bottom (within a small
 * threshold) new content auto-follows with INSTANT scroll; the moment the user
 * scrolls up we hold their position and surface a scroll-to-latest pill
 * instead of yanking them down.
 *
 * Re-follow is easing-aware: clicking the pill glides down smoothly, and while
 * that glide is in flight (`easingRef`) the scroll handler must not unpin —
 * the smooth scroll fires intermediate scroll events that would otherwise
 * re-show the pill mid-glide (the known stick-to-bottom failure mode). Arrival
 * within the pin threshold re-pins and hides the pill; a wheel/touch during
 * the glide cancels it and treats the user as unpinned. Content-driven follow
 * while pinned stays instant, so no reflow/jump happens during streaming.
 */
export function TaskMessageScroller({ children, contentKey, className, newestFirst = false }: TaskMessageScrollerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const easingRef = useRef(false);
  const [pillPhase, setPillPhase] = useState<PillPhase>("hidden");

  const showPill = useCallback(() => {
    setPillPhase("in");
  }, []);

  const hidePill = useCallback(() => {
    // Keep rendering through the exit animation; unmount on animationend.
    // Without animations (reduced motion / no matchMedia) unmount immediately.
    setPillPhase((phase) => (phase === "hidden" ? phase : motionDisabled() ? "hidden" : "out"));
  }, []);

  const isPinned = useCallback(() => {
    const el = ref.current;
    if (!el) return true;
    // Pinned edge flips with the order: top when newest-first, else bottom.
    return newestFirst
      ? el.scrollTop <= PIN_THRESHOLD_PX
      : el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX;
  }, [newestFirst]);

  const scrollToPinnedEdge = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = newestFirst ? 0 : el.scrollHeight; // instant, never smooth
  }, [newestFirst]);

  const handleScroll = useCallback(() => {
    const pinned = isPinned();
    if (easingRef.current) {
      // Smooth re-follow in flight: intermediate scroll events must not
      // unpin/re-show the pill. Only act once we arrive within the threshold.
      if (pinned) {
        easingRef.current = false;
        pinnedRef.current = true;
        hidePill();
      }
      return;
    }
    pinnedRef.current = pinned;
    if (pinned) hidePill();
    else showPill();
  }, [isPinned, hidePill, showPill]);

  const handleJumpToLatest = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (isPinned()) {
      // Already at (or within threshold of) the bottom: no glide needed.
      pinnedRef.current = true;
      hidePill();
      return;
    }
    easingRef.current = true;
    const top = newestFirst ? 0 : el.scrollHeight;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top, behavior: "smooth" });
    } else {
      // Environments without scrollTo (older jsdom): fall back to instant.
      el.scrollTop = top;
      easingRef.current = false;
      pinnedRef.current = true;
      hidePill();
    }
  }, [isPinned, hidePill, newestFirst]);

  // A user gesture during the smooth glide cancels the re-follow: stop
  // treating scroll events as easing and consider the user unpinned.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cancelEasing = () => {
      if (!easingRef.current) return;
      easingRef.current = false;
      pinnedRef.current = false;
      showPill();
    };
    el.addEventListener("wheel", cancelEasing, { passive: true });
    el.addEventListener("touchstart", cancelEasing, { passive: true });
    return () => {
      el.removeEventListener("wheel", cancelEasing);
      el.removeEventListener("touchstart", cancelEasing);
    };
  }, [showPill]);

  // Follow new content only when already pinned; otherwise hold position.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToPinnedEdge();
  }, [contentKey, scrollToPinnedEdge]);

  // Initial follow, and re-pin to the newest edge whenever the order flips
  // (scrollToPinnedEdge's identity changes with `newestFirst`).
  useEffect(() => {
    pinnedRef.current = true;
    scrollToPinnedEdge();
  }, [scrollToPinnedEdge]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={handleScroll}
        // absolute inset-0 (not h-full): the viewport must equal the flex-sized
        // wrapper exactly — percentage heights don't reliably resolve against
        // flex-determined block heights, which let the thread overflow the page.
        className={cn("absolute inset-0 overflow-y-auto", className)}
        data-testid="task-chat-scroller"
      >
        {children}
      </div>
      {pillPhase !== "hidden" ? (
        <button
          type="button"
          aria-label={newestFirst ? "Scroll to newest" : "Scroll to latest"}
          onClick={handleJumpToLatest}
          onAnimationEnd={() => {
            if (pillPhase === "out") setPillPhase("hidden");
          }}
          // The tc-scroll-pill-* keyframes carry the translate(-50%) X-centering
          // (fill: both keeps it after the animation) — no -translate-x-1/2 here.
          // Newest-first rides the top edge (newest is at the top); else bottom.
          className={cn(
            "absolute left-1/2 flex size-8 items-center justify-center rounded-full border border-border bg-background shadow-sm hover:bg-muted",
            newestFirst ? "top-3" : "bottom-3",
            pillPhase === "out" ? "tc-scroll-pill-out" : "tc-scroll-pill-in",
          )}
        >
          {newestFirst ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
        </button>
      ) : null}
    </div>
  );
}
