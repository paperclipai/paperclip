export type IssueChatScrollTarget =
  | { type: "element"; element: HTMLElement }
  | { type: "window" };

export interface ComposerViewportSnapshot {
  composerViewportTop: number;
  distanceFromBottom: number | null;
}

const BOTTOM_PROXIMITY_PX = 48;

/**
 * The page itself is only a usable scroll target when the document can actually
 * scroll. The desktop app shell pins the body and renders its own internal
 * scroller, so a window scroll there can shift the whole shell off-screen.
 */
export function isWindowScrollable(
  doc: Document = document,
  win: Window = window,
): boolean {
  const candidates = [doc.scrollingElement, doc.documentElement, doc.body];
  for (const element of candidates) {
    if (!(element instanceof HTMLElement)) continue;
    const style = win.getComputedStyle(element);
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

function issueChatDistanceFromBottom(
  target: IssueChatScrollTarget,
  doc: Document,
  win: Window,
): number | null {
  if (target.type === "element") {
    return Math.max(
      0,
      target.element.scrollHeight - target.element.scrollTop - target.element.clientHeight,
    );
  }

  const scroller = doc.scrollingElement ?? doc.documentElement;
  if (!scroller) return null;

  return Math.max(0, scroller.scrollHeight - win.scrollY - win.innerHeight);
}

function scrollIssueChatTargetToBottom(
  target: IssueChatScrollTarget,
  doc: Document,
  win: Window,
) {
  if (target.type === "element") {
    target.element.scrollTop = Math.max(0, target.element.scrollHeight - target.element.clientHeight);
    return;
  }

  if (!isWindowScrollable(doc, win)) return;

  const scroller = doc.scrollingElement ?? doc.documentElement;
  win.scrollTo({ top: scroller.scrollHeight, left: 0, behavior: "auto" });
}

export function captureComposerViewportSnapshot(
  composerElement: HTMLElement | null,
  doc: Document = document,
  win: Window = window,
): ComposerViewportSnapshot | null {
  if (!composerElement) return null;
  const target = resolveIssueChatScrollTarget(doc, win);

  return {
    composerViewportTop: composerElement.getBoundingClientRect().top,
    distanceFromBottom: issueChatDistanceFromBottom(target, doc, win),
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
  const currentDistanceFromBottom = issueChatDistanceFromBottom(target, doc, win);
  if (
    snapshot.distanceFromBottom !== null
    && currentDistanceFromBottom !== null
    && snapshot.distanceFromBottom <= BOTTOM_PROXIMITY_PX
    && currentDistanceFromBottom <= Math.max(BOTTOM_PROXIMITY_PX, Math.abs(delta) + BOTTOM_PROXIMITY_PX)
  ) {
    scrollIssueChatTargetToBottom(target, doc, win);
    return;
  }

  if (target.type === "element") {
    target.element.scrollTop += delta;
    return;
  }

  if (!isWindowScrollable(doc, win)) return;

  win.scrollBy({ top: delta, left: 0, behavior: "auto" });
}
