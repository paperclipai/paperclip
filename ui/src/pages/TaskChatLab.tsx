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
import { TweakPanel } from "@/components/task-chat/TweakPanel";
import type { TaskChatItem } from "@/components/task-chat/task-chat-model";

/** Progressively reveal any streaming message/thinking text at `speed`. */
function useStreamingReplay(
  baseItems: TaskChatItem[],
  speed: number,
  playToken: number,
): TaskChatItem[] {
  const [chars, setChars] = useState<number>(Number.MAX_SAFE_INTEGER);
  const streamingIndex = baseItems.findIndex(
    (i) => (i.kind === "message" && i.streaming) || (i.kind === "thinking" && i.streaming),
  );
  const fullText = useMemo(() => {
    const it = baseItems[streamingIndex];
    if (!it) return "";
    if (it.kind === "message") return it.text;
    if (it.kind === "thinking") return it.lines.join("\n");
    return "";
  }, [baseItems, streamingIndex]);

  useEffect(() => {
    if (streamingIndex < 0) {
      setChars(Number.MAX_SAFE_INTEGER);
      return;
    }
    setChars(0);
    let n = 0;
    const baseIntervalMs = 24;
    const interval = window.setInterval(() => {
      n += 1;
      setChars(n);
      if (n >= fullText.length) window.clearInterval(interval);
    }, Math.max(4, baseIntervalMs / speed));
    return () => window.clearInterval(interval);
  }, [streamingIndex, fullText, speed, playToken]);

  if (streamingIndex < 0) return baseItems;
  return baseItems.map((it, idx) => {
    if (idx !== streamingIndex) return it;
    const shown = fullText.slice(0, chars);
    const done = chars >= fullText.length;
    if (it.kind === "message") return { ...it, text: shown, streaming: !done };
    if (it.kind === "thinking") return { ...it, lines: shown.split("\n"), streaming: !done };
    return it;
  });
}

/**
 * Dev harness for the Task Chat Redesign (route: /dev/task-chat-lab, behind the
 * enableTaskChatRedesign flag). Drives the render layer into every inventory
 * state via synthetic events — no live agent — and is also the human's
 * post-baseline iteration cockpit: state switcher, streaming replay, a
 * 0.1×–10× speed control, and the live motion tweak panel.
 */
export function TaskChatLab() {
  const [selected, setSelected] = useState<TaskChatStateId>("agent-message");
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
            <span className="ml-auto font-mono text-(length:--text-micro) text-muted-foreground">{meta.protocol}</span>
          </div>

          <div ref={targetRef} className="flex min-h-0 flex-1 flex-col" data-testid="task-chat-stage">
            {scenario.surface === "plan" && scenario.plan ? (
              <div className="mx-auto max-w-2xl px-4">
                <TaskChatPlanView plan={scenario.plan} />
              </div>
            ) : (
              <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
                <TaskChatThreadView items={items} />
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
