import { useEffect, useState } from "react";
import { Pause, Play, RotateCcw, StepForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  TaskChatActivityPhaseItem,
  TaskChatToolItem,
} from "@/components/task-chat/task-chat-model";
import { TaskChatRunnerActivityGroup as CompletedActivityGroup } from "@/components/task-chat/TaskChatRunnerActivityGroup";

type Activity = TaskChatActivityPhaseItem["items"][number];
const tool = (
  id: string,
  name: string,
  target: string,
  status: TaskChatToolItem["status"] = "completed",
  detail = "Completed.",
): TaskChatToolItem => ({ kind: "tool", id, name, target, status, detail });
const read = tool(
  "read",
  "read",
  "ui/src/components/task-chat/TaskChatRunnerActivityGroup.tsx",
  "completed",
  "Read the activity group renderer.",
);
const command = tool(
  "command",
  "exec_command",
  "pnpm --filter @paperclipai/ui typecheck",
  "completed",
  "Typecheck passed.",
);
const retry = tool(
  "retry",
  "exec_command",
  "/bin/bash -lc 'curl --fail http://127.0.0.1:6025/'",
  "failed",
  "curl: (7) Could not connect to server. The preview was still starting.",
);
const recovered = tool(
  "recovered",
  "exec_command",
  "curl --fail http://127.0.0.1:6025/",
  "completed",
  "HTTP 200. The preview is now reachable.",
);
const thought: Activity = {
  kind: "thinking",
  id: "thought",
  lines: ["Checking how completed groups read between commentary messages."],
};
const search = tool(
  "search",
  "grep",
  "activity_phase",
  "completed",
  "Found the activity grouping code.",
);
const edit = tool(
  "edit",
  "apply_patch",
  "ui/storybook/prototypes/completed-activity/CompletedActivityGroup.tsx",
  "completed",
  "Updated the completed summary.",
);
const web: Activity = {
  kind: "protocol",
  id: "web",
  surface: "provider_activity",
  family: "research",
  eventType: "research.completed",
  status: "completed",
  title: "Web search",
  summary: "Accessible activity disclosures",
  details: [{ label: "Query", value: "accessible disclosure patterns" }],
  steps: [],
  links: [],
  children: [],
};

const scenarios: Array<{
  id: string;
  title: string;
  note: string;
  items: Activity[];
}> = [
  {
    id: "commands",
    title: "Commands only",
    note: "Repeated commands become one phrase, with no shell text in the collapsed row.",
    items: [command, retry, recovered],
  },
  {
    id: "mixed",
    title: "Files and commands",
    note: "Reading plus execution stays specific. Thoughts and usage do not crowd out the useful actions.",
    items: [thought, read, command],
  },
  {
    id: "single",
    title: "One activity",
    note: "The same quiet category wording works for one file or many files.",
    items: [read],
  },
  {
    id: "recovery",
    title: "Retry followed by recovery",
    note: "No failure count or warning badge. Expand to inspect the first attempt and its output.",
    items: [retry, recovered],
  },
  {
    id: "unsuccessful",
    title: "Commands end without success",
    note: "“Ran commands” describes what happened; it does not say the commands passed.",
    items: [
      retry,
      {
        ...command,
        status: "failed",
        detail:
          "Command exited with code 1. The configuration needs attention.",
      },
    ],
  },
  {
    id: "edits",
    title: "An edit did not complete",
    note: "Use “Worked on files” when no edit completed, rather than claiming files were changed.",
    items: [
      {
        ...edit,
        status: "failed",
        detail:
          "The patch did not apply because the surrounding lines changed.",
      },
    ],
  },
  {
    id: "interrupted",
    title: "Stopped partway through",
    note: "Describe the actions taken. Task-level commentary explains why work stopped.",
    items: [
      read,
      {
        ...command,
        status: "interrupted",
        detail: "Stopped at the user’s request.",
      },
    ],
  },
  {
    id: "research",
    title: "Web research",
    note: "Provider-native events get the same human summary as ordinary tools.",
    items: [thought, web],
  },
  {
    id: "many",
    title: "Several kinds of work",
    note: "Keep the row short with “and more”; the full description is available on hover and all activity remains expandable.",
    items: [
      read,
      command,
      search,
      edit,
      web,
      tool(
        "mcp",
        "mcp__github__get_pull_request",
        "paperclipai/paperclip #13255",
      ),
    ],
  },
  {
    id: "thought",
    title: "Thoughts only",
    note: "No invented tool activity when the agent only reasoned about the task.",
    items: [thought],
  },
  {
    id: "unknown",
    title: "Unrecognized tool",
    note: "Fall back to “Used tools” without exposing internal identifiers.",
    items: [tool("unknown", "custom_worker_v2", "opaque-operation-8792")],
  },
];
function phase(
  id: string,
  items: Activity[],
  active = false,
): TaskChatActivityPhaseItem {
  return { id, kind: "activity_phase", items, active, summary: "" };
}

