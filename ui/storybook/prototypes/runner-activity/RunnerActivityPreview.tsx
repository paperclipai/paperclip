import { useEffect, useMemo, useState } from "react";
import { Pause, Play, RotateCcw, StepForward } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import { TaskChatLiveTail } from "@/components/task-chat/TaskChatLiveTail";
import { TaskChatLiveRunPill, toolCountSummaryFromEntries } from "@/components/task-chat/TaskChatLiveRunPill";
import { TaskChatExpansionState } from "@/components/task-chat/expansion-state";
import { buildTurnTimelineRows, transcriptToTaskChatItems } from "@/components/task-chat/transcript-adapter";
import type { TranscriptEntry } from "@/adapters";
import type {
  TaskChatItem,
  TaskChatMessageItem,
  TaskChatTurnItem,
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
    target: "TaskChatRunnerActivityGroup.tsx",
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
    tool: "image_generation",
    target: "runner-activity-mobile.png",
    detail:
      "Generated an image to check the activity feed’s image-tool label and icon.",
  },
  {
    kind: "commentary",
    id: "final",
    text: "The preview is ready. Tool activity stays compact between each update, and you can expand any group to follow the full sequence.",
  },
];

// Exercise the CLI transcript adapter, including provider names, stable call IDs,
// multi-line reasoning, and tool results, before entering the legacy live path.
function legacyTranscript(visible: Entry[], finished: boolean): TranscriptEntry[] {
  const ts = "2026-09-15T12:00:00.000Z";
  return visible.flatMap((entry, index): TranscriptEntry[] => {
    if (entry.kind === "commentary") return [{
      kind: "assistant", ts, itemId: entry.id, text: entry.text,
      channel: entry.id === "final" ? "final" : "progress",
    }];
    const active = !finished && index === visible.length - 1;
    if (!entry.tool) return [{
      kind: "thinking", ts, itemId: entry.id,
      text: `${entry.target}\n${entry.detail}`,
      lifecycle: active ? "started" : "completed",
    }];
    const name = entry.tool === "read" ? "Read" : entry.tool;
    const input = entry.tool === "exec_command"
      ? { command: entry.target }
      : { file_path: entry.target };
    const call: TranscriptEntry = {
      kind: "tool_call", ts, name, toolUseId: entry.id, input,
    };
    return active && !entry.failed ? [call] : [call, {
      kind: "tool_result", ts, toolUseId: entry.id,
      content: entry.detail, isError: Boolean(entry.failed),
    }];
  });
}

export interface RunnerActivityPreviewProps {
  initialStep?: number;
  autoPlay?: boolean;
  expanded?: boolean;
  narrow?: boolean;
  longLabels?: boolean;
  failed?: boolean;
  legacy?: boolean;
}

export function RunnerActivityPreview({
  initialStep = 3,
  autoPlay = true,
  expanded = false,
  narrow = false,
  longLabels = false,
  failed = false,
  legacy = false,
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
  const transcript = legacyTranscript(visible, finished);
  const items = legacy
    ? transcriptToTaskChatItems(transcript, { runId: `legacy-${replay}`, running: !finished })
    : visible.map((entry, index): TaskChatItem => {
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
  const finalResponse = items.find(
    (item): item is TaskChatMessageItem => item.kind === "message" && item.channel === "final",
  );
  const savedTurn: TaskChatTurnItem = {
    id: "preview-saved-turn",
    kind: "turn",
    settled: true,
    standaloneHeader: !legacy,
    agentName: "Engineer",
    agentIcon: "code",
    items: buildTurnTimelineRows(items, false),
    summary: {
      durationLabel: "28s",
      toolCount: items.filter((item) => item.kind === "tool").length,
      added: 0,
      removed: 0,
    },
    finalResponse: legacy ? undefined : finalResponse,
  };
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-sm font-semibold">Runner activity</h1>
          <p className="text-xs text-muted-foreground">
            {legacy ? "Legacy CLI transcript" : "Native runner"} ·{" "}
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
              items={legacy && finalResponse
                ? [{ ...finalResponse, attachedTurn: savedTurn }]
                : [savedTurn]}
            />
          ) : legacy ? (
            <div className="flex flex-col gap-2" data-testid="legacy-live-preview">
              <TaskChatLiveRunPill
                status="running"
                startedAtMs={null}
                toolSummary={toolCountSummaryFromEntries(transcript)}
              />
              <TaskChatLiveTail items={items} />
            </div>
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
