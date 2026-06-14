// Keeps the fixed desktop shell pinned when browser-native scrollIntoView
// drives root document scrolling outside our internal #main-content scroller.
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
  win.addEventListener("scroll", onScroll, { capture: true });
  return () => win.removeEventListener("scroll", onScroll, { capture: true });
}
