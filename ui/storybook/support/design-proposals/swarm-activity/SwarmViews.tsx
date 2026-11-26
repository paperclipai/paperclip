import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Hourglass, Info, MessageSquare, ShieldCheck, Square, TriangleAlert, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusGlyph } from "@/components/StatusGlyph";
import { TaskChatRunnerHeader } from "@/components/task-chat/TaskChatRunnerTurn";
import { TaskChatSubagentTree, type TaskChatSubagent, type TaskChatSubagentStatus } from "@/components/task-chat/TaskChatSubagentCard";
import { TaskChatExpansionState } from "@/components/task-chat/expansion-state";
import { cn } from "@/lib/utils";
import {
  SOURCE_DETAIL,
  SOURCE_LABEL,
  plainPost,
  progressLine,
  swarmProgress,
  threadCount,
  threadNow,
  threadState,
  type HelperState,
  type SwarmHelper,
  type SwarmPost,
  type SwarmSource,
  type SwarmStatus,
  type SwarmView,
} from "./swarm-model";

const STATE_LABEL: Record<HelperState, string> = {
  starting: "Starting",
  working: "Working",
  waiting: "Standing by",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  stopped: "Stopped",
};

const STATE_GLYPH: Record<HelperState, string> = {
  starting: "backlog",
  working: "in_progress",
  waiting: "todo",
  in_review: "in_review",
  done: "done",
  blocked: "blocked",
  stopped: "cancelled",
};

const STATUS_LABEL: Record<SwarmStatus, string> = {
  starting: "Starting the swarm",
  running: "Swarm working",
  stopping: "Stopping the swarm",
  stopped: "Swarm stopped",
  failed: "Swarm failed",
  refused: "Swarm not available",
  completed: "Swarm finished",
};

const STATUS_GLYPH: Record<SwarmStatus, string> = {
  starting: "backlog",
  running: "in_progress",
  stopping: "in_progress",
  stopped: "cancelled",
  failed: "blocked",
  refused: "blocked",
  completed: "done",
};

export function SourceTag({ source, show = true }: { source: SwarmSource; show?: boolean }) {
  if (!show) return null;
  return (
    <Badge variant="outline" className={cn("font-normal text-muted-foreground", source === "google" && "border-dashed")} title={SOURCE_DETAIL[source]} data-swarm-source={source}>
      {SOURCE_LABEL[source]}
    </Badge>
  );
}

export function SourceLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label="Where each part comes from">
      {(Object.keys(SOURCE_LABEL) as SwarmSource[]).map((source) => (
        <span key={source} className="flex items-center gap-1.5">
          <SourceTag source={source} />
          <span>{SOURCE_DETAIL[source]}</span>
        </span>
      ))}
    </div>
  );
}

function SectionTitle({ children, source, annotate }: { children: ReactNode; source?: SwarmSource; annotate?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">{children}</span>
      {source ? <SourceTag source={source} show={annotate} /> : null}
    </div>
  );
}

function HelperStateLabel({ state }: { state: HelperState }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <StatusGlyph status={STATE_GLYPH[state]} size="sm" />
      <span className={cn(state === "blocked" && "text-(--status-task-icon-blocked)")}>{STATE_LABEL[state]}</span>
    </span>
  );
}

function HelperName({ name }: { name: string }) {
  return <span className="shrink-0 rounded-sm bg-muted px-1.5 font-mono text-xs text-muted-foreground">{name}</span>;
}

export function HelperRow({ helper, showModel }: { helper: SwarmHelper; showModel?: boolean }) {
  return (
    <li className="flex min-w-0 items-start gap-2 py-1.5" data-swarm-helper={helper.name}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <HelperName name={helper.name} />
          <span className="min-w-0 truncate text-sm text-foreground">{helper.task}</span>
        </span>
        {helper.action ? (
          <span className={cn("min-w-0 truncate text-xs text-muted-foreground", helper.state === "working" && "shimmer-text", helper.state === "blocked" && "text-(--status-task-icon-blocked)")}>{helper.action}</span>
        ) : null}
        {showModel && (helper.model || helper.tokens) ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {[helper.model, helper.tokens ? `${helper.tokens.input.toLocaleString()} in · ${helper.tokens.output.toLocaleString()} out` : null].filter(Boolean).join(" · ")}
          </span>
        ) : null}
      </span>
      <HelperStateLabel state={helper.state} />
    </li>
  );
}

const POST_TONE: Record<SwarmPost["kind"], string> = {
  brief: "text-muted-foreground",
  done: "text-foreground",
  update: "text-foreground",
  blocked: "text-(--status-task-icon-blocked)",
  stall: "text-(--status-task-icon-todo)",
  finish: "text-foreground",
};

