import { useEffect, useId, useState } from "react";
import { Brain, Check, ChevronDown, ChevronRight, Pause, Play, RotateCcw, StepForward } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { TaskChatAgentIdentity } from "@/components/task-chat/TaskChatBubble";
import { toolActivityPresentation } from "@/components/task-chat/tool-taxonomy";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import "./runner-activity.css";

// Storybook-only presentation experiment. No production task feed imports this file.
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
type Group = { kind: "group"; id: string; items: Activity[]; active: boolean };

const entries: Entry[] = [
  { kind: "commentary", id: "intro", text: "I’ll check how the activity feed groups tool calls, then tighten up the layout and test it in the browser." },
  { kind: "activity", id: "think-1", target: "Checking the activity grouping", detail: "Looking at where commentary ends and tool activity begins." },
  { kind: "activity", id: "search", tool: "grep", target: "TaskChatRunnerTurn", detail: "Found the runner timeline and its activity rows in ui/src/components/task-chat/." },
  { kind: "activity", id: "read", tool: "read", target: "TaskChatActivityPhase.tsx", detail: "The activity phase owns expansion. Individual tool rows have separate icon widths and padding." },
  { kind: "activity", id: "mcp", tool: "mcp__github__get_pull_request", target: "paperclipai/paperclip · #13229", detail: "Read the previous task-feed performance changes to preserve stable row identity." },
  { kind: "commentary", id: "finding", text: "The icons use different gutters, and the tool list keeps growing between updates. I’ll use one aligned row that rolls forward as each new activity starts." },
  { kind: "activity", id: "think-2", target: "Keeping commentary visible", detail: "Each commentary message starts a new activity group. Expanding a group preserves its full history as more items arrive." },
  { kind: "activity", id: "edit", tool: "apply_patch", target: "RunnerActivityPreview.tsx", detail: "Added a common icon slot and a compact activity viewport. Expanded history uses the same alignment." },
  { kind: "activity", id: "test", tool: "exec_command", target: "pnpm check:token-gates", detail: "Token gates passed. No hardcoded visual values in the activity rows." },
  { kind: "commentary", id: "verification", text: "The compact view now stays the same height during tool calls. I’m checking long labels and the expanded view next." },
  { kind: "activity", id: "browser", tool: "exec_command", target: "Check light, dark, and narrow layouts", detail: "All icon centers align with their row centers. Both compact and expanded activity rows stay on one line." },
  { kind: "activity", id: "image", tool: "view_image", target: "runner-activity-mobile.png", detail: "Reviewed the narrow layout: tool paths truncate in both modes. Click a row to inspect its full target and detail." },
  { kind: "commentary", id: "final", text: "The preview is ready. Tool activity stays compact between each update, and you can expand any group to follow the full sequence." },
];

function groupEntries(visible: Entry[], finished: boolean): (Commentary | Group)[] {
  const result: (Commentary | Group)[] = [];
  for (const entry of visible) {
    if (entry.kind === "commentary") result.push(entry);
    else {
      const previous = result.at(-1);
      if (previous?.kind === "group") previous.items.push(entry);
      else result.push({ kind: "group", id: entry.id, items: [entry], active: false });
    }
  }
  const tail = result.at(-1);
  if (tail?.kind === "group") tail.active = !finished;
  return result;
}

function ActivityContent({ item, active }: { item: Activity; active: boolean }) {
  const presentation = item.tool ? toolActivityPresentation({ name: item.tool }) : null;
  const Icon = presentation?.icon ?? Brain;
  const label = presentation
    ? item.failed ? presentation.failedLabel : active ? presentation.runningLabel : presentation.completedLabel
    : active ? "Thinking" : "Thought";
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2" data-activity-row={item.id}>
      <span className="flex size-5 shrink-0 items-center justify-center" data-activity-icon>
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap">
        <span className={cn("shrink-0 text-xs", active && !item.failed && "text-foreground")}>{label}</span>
        <span title={item.target} className={cn("truncate text-xs text-muted-foreground", item.tool && "font-mono")}>
          {item.target}
        </span>
      </span>
    </span>
  );
}

function RollingActivity({ item, active }: { item: Activity; active: boolean }) {
  const reducedMotion = useReducedMotion();
  const [frame, setFrame] = useState({ current: item, previous: null as Activity | null });
  if (frame.current.id !== item.id) {
    setFrame({ current: item, previous: reducedMotion ? null : frame.current });
  }
  return (
    <span className="ra-viewport relative flex h-8 min-w-0 flex-1 items-center overflow-hidden" aria-live="polite" aria-atomic="true">
      {frame.previous && !reducedMotion ? (
        <span key={`exit-${item.id}`} className="ra-roll-out absolute inset-0 flex items-center" aria-hidden="true"
          onAnimationEnd={() => setFrame((current) => current.current.id === item.id ? { ...current, previous: null } : current)}>
          <ActivityContent item={frame.previous} active={false} />
        </span>
      ) : null}
      <span key={item.id} className={cn("relative flex w-full min-w-0 items-center", frame.previous && !reducedMotion && "ra-roll-in")}>
        <ActivityContent item={item} active={active} />
      </span>
    </span>
  );
}