export function CompletedActivityPreview({
  mode = "conversation",
  narrow = false,
  expanded = false,
  autoPlay = true,
}: {
  mode?: "conversation" | "gallery" | "live";
  narrow?: boolean;
  expanded?: boolean;
  autoPlay?: boolean;
}) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(autoPlay);
  const [replay, setReplay] = useState(0);
  useEffect(() => {
    if (mode !== "live" || !playing || step >= 4) return;
    // Fixture cadence; row motion uses the existing production motion tokens.
    const timer = window.setTimeout(() => setStep((s) => s + 1), 2200);
    return () => window.clearTimeout(timer);
  }, [mode, playing, step]);
  const liveItems: Activity[] =
    step === 0
      ? [{ ...read, status: "in_progress" }]
      : step === 1
        ? [read, { ...retry, status: "in_progress" }]
        : step === 2
          ? [read, retry, { ...recovered, status: "in_progress" }]
          : [read, retry, recovered];
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-sm font-semibold">Completed activity</h1>
          <p className="text-xs text-muted-foreground">
            Completed activity · expand any summary to inspect its history
          </p>
        </div>
        {mode === "live" && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={step >= 4}
              onClick={() => setPlaying(!playing)}
            >
              {playing && step < 4 ? <Pause /> : <Play />}
              {playing && step < 4 ? "Pause" : "Play"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={step >= 4}
              onClick={() => {
                setPlaying(false);
                setStep((s) => s + 1);
              }}
            >
              <StepForward />
              Next
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStep(0);
                setReplay((r) => r + 1);
                setPlaying(true);
              }}
            >
              <RotateCcw />
              Replay
            </Button>
          </div>
        )}
      </header>
      <main
        key={replay}
        className={cn(
          "mx-auto flex w-full flex-col gap-6 px-6 py-8",
          narrow ? "max-w-sm" : "max-w-3xl",
        )}
      >
        {mode === "gallery" ? (
          scenarios.map((scenario) => (
            <section key={scenario.id} className="flex min-w-0 flex-col gap-2">
              <h2 className="text-sm font-medium">{scenario.title}</h2>
              <p className="text-xs text-muted-foreground">{scenario.note}</p>
              <CompletedActivityGroup
                item={phase(scenario.id, scenario.items)}
                defaultExpanded={expanded}
              />
            </section>
          ))
        ) : mode === "live" ? (
          <>
            <p className="text-sm">
              I’ll read the activity component, then check that the preview is
              reachable.
            </p>
            <CompletedActivityGroup
              item={phase("live-group", liveItems, step < 3)}
              defaultExpanded={expanded}
            />
            {step >= 3 && (
              <p className="text-sm">
                The preview is reachable. The first request arrived before the
                server was ready; the next one connected.
              </p>
            )}
            {step >= 3 && (
              <CompletedActivityGroup
                item={phase(
                  "next-group",
                  [
                    {
                      ...command,
                      status: step === 3 ? "in_progress" : "completed",
                    },
                  ],
                  step === 3,
                )}
                defaultExpanded={expanded}
              />
            )}
            {step === 4 && (
              <p className="text-sm">
                Typecheck passed. The preview is ready for review.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-sm">
              I’ll check the activity renderer and the surrounding task layout.
            </p>
            <CompletedActivityGroup
              item={phase("conversation-1", [thought, read, search])}
              defaultExpanded={expanded}
            />
            <p className="text-sm">
              The grouping is already in place. I’m updating how each group
              reads after its work is done.
            </p>
            <CompletedActivityGroup
              item={phase("conversation-2", [edit, command])}
              defaultExpanded={expanded}
            />
            <p className="text-sm">
              The preview took a moment to start. I’ll check the address again.
            </p>
            <CompletedActivityGroup
              item={phase("conversation-3", [retry, recovered])}
              defaultExpanded={expanded}
            />
            <p className="text-sm">
              The preview is ready. Completed groups now describe the work in a
              few words, and you can expand any group for the full details.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
