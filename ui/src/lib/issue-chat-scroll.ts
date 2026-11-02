export type IssueChatScrollTarget =
  | { type: "element"; element: HTMLElement }
  | { type: "window" };

export interface ComposerViewportSnapshot {
  composerViewportTop: number;
}

/**
 * The page itself is only a usable scroll target when the document can actually
 * scroll. The desktop app shell pins the body to `overflow: hidden` and renders
 * a fixed-height (`h-dvh`) flex column, so scrolling the window there does not
 * move content — it translates the entire shell (sidebar included) out of the
 * viewport, the regression reported in paperclipai/paperclip#7972. The mobile
 * shell and the auth-free perf fixture leave the body scrollable, where window
 * scrolling is the correct behaviour.
 */
export function isWindowScrollable(
  doc: Document = document,
  win: Window = window,
): boolean {
  const candidates = [doc.scrollingElement, doc.documentElement, doc.body];
  for (const element of candidates) {
    if (!(element instanceof HTMLElement)) continue;
    const style = win.getComputedStyle(element);
    // Check both the `overflow-y` longhand and the `overflow` shorthand: the
    // shell sets `body.style.overflow` (the shorthand) and some engines (incl.
    // jsdom) do not derive the longhand from it in computed style.
    const clipped = (value: string) => value === "hidden" || value === "clip";
    if (clipped(style.overflowY) || clipped(style.overflow)) {
      return false;
    }
  }
  return true;
}

export function resolveIssueChatScrollTarget(
  doc: Document = document,
  win: Window = window,
): IssueChatScrollTarget {
  const mainContent = doc.getElementById("main-content");

  if (mainContent instanceof HTMLElement) {
    const overflowY = win.getComputedStyle(mainContent).overflowY;
    const usesOwnScroll =
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay")
      && mainContent.scrollHeight > mainContent.clientHeight + 1;

    if (usesOwnScroll) {
      return { type: "element", element: mainContent };
    }
  }

  return { type: "window" };
}

export function captureComposerViewportSnapshot(
  composerElement: HTMLElement | null,
): ComposerViewportSnapshot | null {
  if (!composerElement) return null;

  return {
    composerViewportTop: composerElement.getBoundingClientRect().top,
  };
}

export function shouldPreserveComposerViewport(
  composerElement: HTMLElement | null,
  doc: Document = document,
) {
  if (!composerElement) return false;

  const activeElement = doc.activeElement;
  if (activeElement instanceof Node && composerElement.contains(activeElement)) {
    return true;
  }
  return false;
}

export function restoreComposerViewportSnapshot(
  snapshot: ComposerViewportSnapshot | null,
  composerElement: HTMLElement | null,
  doc: Document = document,
  win: Window = window,
) {
  if (!snapshot || !composerElement) return;

  const delta = composerElement.getBoundingClientRect().top - snapshot.composerViewportTop;
  if (!Number.isFinite(delta) || Math.abs(delta) < 1) return;

  const target = resolveIssueChatScrollTarget(doc, win);
  if (target.type === "element") {
    target.element.scrollTop += delta;
    return;
  }

  // Falling back to the window is only safe when the page itself scrolls. In
  // the fixed-height desktop shell the body is `overflow: hidden`, so a window
  // scroll would shift the whole app shell — sidebar included — off-screen
  // (paperclipai/paperclip#7972). There is nothing to restore in that case.
  if (!isWindowScrollable(doc, win)) return;

  win.scrollBy({ top: delta, left: 0, behavior: "auto" });
}
