import * as React from "react";

/**
 * Source-adapted AI Elements `Conversation`. The stick-to-bottom semantics and
 * the "jump to latest" affordance are kept; the `use-stick-to-bottom`
 * dependency is replaced by a scroll listener, and the unseen count comes from
 * the reducer timeline length rather than a message store.
 */
export function Conversation({
  itemCount,
  label,
  children,
}: {
  itemCount: number;
  label: string;
  children: React.ReactNode;
}) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [following, setFollowing] = React.useState(true);
  const [seenCount, setSeenCount] = React.useState(itemCount);

  const scrollToBottom = React.useCallback((smooth: boolean) => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: smooth && !reduceMotion ? "smooth" : "auto",
    });
  }, []);

  React.useEffect(() => {
    if (!following) return;
    scrollToBottom(true);
    setSeenCount(itemCount);
  }, [itemCount, following, scrollToBottom]);

  function onScroll() {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const atBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
    setFollowing(atBottom);
    if (atBottom) setSeenCount(itemCount);
  }

  function reengage() {
    setFollowing(true);
    setSeenCount(itemCount);
    scrollToBottom(true);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "End") {
      event.preventDefault();
      reengage();
    } else if (event.key === "Home") {
      event.preventDefault();
      setFollowing(false);
      viewportRef.current?.scrollTo({ top: 0 });
    }
  }

  const unseen = Math.max(itemCount - seenCount, 0);

  return (
    <div data-slot="conversation" className="ui-conversation">
      <div
        ref={viewportRef}
        role="log"
        aria-label={label}
        aria-live="polite"
        aria-relevant="additions"
        tabIndex={0}
        className="ui-conversation-viewport"
        data-following={following}
        data-testid="live-transcript"
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
      {following ? null : (
        <button
          type="button"
          className="ui-jump-to-latest"
          data-testid="jump-to-latest"
          onClick={reengage}
        >
          Jump to latest{unseen > 0 ? ` (${unseen} new)` : ""}
        </button>
      )}
    </div>
  );
}
