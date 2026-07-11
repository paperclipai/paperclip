/**
 * NEO-405 / NEO-409 — dev-only on-device dictation (TTS) log panel.
 *
 * Rendered through a portal on `document.body`, i.e. entirely OUTSIDE the
 * MarkdownEditor / MDXEditor React tree, and refreshed on its own `setInterval`
 * rather than by the editor's render. This is deliberate and is the whole point
 * of the NEO-409 reopen: the earlier panel bumped a `useState` on
 * `MarkdownEditor` for every captured event, so dictation re-rendered the editor
 * subtree (incl. the controlled `<MDXEditor>`) dozens of times/sec — which can
 * itself trigger an extra `setMarkdown` reconcile mid-input, the exact race the
 * harness exists to observe (observer effect). Here, capture is a pure append to
 * the shared ref buffer and this panel only *reads* it, so it can never perturb
 * the editor it measures.
 *
 * Instrumentation only. Gated by {@link isTtsDebugEnabled}; removed before the
 * fix promotes to Canary/live (tracked in NEO-412).
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { TtsDebugLog } from "../lib/tts-debug";

/** How often the panel polls the buffer. Read-only; does not touch the editor. */
const REFRESH_MS = 400;

export function TtsDebugPanel({ log }: { log: TtsDebugLog }) {
  const [text, setText] = useState(() => log.format());
  const [size, setSize] = useState(() => log.size());
  const [copied, setCopied] = useState(false);

  // Self-contained refresh: poll the ref buffer. Only this component re-renders;
  // the editor tree is never involved.
  useEffect(() => {
    const id = window.setInterval(() => {
      setText(log.format());
      setSize(log.size());
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [log]);

  const handleCopy = useCallback(() => {
    const value = log.format();
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(() => {
        /* clipboard blocked — the panel text is still selectable for manual copy */
      });
    } else {
      done();
    }
  }, [log]);

  const handleClear = useCallback(() => {
    log.clear();
    setText(log.format());
    setSize(log.size());
  }, [log]);

  return createPortal(
    <div className="fixed inset-x-0 bottom-0 z-[9998] border-t border-border/60 bg-muted/95 px-3 py-2 backdrop-blur">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          TTS debug · {size} events
        </span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="rounded border border-border px-2 py-0.5 text-[11px] font-medium hover:bg-accent"
          >
            {copied ? "Copied ✓" : "Copy log"}
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="rounded border border-border px-2 py-0.5 text-[11px] font-medium hover:bg-accent"
          >
            Clear
          </button>
        </span>
      </div>
      <textarea
        readOnly
        value={text}
        spellCheck={false}
        className="h-40 w-full resize-y rounded bg-background/80 p-2 font-mono text-[10px] leading-4 text-foreground outline-none"
      />
    </div>,
    document.body,
  );
}
