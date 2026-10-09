import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Pause, Play, RotateCcw } from "lucide-react";
import {
  TASK_CHAT_STATE_LIST,
  type TaskChatStateId,
} from "@/components/task-chat/task-chat-states";
import { buildScenario } from "@/components/task-chat/task-chat-fixtures";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { TaskChatPlanView } from "@/components/task-chat/TaskChatPlanView";
import { TaskChatBubbleActions } from "@/components/task-chat/TaskChatBubbleActions";
import { TweakPanel } from "@/components/task-chat/TweakPanel";
import type {
  TaskChatItem,
  TaskChatMessageItem,
} from "@/components/task-chat/task-chat-model";

/**
 * Demo binding for the agent-bubble copy · 👍 · 👎 cluster (PAP-413). The live
 * thread wires these to the feedback-vote API; here the votes no-op so the
 * harness can show the footer without a control plane.
 */
function labMessageActions(item: TaskChatMessageItem) {
  if (item.author !== "agent" || item.optimistic) return null;
  return (
    <TaskChatBubbleActions
      copyText={item.text}
      feedback={{
        activeVote: null,
        sharingPreference: "allowed",
        termsUrl: null,
        onVote: async () => {},
      }}
    />
  );
}

/** Replay ticks of selfTalk gap between scripted interstitial updates (~0.7s at 1×). */
const SELF_TALK_GAP_TICKS = 30;

/** A fixture's scripted interstitial updates: blank-line-separated segments. */
function selfTalkSegments(script: string): string[] {
  return script
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The selfTalk visible at replay tick `tick`: each segment streams one char
 * per tick as its own update, with a gap (selfTalk undefined — the real
 * adapter clears it between assistant messages) before the next; after the
 * last segment ends, selfTalk stays undefined so the pill's hold-until-
 * superseded behavior (PAP-368) is visible in the lab.
 */
function selfTalkAtTick(segments: string[], tick: number): string | undefined {
  let t = tick;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (t <= seg.length) return seg.slice(0, t) || undefined;
    t -= seg.length;
    if (i === segments.length - 1) return undefined;
    if (t <= SELF_TALK_GAP_TICKS) return undefined;
    t -= SELF_TALK_GAP_TICKS;
  }
  return undefined;
}

/** Progressively reveal any streaming message / live-line interstitial text at `speed`. */
function useStreamingReplay(
  baseItems: TaskChatItem[],
  speed: number,
  playToken: number,
): TaskChatItem[] {
  const [chars, setChars] = useState<number>(Number.MAX_SAFE_INTEGER);
  const streamingIndex = baseItems.findIndex(
    (i) =>
      (i.kind === "message" && i.streaming) ||
      (i.kind === "turn" && !i.settled && i.liveStatus?.selfTalk != null),
  );
  const streamingItem = baseItems[streamingIndex];
  const isInterstitial = streamingItem?.kind === "turn";
  const fullText = useMemo(() => {
    const it = baseItems[streamingIndex];
    if (!it) return "";
    if (it.kind === "message") return it.text;
    if (it.kind === "turn") return it.liveStatus?.selfTalk ?? "";
    return "";
  }, [baseItems, streamingIndex]);
  const segments = useMemo(
    () => (isInterstitial ? selfTalkSegments(fullText) : []),
    [isInterstitial, fullText],
  );

  useEffect(() => {
    if (streamingIndex < 0) {
      setChars(Number.MAX_SAFE_INTEGER);
      return;
    }
    setChars(0);
    let n = 0;
    // One extra tick past the last segment lands on the trailing undefined
    // (message ended) state.
    const stopAt = isInterstitial
      ? segments.reduce((a, s) => a + s.length, 0) +
        SELF_TALK_GAP_TICKS * Math.max(0, segments.length - 1) +
        1
      : fullText.length;
    const baseIntervalMs = 24;
    const interval = window.setInterval(() => {
      n += 1;
      setChars(n);
      if (n >= stopAt) window.clearInterval(interval);
    }, Math.max(4, baseIntervalMs / speed));
    return () => window.clearInterval(interval);
  }, [streamingIndex, fullText, isInterstitial, segments, speed, playToken]);

  if (streamingIndex < 0) return baseItems;
  return baseItems.map((it, idx) => {
    if (idx !== streamingIndex) return it;
    const shown = fullText.slice(0, chars);
    const done = chars >= fullText.length;
    if (it.kind === "message") return { ...it, text: shown, streaming: !done };
    // Parent-row interstitial (PAP-361/368): reveal the scripted updates
    // segment by segment; the pill holds each finished one until the next
    // swaps in.
    if (it.kind === "turn" && it.liveStatus) {
      return { ...it, liveStatus: { ...it.liveStatus, selfTalk: selfTalkAtTick(segments, chars) } };
    }
    return it;
  });
}

