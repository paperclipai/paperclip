/**
 * Runtime hover-capability detection.
 *
 * iPadOS Safari never flips `(hover: hover)` / `(any-hover: hover)` when a Magic
 * Keyboard trackpad or Bluetooth mouse is attached — it reports a touch-only
 * device for the life of the page. That broke sidebar hover-peek and then every
 * CSS hover highlight in the app, because Tailwind wraps
 * all `hover:*` utilities in that media query.
 *
 * A real cursor is still observable: mouse/trackpad input emits pointer events
 * with `pointerType: "mouse"`, whereas touch reports `"touch"` and the Pencil
 * reports `"pen"`. So we drive the `no-hover` class off events rather than media
 * queries, and treat hover capability as a **one-way latch** — once a cursor has
 * been seen, hover stays enabled for the session.
 *
 * The class is subtractive (fail-open) on purpose: it is only ever added when the
 * platform claims no hovering input at all. Anything that renders without calling
 * `startPointerCapabilityDetection` (Storybook, unit tests, SSR-less harnesses)
 * therefore keeps normal hover behaviour instead of silently losing it.
 */

/** Set on `<html>` while the device looks touch-only. See `index.css`. */
export const NO_HOVER_CLASS = "no-hover";

const HOVER_QUERY = "(any-hover: hover)";
const COARSE_QUERY = "(any-pointer: coarse)";

function mediaMatches(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;

  try {
    return window.matchMedia(query).matches;
  } catch {
    // Some embedded webviews throw on unknown media features.
    return false;
  }
}

/**
 * Whether the platform currently claims it has no hovering pointer at all.
 *
 * Deliberately conservative: it takes BOTH "nothing can hover" and "a coarse
 * pointer exists" to suppress hover, so a browser that simply does not report
 * hover capability keeps hover rather than losing it.
 */
export function looksTouchOnly(): boolean {
  return !mediaMatches(HOVER_QUERY) && mediaMatches(COARSE_QUERY);
}

let started = false;

/**
 * Marks `<html>` as touch-only until a real cursor shows up. Idempotent, safe to
 * call before React renders, and a no-op on hover-capable platforms.
 *
 * Returns a teardown for tests; production calls it once from `main.tsx`.
 */
export function startPointerCapabilityDetection(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  if (started) return () => {};
  started = true;

  const root = document.documentElement;
  if (!looksTouchOnly()) {
    // Desktop and anything honest about its pointer: nothing to suppress, and no
    // listeners to keep around.
    started = false;
    return () => {};
  }

  root.classList.add(NO_HOVER_CLASS);

  let disposed = false;
  const enableHover = () => {
    if (disposed) return;
    root.classList.remove(NO_HOVER_CLASS);
    teardown();
  };

  const onPointer = (e: PointerEvent) => {
    // Touch never hovers, and counting it would leave a stuck highlight after a
    // tap. A Pencil does hover, but it also fires `pointerover` on tap, so only
    // an actual cursor unlocks hover.
    if (e.pointerType === "mouse") enableHover();
  };

  const onMediaChange = (e: MediaQueryListEvent) => {
    if (e.matches) enableHover();
  };

  let mql: MediaQueryList | null = null;
  const hasPointerEvents = typeof window.PointerEvent === "function";

  function teardown() {
    if (disposed) return;
    disposed = true;
    started = false;
    if (hasPointerEvents) {
      window.removeEventListener("pointerover", onPointer);
      window.removeEventListener("pointermove", onPointer);
    }
    mql?.removeEventListener("change", onMediaChange);
  }

  if (hasPointerEvents) {
    // `pointerover` fires as soon as the cursor crosses into an element, so hover
    // lights up on the first movement rather than after a click.
    window.addEventListener("pointerover", onPointer, { passive: true });
    window.addEventListener("pointermove", onPointer, { passive: true });
  }

  if (typeof window.matchMedia === "function") {
    try {
      mql = window.matchMedia(HOVER_QUERY);
      mql.addEventListener("change", onMediaChange);
    } catch {
      mql = null;
    }
  }

  return teardown;
}

/** Test-only: forget that detection already ran. */
export function resetPointerCapabilityDetectionForTests(): void {
  started = false;
}
