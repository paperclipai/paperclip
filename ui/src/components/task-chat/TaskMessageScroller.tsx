import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { readThreadScrollAnchor, threadScrollAnchorDelta, type ThreadScrollAnchor } from "./scroll-anchor";
import { cn } from "@/lib/utils";
import { useStreamlinedTaskChatPresentation } from "./presentation-mode";
import { ArrowDown } from "lucide-react";
import { parseCssTimeMs } from "./motion-tokens";
import { useTaskChatScrollNavigation } from "./scroll-navigation";

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
export function TaskMessageScroller({ children, contentKey, className }: TaskMessageScrollerProps) {
  const streamlined = useStreamlinedTaskChatPresentation();
  const navigation = useTaskChatScrollNavigation();
  const initialPositionApplied = useRef(false);
  const appliedNavigation = useRef({ key: navigation.key, hash: navigation.hash });
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<ThreadScrollAnchor | null>(null);
  const pinnedRef = useRef(true);
  const easingRef = useRef(false);
  const clientHeightRef = useRef<number | null>(null);
  const scrollbarIdleTimerRef = useRef<number | null>(null);
  const scrollbarIdleDelayRef = useRef<number | null>(null);
  const [pillPhase, setPillPhase] = useState<PillPhase>("hidden");

  const showScrollbarWhileScrolling = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.dataset.scrollActive = "true";
    if (scrollbarIdleTimerRef.current !== null) {
      window.clearTimeout(scrollbarIdleTimerRef.current);
    }
    const idleDelay = scrollbarIdleDelayRef.current ?? parseCssTimeMs(
      getComputedStyle(document.documentElement).getPropertyValue("--motion-scrollbar-idle-delay"),
    );
    scrollbarIdleDelayRef.current = idleDelay;
    scrollbarIdleTimerRef.current = window.setTimeout(() => {
      delete el.dataset.scrollActive;
      scrollbarIdleTimerRef.current = null;
      scrollbarIdleDelayRef.current = null;
    }, idleDelay);
  }, []);

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
    return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight; // instant, never smooth
  }, []);

  const followViewportResize = useCallback(() => {
    const el = ref.current;
    if (!el) return false;
    const previousClientHeight = clientHeightRef.current;
    const nextClientHeight = el.clientHeight;
    clientHeightRef.current = nextClientHeight;
    if (
      previousClientHeight == null ||
      previousClientHeight <= 0 ||
      previousClientHeight === nextClientHeight ||
      !pinnedRef.current
    ) {
      return false;
    }
    scrollToBottom();
    return true;
  }, [scrollToBottom]);

  const rememberAnchor = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    anchorRef.current = readThreadScrollAnchor(el, rect.top, rect.bottom);
    if (initialPositionApplied.current) navigation.remember(el.scrollTop, anchorRef.current);
  }, [navigation.key, navigation.hash, navigation.ready]);

  const reconcileContent = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Clicking latest is an explicit follow intent. If content or the composer
    // changes during its glide, finish at the new bottom instead of restoring
    // the old reading anchor and cancelling the browser's smooth scroll.
    if (easingRef.current) {
      easingRef.current = false;
      pinnedRef.current = true;
      hidePill();
    }
    if (pinnedRef.current) scrollToBottom();
    else {
      const delta = threadScrollAnchorDelta(el, anchorRef.current, el.getBoundingClientRect().top);
      if (delta) el.scrollTop += delta;
    }
    rememberAnchor();
  }, [rememberAnchor, scrollToBottom, hidePill]);

  const handleScroll = useCallback(() => {
    rememberAnchor();
    showScrollbarWhileScrolling();
    // A growing composer shrinks this viewport. Some browsers dispatch the
    // resulting scroll event before ResizeObserver, so preserve the previous
    // pinned state here instead of mistaking the layout change for a user
    // scroll away from the bottom.
    if (followViewportResize()) {
      hidePill();
      return;
    }
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
  }, [
    rememberAnchor,
    followViewportResize,
    isPinned,
    hidePill,
    showPill,
    showScrollbarWhileScrolling,
  ]);

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
    if (typeof el.scrollTo === "function" && !motionDisabled()) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      // Environments without scrollTo (older jsdom): fall back to instant.
      el.scrollTop = el.scrollHeight;
      easingRef.current = false;
      pinnedRef.current = true;
      hidePill();
    }
  }, [isPinned, hidePill]);

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

  useEffect(() => () => {
    if (scrollbarIdleTimerRef.current !== null) {
      window.clearTimeout(scrollbarIdleTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    clientHeightRef.current = el.clientHeight;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followViewportResize()) hidePill();
      reconcileContent();
    });
    observer.observe(el);
    // The viewport itself does not resize when an image or historical row
    // grows. Observe the content box too, before the browser paints it.
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [followViewportResize, hidePill, reconcileContent]);

  // Follow new content only when already pinned; otherwise hold position.
  useLayoutEffect(() => {
    const el = ref.current;
    if (appliedNavigation.current.key !== navigation.key || appliedNavigation.current.hash !== navigation.hash) {
      appliedNavigation.current = { key: navigation.key, hash: navigation.hash };
      initialPositionApplied.current = false;
    }
    if (el && navigation.ready && !initialPositionApplied.current) {
      const top = navigation.initialPosition(el, el.getBoundingClientRect().top, el.scrollTop);
      if (top !== null) {
        el.scrollTop = top;
        pinnedRef.current = isPinned();
        rememberAnchor();
      }
      initialPositionApplied.current = true;
    }
    reconcileContent();
  }, [contentKey, reconcileContent, navigation.key, navigation.hash, navigation.ready]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={handleScroll}
        // Keep the viewport tied to the flex-sized wrapper vertically —
        // percentage heights don't reliably resolve against flex-determined
        // block heights, which let the thread overflow the page. In the
        // streamlined shell, extend only the scroll box through the page's
        // right gutter; matching padding preserves the message column while
        // placing the scrollbar against the properties-panel boundary.
        className={cn(
          "task-chat-scroll-viewport scrollbar-while-scrolling absolute inset-y-0 left-0 overflow-y-auto",
          streamlined
            ? "-right-4 overflow-x-hidden pr-4 md:-right-6 md:pr-6"
            : "right-0",
          className,
        )}
        data-testid="task-chat-scroller"
      >
        {children}
      </div>
      {pillPhase !== "hidden" ? (
        <button
          type="button"
          aria-label="Scroll to latest"
          onClick={handleJumpToLatest}
          onAnimationEnd={() => {
            if (pillPhase === "out") setPillPhase("hidden");
          }}
          // The tc-scroll-pill-* keyframes carry the translate(-50%) X-centering
          // (fill: both keeps it after the animation) — no -translate-x-1/2 here.
          className={cn(
            "absolute left-1/2 flex size-8 items-center justify-center rounded-full border border-border bg-background shadow-sm hover:bg-muted",
            streamlined ? "bottom-7" : "bottom-3",
            pillPhase === "out" ? "tc-scroll-pill-out" : "tc-scroll-pill-in",
          )}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
