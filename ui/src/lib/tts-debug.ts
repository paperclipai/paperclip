/**
 * NEO-405 / NEO-409 — On-device dictation (TTS) logging harness.
 *
 * Instrumentation ONLY. This module records the input-event timeline that lets us
 * prove the iOS dictation "eaten text" mechanism (an `insertReplacementText`
 * correction landing on a stale DOM offset after a mid-composition
 * `setMarkdown()`/reconcile). It changes **no** editing behavior and is gated so
 * it never runs for normal users — see {@link isTtsDebugEnabled}.
 *
 * There is intentionally no existing debug-flag or client-log plumbing to reuse
 * (grep-confirmed on the `cortex-beta` branch), so this is self-contained and is
 * removed before the fix promotes to Canary/live.
 */

/** localStorage key that opts a device into the harness (value must be "1"). */
export const TTS_DEBUG_STORAGE_KEY = "neo405-tts-debug";
/** Query param that opts a page load into the harness (`?ttsdebug=1`). */
export const TTS_DEBUG_QUERY_PARAM = "ttsdebug";

/** Cap the buffer so a long dictation session can't grow memory without bound. */
const MAX_ENTRIES = 2000;

export interface TtsLogEntry {
  /** Milliseconds since the first recorded event this session. */
  t: number;
  /** Event class, e.g. `beforeinput`, `compositionstart`, `onChange`, `setMarkdown`. */
  type: string;
  /** Structured, JSON-serializable detail for the event. */
  detail: Record<string, unknown>;
}

/**
 * True when the harness is opted in for this session: `?ttsdebug=1` in the URL,
 * OR `localStorage["neo405-tts-debug"] === "1"`. A URL opt-in also persists the
 * flag to localStorage so it survives the SPA navigations the editor lives
 * behind. Safe on the server (returns false when `window` is absent).
 */
export function isTtsDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get(TTS_DEBUG_QUERY_PARAM) === "1") {
      try {
        window.localStorage.setItem(TTS_DEBUG_STORAGE_KEY, "1");
      } catch {
        /* private mode / storage disabled — URL opt-in still holds for this load */
      }
      return true;
    }
    return window.localStorage.getItem(TTS_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * A bounded, append-only capture buffer with a monotonic clock relative to the
 * first entry. One instance is created per opted-in editor mount.
 */
export class TtsDebugLog {
  private entries: TtsLogEntry[] = [];
  private startedAt: number | null = null;

  private now(): number {
    const clock =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    if (this.startedAt === null) this.startedAt = clock;
    return Math.round(clock - this.startedAt);
  }

  record(type: string, detail: Record<string, unknown> = {}): void {
    this.entries.push({ t: this.now(), type, detail });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  clear(): void {
    this.entries = [];
    this.startedAt = null;
  }

  size(): number {
    return this.entries.length;
  }

  snapshot(): TtsLogEntry[] {
    return this.entries;
  }

  /** Human/greppable rendering, one event per line, newest last. */
  format(): string {
    if (this.entries.length === 0) return "(no events captured yet)";
    return this.entries.map(formatTtsEntry).join("\n");
  }
}

/** Format a single entry as `  +123ms  type  {json}`. */
export function formatTtsEntry(entry: TtsLogEntry): string {
  const stamp = `+${entry.t}ms`.padStart(9);
  let detail: string;
  try {
    detail = JSON.stringify(entry.detail);
  } catch {
    detail = "<unserializable>";
  }
  return `${stamp}  ${entry.type.padEnd(18)}  ${detail}`;
}

/**
 * Summarize a `beforeinput` InputEvent for the log — the `inputType` and, when
 * present, each target StaticRange's start/end offset plus a short text preview
 * of the affected node. `getTargetRanges()` on an `insertReplacementText` event
 * is the crux of the whole diagnosis.
 */
export function describeBeforeInput(event: InputEvent): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    inputType: event.inputType,
    data: event.data ?? null,
    isComposing: event.isComposing,
  };
  try {
    const ranges = typeof event.getTargetRanges === "function" ? event.getTargetRanges() : [];
    detail.targetRanges = ranges.map((range) => {
      const container = range.startContainer;
      const text = container?.textContent ?? "";
      return {
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        collapsed: range.collapsed,
        nodeText: text.slice(0, 40),
        nodeLen: text.length,
      };
    });
  } catch {
    detail.targetRanges = "<unavailable>";
  }
  return detail;
}