const POST_LABEL: Partial<Record<SwarmPost["kind"], string>> = {
  brief: "Brief",
  done: "Done",
  blocked: "Blocked",
  stall: "Stalled",
  finish: "Finished",
};

export function MessageFeed({ posts, limit, hideBriefs }: { posts: SwarmPost[]; limit?: number; hideBriefs?: boolean }) {
  const visible = (hideBriefs ? posts.filter((post) => post.kind !== "brief") : posts);
  const shown = limit ? visible.slice(-limit) : visible;
  return (
    <ol className="flex min-w-0 flex-col gap-1" aria-label="Swarm messages">
      {shown.map((post) => (
        <li key={post.seq} className="flex min-w-0 items-baseline gap-2 text-sm" data-swarm-post={post.seq}>
          <span className="w-7 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">#{post.seq}</span>
          <span className="min-w-0 flex-1">
            <span className="font-mono text-xs text-muted-foreground">{post.author}</span>
            {POST_LABEL[post.kind] ? <span className={cn("ml-1.5 text-xs", POST_TONE[post.kind])}>{POST_LABEL[post.kind]}</span> : null}
            <span className={cn("block truncate", POST_TONE[post.kind])} title={plainPost(post.text)}>{plainPost(post.text)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ProgressSegments({ view }: { view: SwarmView }) {
  const workers = view.helpers.filter((helper) => helper.role !== "monitor");
  if (!workers.length) return null;
  return (
    <div className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
      {workers.map((helper) => (
        <span
          key={helper.name}
          className={cn(
            "h-full flex-1",
            helper.state === "done" && "bg-(--status-task-icon-done)",
            helper.state === "in_review" && "bg-(--status-task-icon-in_review)",
            helper.state === "working" && "bg-(--status-agent-running)",
            helper.state === "blocked" && "bg-(--status-task-icon-blocked)",
            (helper.state === "waiting" || helper.state === "starting" || helper.state === "stopped") && "bg-border",
          )}
        />
      ))}
    </div>
  );
}

export function ThreadList({ view, annotate }: { view: SwarmView; annotate?: boolean }) {
  if (!view.threads.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle source="live" annotate={annotate}>Threads</SectionTitle>
        {annotate ? <span className="text-xs text-muted-foreground">state, count and Now line:</span> : null}
        <SourceTag source="files" show={annotate} />
      </div>
      <ul className="flex min-w-0 flex-col gap-1">
        {view.threads.map((thread) => {
          const state = threadState(view, thread);
          return (
            <li key={thread.id} className="flex min-w-0 items-start gap-2 rounded-md border border-border px-2.5 py-1.5">
              <StatusGlyph status={STATE_GLYPH[state]} size="sm" className="mt-0.5" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="min-w-0 truncate text-foreground">{thread.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{threadCount(view, thread)}</span>
                </span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">Now: {threadNow(view, thread)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Notice({ icon: Icon, children, tone = "muted" }: { icon: typeof Info; children: ReactNode; tone?: "muted" | "danger" | "warning" }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs", tone === "muted" && "text-muted-foreground", tone === "danger" && "text-(--status-task-icon-blocked)", tone === "warning" && "text-(--status-task-icon-todo)")}>
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function SwarmNotes({ view }: { view: SwarmView }) {
  return (
    <div className="flex flex-col gap-1">
      {view.status !== "refused" ? <Notice icon={ShieldCheck}>Helper changes inside the task folder were approved automatically; anything else is blocked.</Notice> : null}
      {view.reason ? <Notice icon={view.status === "stopped" ? Square : TriangleAlert} tone={view.status === "stopped" ? "muted" : "danger"}>{view.reason}</Notice> : null}
      {view.status === "stopping" ? <Notice icon={Hourglass}>Stopping the coordinator and its helpers. Files already written stay in the task folder.</Notice> : null}
      {view.files ? <Notice icon={Info}>Files changed in the task folder: {view.files.join(", ")}</Notice> : null}
      {view.usage ? <Notice icon={Info}>The coordinator used {view.usage.total.toLocaleString()} tokens.{view.usage.helpers ? ` The helpers used ${view.usage.helpers.input.toLocaleString()} in and ${view.usage.helpers.output.toLocaleString()} out more, read from the swarm's files.` : ""}</Notice> : null}
    </div>
  );
}

function subagentStatus(helper: SwarmHelper, view: SwarmView): TaskChatSubagentStatus {
  if (helper.state === "done") return "completed";
  if (helper.state === "blocked") return "failed";
  if (helper.state === "stopped" || view.status === "stopped" || view.status === "failed") return "cancelled";
  return "running";
}

function toSubagent(helper: SwarmHelper, view: SwarmView): TaskChatSubagent {
  const lastPost = [...view.posts].reverse().find((post) => post.author === helper.name && post.kind !== "brief");
  return {
    id: `swarm-${helper.name}`,
    agentType: helper.name,
    prompt: helper.brief,
    model: helper.model,
    status: subagentStatus(helper, view),
    description: helper.task,
    progressSummary: helper.state === "in_review" ? "Waiting for the verifier" : helper.state === "waiting" ? `Standing by${helper.action ? ` · ${helper.action}` : ""}` : helper.action,
    activity: [],
    result: lastPost ? plainPost(lastPost.text) : undefined,
  };
}

export function SwarmTurn({ view, children }: { view: SwarmView; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col" data-testid="swarm-turn">
      <TaskChatRunnerHeader
        runId="swarm-story"
        agentName="Antigravity"
        agentIcon="code"
        status={view.status === "running" ? "running" : "succeeded"}
        startedAtMs={null}
        statusContent={
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusGlyph status={STATUS_GLYPH[view.status]} size="sm" />
            {STATUS_LABEL[view.status]}
          </span>
        }
      />
      <div className="flex min-w-0 flex-col gap-2 py-1">{children}</div>
    </div>
  );
}

export function GoalBlock({ view, annotate }: { view: SwarmView; annotate?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 text-sm font-medium text-foreground">{view.goal.title}</span>
        <SourceTag source="live" show={annotate} />
      </div>
      <span className="text-xs text-muted-foreground">{view.goal.line}</span>
    </div>
  );
}

export function ProgressBlock({ view, annotate }: { view: SwarmView; annotate?: boolean }) {
  if (!view.helpers.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="tabular-nums">{progressLine(view)}</span>
        <SourceTag source="files" show={annotate} />
      </div>
      <ProgressSegments view={view} />
    </div>
  );
}

export function InlineDirection({ view, annotate = true }: { view: SwarmView; annotate?: boolean }) {
  const memory = useMemo(() => new Map<string, boolean>(), []);
  const blocked = view.helpers.filter((helper) => helper.state === "blocked");
  const subagents = view.helpers.filter((helper) => helper.role !== "monitor" && helper.state !== "blocked").map((helper) => toSubagent(helper, view));
  const messages = view.posts.filter((post) => post.kind !== "brief");
  return (
    <TaskChatExpansionState.Provider value={memory}>
      <SwarmTurn view={view}>
        <GoalBlock view={view} annotate={annotate} />
        <ProgressBlock view={view} annotate={annotate} />
        {blocked.length ? (
          <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-1" data-testid="swarm-blocked-helpers">
            <SectionTitle source="files" annotate={annotate}>Needs attention</SectionTitle>
            <ul className="flex min-w-0 flex-col divide-y divide-border">{blocked.map((helper) => <HelperRow key={helper.name} helper={helper} />)}</ul>
          </div>
        ) : null}
        {subagents.length ? (
          <div className="flex min-w-0 flex-col gap-1">
            <SectionTitle source="files" annotate={annotate}>Helpers, their current step and state</SectionTitle>
            <TaskChatSubagentTree subagents={subagents} />
          </div>
        ) : null}
        {messages.length ? (
          <details className="group min-w-0 rounded-lg border border-border bg-card px-3 py-2">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight className="size-3.5 shrink-0 group-open:rotate-90" aria-hidden />
              <MessageSquare className="size-3.5" aria-hidden />
              {messages.length} {messages.length === 1 ? "message" : "messages"} between helpers
              <SourceTag source="files" show={annotate} />
            </summary>
            <div className="pt-2"><MessageFeed posts={view.posts} hideBriefs /></div>
          </details>
        ) : null}
        <SwarmNotes view={view} />
      </SwarmTurn>
    </TaskChatExpansionState.Provider>
  );
}

export function SidePanel({ view, annotate = true, defaultTab = "overview", googleExtras }: { view: SwarmView; annotate?: boolean; defaultTab?: string; googleExtras?: ReactNode }) {
  const active = view.helpers.filter((helper) => helper.state === "working" || helper.state === "blocked");
  return (
    <aside className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-3" aria-label="Swarm">
      <div className="flex min-w-0 items-center gap-2">
        <Users className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{view.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <StatusGlyph status={STATUS_GLYPH[view.status]} size="sm" />
          {STATUS_LABEL[view.status]}
        </span>
      </div>
      <Tabs defaultValue={defaultTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="helpers">Helpers {view.helpers.length}</TabsTrigger>
          <TabsTrigger value="messages">Messages {view.posts.length}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="flex min-w-0 flex-col gap-3 pt-1">
          <GoalBlock view={view} annotate={annotate} />
          <ProgressBlock view={view} annotate={annotate} />
          {active.length ? (
            <div className="flex min-w-0 flex-col">
              <SectionTitle source="files" annotate={annotate}>Running {active.length}</SectionTitle>
              <ul className="flex min-w-0 flex-col divide-y divide-border">{active.map((helper) => <HelperRow key={helper.name} helper={helper} />)}</ul>
            </div>
          ) : null}
          <ThreadList view={view} annotate={annotate} />
          <SwarmNotes view={view} />
        </TabsContent>
        <TabsContent value="helpers" className="flex min-w-0 flex-col gap-1 pt-1">
          <SectionTitle source="files" annotate={annotate}>Coordinator and {view.helpers.length} helpers</SectionTitle>
          <ul className="flex min-w-0 flex-col divide-y divide-border">
            <li className="flex min-w-0 items-center gap-2 py-1.5"><HelperName name="coordinator" /><span className="text-sm text-foreground">Splits the work and checks results</span></li>
            {view.helpers.map((helper) => <HelperRow key={helper.name} helper={helper} showModel />)}
          </ul>
          {googleExtras}
        </TabsContent>
        <TabsContent value="messages" className="flex min-w-0 flex-col gap-1 pt-1">
          <SectionTitle source="files" annotate={annotate}>Message board</SectionTitle>
          <MessageFeed posts={view.posts} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

export function SummaryCard({ view, annotate = true, defaultOpen = false }: { view: SwarmView; annotate?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const progress = swarmProgress(view);
  const focus = view.helpers.filter((helper) => helper.state === "blocked" || helper.state === "working").slice(0, 3);
  const latest = [...view.posts].reverse().find((post) => post.kind !== "brief");
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5" aria-label="Swarm summary" data-swarm-status={view.status}>
      <div className="flex min-w-0 items-center gap-2">
        <StatusGlyph status={STATUS_GLYPH[view.status]} size="md" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{view.goal.title}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{STATUS_LABEL[view.status]}{view.helpers.length ? ` · ${view.helpers.length} helpers · ${progressLine(view)}` : ""}</span>
        </span>
        {view.helpers.length ? (
          <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide" : "Details"}
            <ChevronRight className={cn("size-3.5", open && "rotate-90")} aria-hidden />
          </Button>
        ) : null}
      </div>
      {view.helpers.length ? <ProgressSegments view={view} /> : null}
      {!open && focus.length ? (
        <ul className="flex min-w-0 flex-col divide-y divide-border">{focus.map((helper) => <HelperRow key={helper.name} helper={helper} />)}</ul>
      ) : null}
      {!open && latest && !focus.length && progress.total ? (
        <p className="min-w-0 truncate text-xs text-muted-foreground"><span className="font-mono">{latest.author}</span>: {plainPost(latest.text)}</p>
      ) : null}
      {open ? (
        <div className="flex min-w-0 flex-col gap-3 border-t border-border pt-2">
          <div className="flex flex-wrap gap-2"><SourceTag source="live" show={annotate} /><SourceTag source="files" show={annotate} /></div>
          <ThreadList view={view} annotate={annotate} />
          <div className="flex min-w-0 flex-col">
            <SectionTitle source="files" annotate={annotate}>Helpers</SectionTitle>
            <ul className="flex min-w-0 flex-col divide-y divide-border">{view.helpers.map((helper) => <HelperRow key={helper.name} helper={helper} />)}</ul>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <SectionTitle source="files" annotate={annotate}>Latest messages</SectionTitle>
            <MessageFeed posts={view.posts} hideBriefs limit={6} />
          </div>
        </div>
      ) : null}
      <SwarmNotes view={view} />
    </section>
  );
}

export function GoogleOnlyExtras() {
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-dashed border-border p-2.5" data-swarm-source="google">
      <div className="flex items-center gap-2"><SourceTag source="google" /><span className="text-xs text-muted-foreground">Shown only if Google exposes it</span></div>
      <ul className="flex list-disc flex-col gap-0.5 pl-5 text-xs text-muted-foreground">
        <li>Which task depends on which (a work graph)</li>
        <li>A review state set by Google rather than read from &quot;done&quot; messages</li>
        <li>The swarm's own overview headline and asks (the narrator), which is not started for Paperclip</li>
        <li>A screenshot timeline of visible changes</li>
      </ul>
    </div>
  );
}