/**
 * Dev harness for the chat-style task thread (route: /dev/task-chat-lab, dev
 * builds only). Drives the render layer into every inventory
 * state via synthetic events — no live agent — and is also the human's
 * post-baseline iteration cockpit: state switcher, streaming replay, a
 * 0.1×–10× speed control, and the live motion tweak panel.
 */
/**
 * Agent-bubble background treatments explored for PAP-501 (feedback: the
 * dark-mode agent card reads too light against the near-black page). Each id
 * maps to a `[data-bubble-variant]` scope in index.css; "" is the chosen
 * page-surface treatment.
 */
const BUBBLE_VARIANTS = [
  { id: "", label: "Chosen · C · On bg" },
  { id: "former", label: "Former" },
  { id: "darker", label: "A · Darker" },
  { id: "hairline", label: "B · Hairline" },
] as const;
type BubbleVariantId = (typeof BUBBLE_VARIANTS)[number]["id"];

export function TaskChatLab() {
  const [selected, setSelected] = useState<TaskChatStateId>("agent-message");
  const [bubbleVariant, setBubbleVariant] = useState<BubbleVariantId>("");
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [playToken, setPlayToken] = useState(0);
  const scenario = useMemo(() => buildScenario(selected), [selected]);
  const replayItems = useStreamingReplay(scenario.items, speed, playToken);
  const items = playing ? replayItems : scenario.items;
  const targetRef = useRef<HTMLDivElement>(null);

  const meta = TASK_CHAT_STATE_LIST.find((m) => m.id === selected)!;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-4 py-2">
        <h1 className="text-sm font-semibold">Task Chat Lab</h1>
        <p className="text-xs text-muted-foreground">
          Synthetic harness for the task chat redesign · every state renders here with no live agent.
        </p>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* State switcher */}
        <nav className="w-56 shrink-0 overflow-y-auto border-r border-border p-2" aria-label="States">
          {(["live", "tier-b"] as const).map((tier) => (
            <div key={tier} className="mb-3">
              <p className="mb-1 px-1 text-(length:--text-nano) font-semibold uppercase tracking-wide text-muted-foreground">
                {tier === "live" ? "Live states" : "Tier-B (synthetic)"}
              </p>
              <ul className="flex flex-col gap-0.5">
                {TASK_CHAT_STATE_LIST.filter((m) => m.tier === tier).map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      data-state-id={m.id}
                      onClick={() => {
                        setSelected(m.id);
                        setPlayToken((t) => t + 1);
                      }}
                      className={cn(
                        "w-full rounded px-2 py-1 text-left text-xs",
                        selected === m.id ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                      )}
                    >
                      {m.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* Stage */}
        <main className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs">
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className="flex items-center gap-1 rounded border border-border px-2 py-1 hover:bg-accent"
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {playing ? "Pause" : "Play"}
            </button>
            <button
              type="button"
              onClick={() => setPlayToken((t) => t + 1)}
              className="flex items-center gap-1 rounded border border-border px-2 py-1 hover:bg-accent"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Replay
            </button>
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">Speed</span>
              <input
                type="range"
                min={0.1}
                max={10}
                step={0.1}
                value={speed}
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                aria-label="Streaming speed"
                className="w-32"
              />
              <span className="w-10 tabular-nums">{speed.toFixed(1)}×</span>
            </label>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-muted-foreground">Agent bubble</span>
              <div className="flex items-center gap-0.5 rounded border border-border p-0.5" role="group" aria-label="Agent bubble treatment">
                {BUBBLE_VARIANTS.map((v) => (
                  <button
                    key={v.id || "current"}
                    type="button"
                    data-bubble-variant-id={v.id || "current"}
                    onClick={() => setBubbleVariant(v.id)}
                    className={cn(
                      "rounded px-2 py-0.5 text-(length:--text-micro)",
                      bubbleVariant === v.id ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                    )}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
              <span className="font-mono text-(length:--text-micro) text-muted-foreground">{meta.protocol}</span>
            </div>
          </div>

          <div
            ref={targetRef}
            className="flex min-h-0 flex-1 flex-col"
            data-testid="task-chat-stage"
            data-bubble-variant={bubbleVariant || undefined}
          >
            {scenario.surface === "plan" && scenario.plan ? (
              <div className="mx-auto max-w-2xl px-4">
                <TaskChatPlanView plan={scenario.plan} />
              </div>
            ) : (
              <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
                <TaskChatThreadView items={items} renderMessageActions={labMessageActions} />
              </div>
            )}
          </div>
        </main>
      </div>

      <TweakPanel />
    </div>
  );
}

export default TaskChatLab;