function ExpandedActivity({ item, active }: { item: Activity; active: boolean }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const detailId = useId();
  return (
    <li className="min-w-0">
      <button type="button" className="ra-trigger flex h-8 w-full min-w-0 items-center gap-2 rounded-sm text-left text-muted-foreground"
        onClick={() => setDetailOpen(!detailOpen)} aria-expanded={detailOpen} aria-controls={detailId}>
        <ActivityContent item={item} active={active} />
        <ChevronRight className={cn("size-3.5 shrink-0", detailOpen && "rotate-90")} aria-hidden="true" />
      </button>
      {detailOpen ? <div id={detailId} className="flex min-w-0 flex-col gap-2 rounded-md bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground"><p className={cn("break-all", item.tool && "font-mono")}>{item.target}</p><p>{item.detail}</p></div> : null}
    </li>
  );
}

function ActivityGroup({ group, defaultExpanded }: { group: Group; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const historyId = useId();
  const latest = group.items.at(-1)!;
  const failures = group.items.filter((item) => item.failed).length;
  const countLabel = `${group.items.length} ${group.items.length === 1 ? "activity" : "activities"}`;
  return (
    <section className="min-w-0" data-activity-group={group.id} data-expanded={expanded}>
      <button type="button" className="ra-trigger flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm text-left text-muted-foreground"
        onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls={expanded ? historyId : undefined}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${countLabel}`}>
        {expanded ? (
          <span className="flex min-h-8 flex-1 items-center gap-2 text-xs">
            <span className="flex size-5 shrink-0 items-center justify-center"><ChevronDown className="size-3.5" aria-hidden="true" /></span>
            <span>{countLabel}</span>
          </span>
        ) : <RollingActivity item={latest} active={group.active} />}
        {failures > 0 ? <span className="shrink-0 text-xs text-muted-foreground">{failures} failed</span> : null}
        <span className="flex shrink-0 items-center gap-1 text-xs">
          {expanded ? "Collapse" : group.items.length}
          {!expanded ? <ChevronRight className="size-3.5" aria-hidden="true" /> : null}
        </span>
      </button>
      {expanded ? (
        <ol id={historyId} className="flex min-w-0 flex-col gap-1" aria-label="Activity history">
          {group.items.map((item, index) => <ExpandedActivity key={item.id} item={item} active={group.active && index === group.items.length - 1} />)}
        </ol>
      ) : null}
    </section>
  );
}

export interface RunnerActivityPreviewProps {
  initialStep?: number;
  autoPlay?: boolean;
  expanded?: boolean;
  narrow?: boolean;
  longLabels?: boolean;
  failed?: boolean;
}

export function RunnerActivityPreview({ initialStep = 3, autoPlay = true, expanded = false, narrow = false, longLabels = false, failed = false }: RunnerActivityPreviewProps) {
  const [step, setStep] = useState(initialStep);
  const [playing, setPlaying] = useState(autoPlay);
  const [replay, setReplay] = useState(0);
  const reducedMotion = useReducedMotion();
  const finished = step >= entries.length - 1;
  useEffect(() => {
    if (!playing || finished) return;
    // Fixture event cadence, not animation timing. All movement uses motion tokens.
    const timer = window.setTimeout(() => setStep((value) => Math.min(value + 1, entries.length - 1)), 2400);
    return () => window.clearTimeout(timer);
  }, [playing, finished, step]);
  const visible = entries.slice(0, step + 1).map((entry): Entry => {
    if (entry.kind !== "activity") return entry;
    return {
      ...entry,
      ...(longLabels && entry.tool ? { target: "ui/src/components/task-chat/transcript-adapter/native-runner-activity/very-long-file-name-without-convenient-breaks.test.tsx" } : {}),
      ...(failed && entry.id === "test" ? { failed: true, detail: "The layout check failed: the trailing icon moved below the label at narrow widths. The failure stays visible even after the next activity arrives." } : {}),
    };
  });
  const groups = groupEntries(visible, finished);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-sm font-semibold">Runner activity</h1>
          <p className="text-xs text-muted-foreground">Design preview · {reducedMotion ? "Reduced motion" : "One activity at a time"}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" disabled={finished} onClick={() => setPlaying(!playing)}>
            {playing && !finished ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{playing && !finished ? "Pause" : "Play"}
          </Button>
          <Button variant="ghost" size="sm" disabled={finished} onClick={() => { setPlaying(false); setStep((value) => Math.min(value + 1, entries.length - 1)); }}>
            <StepForward aria-hidden="true" />Next
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { setStep(1); setReplay((value) => value + 1); setPlaying(true); }}><RotateCcw aria-hidden="true" />Replay</Button>
        </div>
      </div>
      <main className={cn("mx-auto flex w-full flex-col gap-6 px-6 py-8", narrow ? "max-w-sm" : "max-w-3xl")}>
        <div className="self-end rounded-xl bg-muted px-4 py-3 text-sm">Can you clean up the runner’s activity feed?</div>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <TaskChatAgentIdentity agentName="Engineer" agentIcon="code" />
            <span className="flex items-center gap-1 text-xs text-muted-foreground">{finished ? <Check className="size-3.5" aria-hidden="true" /> : null}{finished ? "Worked for 28s" : "Working"}</span>
          </div>
          <div key={replay} className="flex min-w-0 flex-col gap-4">
            {groups.map((group) => group.kind === "commentary" ? (
              <div key={group.id} className="text-sm leading-relaxed" data-commentary={group.id}><MarkdownBody softBreaks>{group.text}</MarkdownBody></div>
            ) : <ActivityGroup key={group.id} group={group} defaultExpanded={expanded} />)}
          </div>
        </div>
      </main>
    </div>
  );
}
