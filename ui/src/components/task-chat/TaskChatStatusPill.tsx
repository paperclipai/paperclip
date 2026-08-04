import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, Loader2, ShieldQuestion, OctagonX, Ban, Scissors } from "lucide-react";
import type { TaskChatStatusItem } from "./task-chat-model";
import { statusLabelIcon, toolTaxonomy } from "./tool-taxonomy";
import { isGenericStatusLabel, whimsyWord } from "./status-whimsy";
import { parseCssTimeMs } from "./motion-tokens";

function elapsedLabel(ms?: number): string | null {
  if (ms == null) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Tenths-precision elapsed ("24.3s", "1m 24.3s") so the readout visibly moves. */
function liveElapsedLabel(ms?: number): string | null {
  if (ms == null) return null;
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s`;
}

/** Elapsed ms since `startedAtMs`, ticking ten times a second while `live`. */
function useLiveElapsedMs(startedAtMs: number | undefined, live: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAtMs == null || !live) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [startedAtMs, live]);
  return startedAtMs == null ? undefined : Math.max(0, now - startedAtMs);
}

/**
 * How many line-heights the streaming interstitial block is shifted up so only
 * its LAST line shows in the 1lh viewport: lines − 1 (never negative).
 */
export function lineScrollOffset(scrollHeight: number, lineHeightPx: number): number {
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(lineHeightPx) || lineHeightPx <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(scrollHeight / lineHeightPx) - 1);
}

/** Read a `--motion-*` time token off :root in ms (0 when unset, e.g. jsdom). */
function motionTokenMs(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const ms = parseCssTimeMs(raw);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The interstitial update inside a one-line-height clipped viewport.
 *
 * The `.tc-line-scroll` slide plays ONLY at swap moments (PAP-368): on mount —
 * i.e. when a new update replaces the previous one, the parent keys this
 * component by swap — the text slides up from below the 1lh clip, and once
 * that enter window (--motion-line-scroll) elapses the transition is disabled
 * inline. While `streaming`, the block is shifted up by whole line-heights so
 * only the tail line shows, but with the transition off the shift SNAPS — no
 * per-wrap glide keeping the row in constant motion. Once the update finishes
 * (`streaming` false) the held text renders single-line ellipsized, static.
 * When `leaving` (held past the dwell with no successor, PAP-376), the
 * transition re-enables and the line continues up out of the clip. Line count
 * is measured from scrollHeight / line-height, re-checked on resize.
 */
function LiveSelfTalkLine({
  text,
  streaming,
  leaving,
}: {
  text: string;
  streaming: boolean;
  leaving?: boolean;
}) {
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const [offset, setOffset] = useState(0);
  const [entered, setEntered] = useState(false);
  const [settled, setSettled] = useState(false);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => {
      const lineHeight = parseFloat(window.getComputedStyle(el).lineHeight);
      setOffset(lineScrollOffset(el.scrollHeight, lineHeight));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, streaming]);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    const timer = window.setTimeout(() => setSettled(true), motionTokenMs("--motion-line-scroll"));
    return () => {
      cancelAnimationFrame(id);
      window.clearTimeout(timer);
    };
  }, []);
  const shift = !entered ? 1 : leaving ? -1 : streaming ? -offset : 0;
  return (
    <span
      className="tc-line-scroll min-w-0 flex-1"
      data-testid="task-chat-live-self-talk"
      data-streaming={streaming || undefined}
      data-leaving={leaving || undefined}
    >
      <span
        ref={innerRef}
        className={cn("tc-line-scroll-inner block", !streaming && "truncate")}
        style={{
          transform: shift !== 0 ? `translateY(calc(${shift} * 1lh))` : undefined,
          transition: settled && !leaving ? "none" : undefined,
        }}
      >
        {text}
      </span>
    </span>
  );
}

interface HeldSelfTalk {
  text: string;
  /** The displayed update is the currently-streaming tail message. */
  streaming: boolean;
  /** Increments at each swap — keys LiveSelfTalkLine so the slide replays. */
  swapKey: number;
  /** Sliding out after sitting held for the full dwell (PAP-376). */
  leaving?: boolean;
}

/**
 * Held interstitial state (PAP-368, amended by PAP-376): a finished update
 * stays visible, static, for --motion-interstitial-dwell (~4s) — then, if
 * nothing superseded it, slides away rather than sitting until the next
 * update happens to push it out. The same dwell paces swaps (~4s minimum
 * between them) so visibility tracks reading time, not streaming speed.
 * Updates that arrive inside the dwell window collapse latest-wins (a queue
 * of one: only the newest pending update swaps in when the dwell expires).
 *
 * Message boundaries are the `selfTalk` gaps: the transcript tail clears it
 * between assistant messages (tool calls / thinking in between), so a
 * defined→undefined→defined sequence marks a new update.
 */
function useHeldSelfTalk(selfTalk: string | undefined, live: boolean): HeldSelfTalk | null {
  const [line, setLine] = useState<HeldSelfTalk | null>(null);
  const lineRef = useRef<HeldSelfTalk | null>(line);
  const pendingRef = useRef<string | null>(null);
  const tailRef = useRef<string | undefined>(selfTalk);
  const lastSwapAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const leaveTimerRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  tailRef.current = selfTalk;

  useEffect(() => {
    const clear = (ref: { current: number | null }) => {
      if (ref.current != null) {
        window.clearTimeout(ref.current);
        ref.current = null;
      }
    };
    const show = (next: HeldSelfTalk | null) => {
      lineRef.current = next;
      setLine(next);
    };
    // Held past the dwell with nothing queued: slide the line out of the 1lh
    // viewport (--motion-line-scroll) and unmount it back to the empty slot.
    const scheduleLeave = () => {
      clear(leaveTimerRef);
      clear(exitTimerRef);
      leaveTimerRef.current = window.setTimeout(() => {
        leaveTimerRef.current = null;
        // A queued update's swap timer fires no later than this — let the
        // swap replace the line instead of playing the exit first.
        if (pendingRef.current != null) return;
        const cur = lineRef.current;
        if (cur == null || cur.streaming) return;
        show({ ...cur, leaving: true });
        exitTimerRef.current = window.setTimeout(() => {
          exitTimerRef.current = null;
          if (lineRef.current?.leaving) show(null);
        }, motionTokenMs("--motion-line-scroll"));
      }, motionTokenMs("--motion-interstitial-dwell"));
    };
    const swapIn = (text: string, streaming: boolean) => {
      clear(leaveTimerRef);
      clear(exitTimerRef);
      lastSwapAtRef.current = Date.now();
      show({ text, streaming, swapKey: (lineRef.current?.swapKey ?? 0) + 1 });
      // Swapped in with its stream already over: its idle clock starts now.
      if (!streaming) scheduleLeave();
    };
    if (!live) {
      // Turn end clears the row (the reserved slot itself unmounts with it).
      clear(timerRef);
      clear(leaveTimerRef);
      clear(exitTimerRef);
      pendingRef.current = null;
      if (lineRef.current) show(null);
      return;
    }
    const cur = lineRef.current;
    if (selfTalk == null) {
      // Stream ended: the update becomes held and its idle clock starts.
      if (cur?.streaming) {
        show({ ...cur, streaming: false });
        scheduleLeave();
      }
      return;
    }
    if (cur == null) {
      swapIn(selfTalk, true);
      return;
    }
    if (cur.streaming) {
      // Same message growing — update in place, no swap.
      if (cur.text !== selfTalk) show({ ...cur, text: selfTalk });
      return;
    }
    // A new update while one is held (or leaving): queue it latest-wins and
    // swap when the dwell since the last swap has elapsed.
    pendingRef.current = selfTalk;
    if (timerRef.current == null) {
      const dwellMs = motionTokenMs("--motion-interstitial-dwell");
      const delay = Math.max(0, lastSwapAtRef.current + dwellMs - Date.now());
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const text = pendingRef.current;
        pendingRef.current = null;
        // Still streaming iff the tail message is live at swap time; if so the
        // next effect pass keeps the text tracking the tail.
        if (text != null) swapIn(text, tailRef.current != null);
      }, delay);
    }
  }, [selfTalk, live]);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      if (leaveTimerRef.current != null) window.clearTimeout(leaveTimerRef.current);
      if (exitTimerRef.current != null) window.clearTimeout(exitTimerRef.current);
    },
    [],
  );

  return line;
}

const CONFIG = {
  running: { Icon: Loader2, spin: true, tone: "text-(--status-agent-running)" },
  working: { Icon: Loader2, spin: true, tone: "text-(--status-agent-running)" },
  awaiting_approval: { Icon: ShieldQuestion, spin: false, tone: "text-primary" },
  interrupted: { Icon: OctagonX, spin: false, tone: "text-destructive" },
  refused: { Icon: Ban, spin: false, tone: "text-destructive" },
  truncated: { Icon: Scissors, spin: false, tone: "text-(--status-agent-paused)" },
} as const;

interface TaskChatStatusPillProps {
  item: TaskChatStatusItem;
  onApprovalDecision?: (optionId: string) => void;
  /**
   * When set, the live line is the header of an expandable parent row
   * (TaskChatTurn): render a trailing chevron reflecting the open state —
   * the same expand grammar as tool rows and the settled "Worked ·" line.
   */
  chevronOpen?: boolean;
  /**
   * Expand toggle for the parent row. The button (hover + click target) wraps
   * ONLY the gerund status line — the interstitial row above it stays outside
   * (PAP-376): its text vanishes on expand, so hovering it as part of the
   * header read as covering two unrelated lines.
   */
  onToggle?: () => void;
}

/**
 * Lifecycle state as a status affordance (never a bubble), with a defined
 * enter transition. Live running/working states render the v7 flat statusline
 * (pulse dot + shimmering label + mono meta); Tier-B attention states keep
 * card chrome — awaiting-approval elevates with an attention pulse and
 * exposes the ACP permission options as actions.
 */
export function TaskChatStatusPill({
  item,
  onApprovalDecision,
  chevronOpen,
  onToggle,
}: TaskChatStatusPillProps) {
  const { Icon, spin, tone } = CONFIG[item.status];
  const awaiting = item.status === "awaiting_approval";
  const live = item.status === "running" || item.status === "working";
  const liveElapsedMs = useLiveElapsedMs(item.startedAtMs, live);
  const heldSelfTalk = useHeldSelfTalk(live ? item.selfTalk : undefined, live);
  const elapsed = elapsedLabel(item.elapsedMs);

  if (live) {
    const liveElapsed = liveElapsedLabel(liveElapsedMs ?? item.elapsedMs);
    // While an interstitial streams, its text lives on its OWN row above; the
    // status line below keeps the uninterrupted gerund rotation ("Responding"
    // never takes the line, and no Responding icon appears here).
    const streamingInterstitial = item.selfTalk != null;
    const ToolIcon = item.toolName
      ? toolTaxonomy(item.toolName).icon
      : streamingInterstitial
        ? null
        : statusLabelIcon(item.label);
    // Whimsy fills gaps, never replaces signal: only the generic
    // "Running"/"Working" labels — and the interstitial-streaming state, whose
    // text renders on the row above — swap for a deterministic whimsical
    // gerund (seeded by the run-scoped item id, rotating ~10s via the live
    // tick).
    const label = streamingInterstitial || isGenericStatusLabel(item.label)
      ? whimsyWord(item.id, liveElapsedMs ?? item.elapsedMs ?? 0)
      : item.label;
    const statusLine = (
      <div className="tc-enter-status flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
        {/* Fixed-size lead slot keeps the label from moving as tool icons
            come and go; the pulse dot renders unconditionally. */}
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <span
            aria-hidden
            className="h-2 w-2 animate-pulse rounded-full bg-(--status-agent-running)"
          />
        </span>
        {ToolIcon ? <ToolIcon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
        {/* Text cells share a baseline row so the smaller mono readouts don't
            float above the label's baseline. */}
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shimmer-text shimmer-text-muted shrink-0 font-medium">
            {label}…
          </span>
          {liveElapsed ? (
            <span className="shrink-0 font-mono tabular-nums text-(length:--text-micro)">
              {liveElapsed}
            </span>
          ) : null}
          {item.detail ? (
            <span className="min-w-0 truncate font-mono text-(length:--text-micro)">{item.detail}</span>
          ) : null}
          {item.tokens ? (
            <span className="ml-auto shrink-0 font-mono text-(length:--text-micro)">
              {item.tokens.used.toLocaleString()}/{item.tokens.size.toLocaleString()} ctx
            </span>
          ) : null}
        </span>
        {chevronOpen !== undefined ? (
          <ChevronRight
            className={cn("h-3 w-3 shrink-0 transition-transform", chevronOpen ? "rotate-90" : null)}
            aria-hidden
          />
        ) : null}
      </div>
    );
    // The interstitial row is PERMANENTLY RESERVED while the turn is live
    // (round 9): the layout above never jumps to make room. A streaming
    // interstitial gets this bubble-less, icon-less single-line row DIRECTLY
    // ABOVE the status line — the two never share a line. The latest update is
    // held after its stream ends (PAP-368) and slides away once it has sat
    // for the full --motion-interstitial-dwell without a successor (PAP-376);
    // the .tc-line-scroll slide otherwise plays only when a new update swaps
    // in (keyed remount). Before the first update the row is an empty one-line
    // slot of identical height; the empty lead slot keeps the text
    // column-aligned with the status label. The expand button wraps ONLY the
    // status line, so the interstitial row never picks up its hover.
    return (
      <div className="flex flex-col">
        <div
          className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground"
          data-testid="task-chat-interstitial-row"
        >
          <span aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {heldSelfTalk ? (
            <LiveSelfTalkLine
              key={heldSelfTalk.swapKey}
              text={heldSelfTalk.text}
              streaming={heldSelfTalk.streaming}
              leaving={heldSelfTalk.leaving}
            />
          ) : (
            <span aria-hidden className="tc-line-scroll min-w-0 flex-1" />
          )}
        </div>
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={chevronOpen}
            className="-mx-1.5 block w-full rounded-sm px-1.5 text-left transition-colors hover:bg-muted/60"
            data-testid="task-chat-live-turn"
          >
            {statusLine}
          </button>
        ) : (
          statusLine
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "tc-enter-status flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm",
        awaiting ? "tc-approval border-primary/40 bg-primary/5" : "border-border bg-muted/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={cn("h-4 w-4 shrink-0", tone, spin && "animate-spin")} />
        <span className="min-w-0 truncate font-medium">{item.label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {elapsed ? <span>{elapsed}</span> : null}
          {item.tokens ? (
            <span>
              {item.tokens.used.toLocaleString()}/{item.tokens.size.toLocaleString()} ctx
            </span>
          ) : null}
        </span>
      </div>
      {item.detail ? <p className="text-xs text-muted-foreground">{item.detail}</p> : null}
      {awaiting && item.approval ? (
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {item.approval.options.map((opt) => {
            const reject = opt.kind.startsWith("reject");
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onApprovalDecision?.(opt.id)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                  reject
                    ? "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    : "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
