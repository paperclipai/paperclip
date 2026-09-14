import { useEffect, useMemo, useState } from "react";
import { Pause, Play, RotateCcw, StepForward } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import { TaskChatExpansionState } from "@/components/task-chat/expansion-state";
import { buildTurnTimelineRows } from "@/components/task-chat/transcript-adapter";
import type {
  TaskChatItem,
  TaskChatMessageItem,
} from "@/components/task-chat/task-chat-model";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Deterministic event playback through the production runner turn.
type Activity = {
  kind: "activity";
  id: string;
  tool?: string;
  target: string;
  detail: string;
  failed?: boolean;
};
type Commentary = { kind: "commentary"; id: string; text: string };
type Entry = Activity | Commentary;

const entries: Entry[] = [
  {
    kind: "commentary",
    id: "intro",
    text: "I’ll check how the activity feed groups tool calls, then tighten up the layout and test it in the browser.",
  },
  {
    kind: "activity",
    id: "think-1",
    target: "Checking the activity grouping",
    detail: "Looking at where commentary ends and tool activity begins.",
  },
  {
    kind: "activity",
    id: "search",
    tool: "grep",
    target: "TaskChatRunnerTurn",
    detail:
      "Found the runner timeline and its activity rows in ui/src/components/task-chat/.",
  },
  {
    kind: "activity",
    id: "read",
    tool: "read",
    target: "TaskChatActivityPhase.tsx",
    detail:
      "The activity phase owns expansion. Individual tool rows have separate icon widths and padding.",
  },
  {
    kind: "activity",
    id: "mcp",
    tool: "mcp__github__get_pull_request",
    target: "paperclipai/paperclip · #13229",
    detail:
      "Read the previous task-feed performance changes to preserve stable row identity.",
  },
  {
    kind: "commentary",
    id: "finding",
    text: "The icons use different gutters, and the tool list keeps growing between updates. I’ll use one aligned row that rolls forward as each new activity starts.",
  },
  {
    kind: "activity",
    id: "think-2",
    target: "Keeping commentary visible",
    detail:
      "Each commentary message starts a new activity group. Expanding a group preserves its full history as more items arrive.",
  },
  {
    kind: "activity",
    id: "edit",
    tool: "apply_patch",
    target: "RunnerActivityPreview.tsx",
    detail:
      "Added a common icon slot and a compact activity viewport. Expanded history uses the same alignment.",
  },
  {
    kind: "activity",
    id: "test",
    tool: "exec_command",
    target: "pnpm check:token-gates",
    detail:
      "Token gates passed. No hardcoded visual values in the activity rows.",
  },
  {
    kind: "commentary",
    id: "verification",
    text: "The compact view now stays the same height during tool calls. I’m checking long labels and the expanded view next.",
  },
  {
    kind: "activity",
    id: "browser",
    tool: "exec_command",
    target: "Check light, dark, and narrow layouts",
    detail:
      "All icon centers align with their row centers. Both compact and expanded activity rows stay on one line.",
  },
  {
    kind: "activity",
    id: "image",
    tool: "view_image",
    target: "runner-activity-mobile.png",
    detail:
      "Reviewed the narrow layout: tool paths truncate in both modes. Click a row to inspect its full target and detail.",
  },
  {
    kind: "commentary",
    id: "final",
    text: "The preview is ready. Tool activity stays compact between each update, and you can expand any group to follow the full sequence.",
  },
];

export interface RunnerActivityPreviewProps {
  initialStep?: number;
  autoPlay?: boolean;
  expanded?: boolean;
  narrow?: boolean;
  longLabels?: boolean;
  failed?: boolean;
}

