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

/** Persist collapsed/expanded so the panel stays minimized across reloads. */
const OPEN_STORAGE_KEY = "neo405-tts-debug-open";

function readInitialOpen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    // Default COLLAPSED (NEO-420): only expand if the user explicitly opened it.
    return window.localStorage.getItem(OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function TtsDebugPanel({ log }: { log: TtsDebugLog }) {
  const [open, setOpen] = useState(readInitialOpen);
  const [text, setText] = useState(() => log.format());
  const [size, setSize] = useState(() => log.size());
  const [copied, setCopied] = useState(false);

  // Self-contained refresh: poll the ref buffer, but ONLY while expanded. When
  // collapsed there is no timer and no paint — nothing runs near the editor, which
  // is the whole point of the passive harness (NEO-409). Only this component ever
  // re-renders; the editor tree is never involved.
  useEffect(() => {
    if (!open) return;
    // Refresh once on expand so the log isn't stale from before the timer started.
    setText(log.format());
    setSize(log.size());
    const id = window.setInterval(() => {
      setText(log.format());
      setSize(log.size());
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [log, open]);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(OPEN_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* storage disabled — state still holds for this session */
      }
      return next;
    });
  }, []);

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

  // Collapsed: a small handle pinned to the LEFT edge, clear of the editor field
  // so dictation/typing is never blocked (NEO-420). Tap to expand.
  if (!open) {
    return createPortal(
      <button
        type="button"
        onClick={toggleOpen}
        aria-label="Open TTS debug log"
        className="fixed left-0 top-1/2 z-[9998] -translate-y-1/2 rounded-r border border-l-0 border-border/60 bg-muted/95 px-1 py-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground shadow-sm backdrop-blur hover:bg-accent"
        style={{ writingMode: "vertical-rl" }}
      >
        TTS ▸
      </button>,
      document.body,
    );
  }

  // Expanded: pinned to the left edge (not full-width) so the right side of the
  // viewport — where the editor field lives — stays clear.
  return createPortal(
    <div className="fixed left-0 top-1/2 z-[9998] w-[min(92vw,22rem)] -translate-y-1/2 rounded-r border border-l-0 border-border/60 bg-muted/95 px-3 py-2 shadow-lg backdrop-blur">
      <div className="mb-1 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={toggleOpen}
          aria-label="Collapse TTS debug log"
          className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          ◂ TTS debug · {size} events
        </button>
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
