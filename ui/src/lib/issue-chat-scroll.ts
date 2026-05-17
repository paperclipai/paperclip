export type IssueChatScrollTarget =
  | { type: "element"; element: HTMLElement }
  | { type: "window" };

export interface ComposerViewportSnapshot {
  composerViewportTop: number;
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

  win.scrollBy({ top: delta, left: 0, behavior: "auto" });
}
