export function focusPlanPane(pane: HTMLElement | null) {
  if (!pane) return;

  pane.tabIndex = -1;
  pane.focus({ preventScroll: true });
  if (pane.ownerDocument.activeElement !== pane) {
    pane.removeAttribute("tabindex");
    return;
  }

  if (!pane.hasAttribute("data-plan-pane-attention")) {
    pane.setAttribute("data-plan-pane-attention", "");
    pane.addEventListener("blur", () => {
      pane.removeAttribute("data-plan-pane-attention");
      pane.removeAttribute("tabindex");
    }, { once: true });
    return;
  }

  const cue = pane.getAnimations().find(animation =>
    animation instanceof CSSAnimation && animation.animationName === "plan-pane-attention");
  if (cue) {
    cue.currentTime = 0;
    cue.play();
  }
}

export function scheduleTaskPaneScroll(pane: HTMLElement | null, top: number) {
  if (!pane) return;

  const frame = requestAnimationFrame(() => pane.scrollTo({ top, behavior: "auto" }));
  return () => {
    cancelAnimationFrame(frame);
    if (pane.hasAttribute("data-plan-pane-attention")) pane.blur();
  };
}
