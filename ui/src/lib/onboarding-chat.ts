/** The welcome starts only once the conversation has painted in a visible tab. */
export function afterVisibleConversationPaint(start: () => void): () => void {
  let firstFrame = 0;
  let secondFrame = 0;
  let cancelled = false;
  let started = false;
  const schedule = () => {
    if (document.visibilityState === "hidden" || cancelled || started || firstFrame) return;
    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        firstFrame = 0;
        if (!cancelled && document.visibilityState !== "hidden") { started = true; start(); }
      });
    });
  };
  document.addEventListener("visibilitychange", schedule);
  schedule();
  return () => {
    cancelled = true;
    cancelAnimationFrame(firstFrame);
    cancelAnimationFrame(secondFrame);
    document.removeEventListener("visibilitychange", schedule);
  };
}