export function RunnerActivityPreview({
  initialStep = 3,
  autoPlay = true,
  expanded = false,
  narrow = false,
  longLabels = false,
  failed = false,
}: RunnerActivityPreviewProps) {
  const [step, setStep] = useState(initialStep);
  const [playing, setPlaying] = useState(autoPlay);
  const [replay, setReplay] = useState(0);
  const reducedMotion = useReducedMotion();
  const finished = step >= entries.length - 1;
  useEffect(() => {
    if (!playing || finished) return;
    // Fixture event cadence, not animation timing. All movement uses motion tokens.
    const timer = window.setTimeout(
      () => setStep((value) => Math.min(value + 1, entries.length - 1)),
      2400,
    );
    return () => window.clearTimeout(timer);
  }, [playing, finished, step]);
  const visible = entries.slice(0, step + 1).map((entry): Entry => {
    if (entry.kind !== "activity") return entry;
    return {
      ...entry,
      ...(longLabels && entry.tool
        ? {
            target:
              "ui/src/components/task-chat/transcript-adapter/native-runner-activity/very-long-file-name-without-convenient-breaks.test.tsx",
          }
        : {}),
      ...(failed && entry.id === "test"
        ? {
            failed: true,
            detail:
              "The layout check failed: the trailing icon moved below the label at narrow widths. The output stays available in expanded history after the next activity arrives.",
          }
        : {}),
    };
  });
  const memory = useMemo(() => new Map<string, boolean>(), [replay]);
  const items = visible.map((entry, index): TaskChatItem => {
    if (entry.kind === "commentary")
      return {
        kind: "message",
        id: entry.id,
        author: "agent",
        text: entry.text,
        channel: entry.id === "final" ? "final" : "progress",
        interstitial: entry.id !== "final",
      };
    const active = !finished && index === visible.length - 1;
    if (!entry.tool)
      return {
        kind: "thinking",
        id: entry.id,
        lines: [entry.target, entry.detail],
        streaming: active,
      };
    return {
      kind: "tool",
      id: entry.id,
      name: entry.tool,
      target: entry.target,
      detail: entry.detail,
      status: entry.failed ? "failed" : active ? "in_progress" : "completed",
    };
  });
  if (expanded)
    for (const row of buildTurnTimelineRows(items, !finished)) {
      if (row.kind === "activity_phase" && !memory.has(row.id))
        memory.set(row.id, true);
    }
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-sm font-semibold">Runner activity</h1>
          <p className="text-xs text-muted-foreground">
            Production component ·{" "}
            {reducedMotion ? "Reduced motion" : "One activity at a time"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={finished}
            onClick={() => setPlaying(!playing)}
          >
            {playing && !finished ? (
              <Pause aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
            {playing && !finished ? "Pause" : "Play"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={finished}
            onClick={() => {
              setPlaying(false);
              setStep((value) => Math.min(value + 1, entries.length - 1));
            }}
          >
            <StepForward aria-hidden="true" />
            Next
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStep(1);
              setReplay((value) => value + 1);
              setPlaying(true);
            }}
          >
            <RotateCcw aria-hidden="true" />
            Replay
          </Button>
        </div>
      </div>
      <main
        className={cn(
          "mx-auto flex w-full flex-col gap-6 px-6 py-8",
          narrow ? "max-w-sm" : "max-w-3xl",
        )}
      >
        <div className="self-end rounded-xl bg-muted px-4 py-3 text-sm">
          Can you clean up the runner’s activity feed?
        </div>
        <TaskChatExpansionState.Provider key={replay} value={memory}>
          {finished ? (
            <TaskChatThreadView
              scroll={false}
              items={[
                {
                  id: "preview-saved-turn",
                  kind: "turn",
                  settled: true,
                  standaloneHeader: true,
                  agentName: "Engineer",
                  agentIcon: "code",
                  items: buildTurnTimelineRows(items, false),
                  summary: {
                    durationLabel: "28s",
                    toolCount: 8,
                    added: 0,
                    removed: 0,
                  },
                  finalResponse: items.find(
                    (item): item is TaskChatMessageItem =>
                      item.kind === "message" && item.channel === "final",
                  ),
                },
              ]}
            />
          ) : (
            <TaskChatRunnerTurn
              runId={`preview-${replay}`}
              agentName="Engineer"
              agentIcon="code"
              items={items}
              status={finished ? "succeeded" : "running"}
              startedAtMs={null}
            />
          )}
        </TaskChatExpansionState.Provider>
      </main>
    </div>
  );
}
