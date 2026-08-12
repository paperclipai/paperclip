// Registers a capture-phase `scroll` listener on `win` that snaps the
// `documentElement.scrollTop` and `body.scrollTop` back to 0 whenever they
// drift. The desktop app shell expects neither to ever be non-zero — only
// `#main-content` should scroll — but `scrollIntoView`'s ancestor walk can
// reach `<html>` (which Chrome drives via its internal smooth-scroll
// algorithm, bypassing the JS `scrollTop` setter and ignoring CSS
// `overflow` on the root viewport). Snapping back on every scroll tick
// keeps the shell visually pinned.
//
// Returns a cleanup function that removes the listener.
export function pinDocumentScrollToZero(
  doc: Document = document,
  win: Window = window,
): () => void {
  const onScroll = () => {
    if (doc.documentElement.scrollTop !== 0) {
      doc.documentElement.scrollTop = 0;
    }
    if (doc.body.scrollTop !== 0) {
      doc.body.scrollTop = 0;
    }
  };
  // Intentionally NOT `passive: true` — a passive listener lets the browser
  // paint the scrolled frame before this handler runs, producing a one-frame
  // flash of the shifted shell. The handler doesn't call `preventDefault()`
  // and `scroll` events aren't cancelable, so dropping the passive flag has
  // no performance downside and runs the reset synchronously with dispatch.
  win.addEventListener("scroll", onScroll, { capture: true });
  return () => win.removeEventListener("scroll", onScroll, { capture: true });
}
