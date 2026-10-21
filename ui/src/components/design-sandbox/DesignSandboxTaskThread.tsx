import { TaskChatShimmerScope } from "../task-chat/TaskChatShimmer";
import { revealWords, wordCount } from "./word-reveal";
import { MarkdownWordStreaming } from "../MarkdownWordStreaming";
import { ConversationPlayback } from "./ConversationPlayback";
import { settledPreviewReply as settledReply } from "./settled-preview-reply";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { Agent, FeedbackVoteValue, IssueWorkMode } from "@paperclipai/shared";
import { useStreamlinedUiEnabled } from "../../hooks/useStreamlinedUiEnabled";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/select";
import { useScrollbarWhileScrolling } from "../side-panel/use-scrollbar-while-scrolling";
import { TaskChatThreadView } from "../task-chat/TaskChatThreadView";
import { TaskChatRunnerTurn } from "../task-chat/TaskChatRunnerTurn";
import { TaskChatLiveRunPill, toolCountSummaryFromEntries } from "../task-chat/TaskChatLiveRunPill";
import { TaskChatLiveTail } from "../task-chat/TaskChatLiveTail";
import { TaskChatComposer } from "../task-chat/TaskChatComposer";
import { TaskChatComposerDock } from "../task-chat/TaskChatComposerDock";
import { TaskChatProtocolCard } from "../task-chat/TaskChatProtocolCard";
import { TaskChatBubbleActions } from "../task-chat/TaskChatBubbleActions";
import { TaskChatPresentationProvider } from "../task-chat/presentation-mode";
import { parseCssTimeMs } from "../task-chat/motion-tokens";
import { isTerminalRunStatus, paperclipRunnerFinalResponse, transcriptToTaskChatItems } from "../task-chat/transcript-adapter";
import type { TaskChatItem, TaskChatMessageItem, TaskChatRuntimeRequestDecision, TaskChatRuntimeRequestItem } from "../task-chat/task-chat-model";
import { previewHistory, THREAD_PREVIEW_ALIASES, THREAD_PREVIEW_CASES, type ThreadPreviewCase } from "./task-thread-fixtures";

/** Local design sandbox only. Uses the same transport adapter and rendered
 * surfaces as TaskChatThread; no lab scenarios or imitation thread markup. */
export default function DesignSandboxTaskThread({
  children, header, agentName, agent, defaultConversation, previewMode = "catalog",
}: {
  children: ReactNode;
  header: ReactNode;
  agentName: string;
  agent?: Agent;
  defaultConversation: boolean;
  previewMode?: "catalog" | "playback";
}) {
  const [params, setParams] = useSearchParams();
  const requested = params.get("threadPreview") ?? (defaultConversation ? "staging-conversation" : "saved");
  const aliased = THREAD_PREVIEW_ALIASES[requested] ?? requested;
  const selected = aliased === "all" || THREAD_PREVIEW_CASES.some(item => item.id === aliased) ? aliased : "saved";
  const [generation, setGeneration] = useState(0);
  const { enabled: streamlined } = useStreamlinedUiEnabled();
  const viewport = useRef<HTMLDivElement>(null);
  const onScroll = useScrollbarWhileScrolling();
  const choose = (value: string) => setParams(current => {
    const next = new URLSearchParams(current);
    next.set("threadPreview", value);
    return next;
  }, { replace: true });
  const cases = selected === "all" ? THREAD_PREVIEW_CASES : THREAD_PREVIEW_CASES.filter(item => item.id === selected);
  useEffect(() => { if (viewport.current) viewport.current.scrollTop = 0; }, [selected]);

  if (previewMode === "playback" && selected !== "saved") return <TaskChatPresentationProvider mode={streamlined ? "streamlined" : "production"}><ConversationPlayback header={header} agentName={agentName} agent={agent} onShowSavedThread={() => choose("saved")} /></TaskChatPresentationProvider>;

  return <div className="flex min-h-0 flex-1 flex-col" data-testid="sandbox-task-thread" data-preview-state={selected}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background py-2 text-xs">
      <label htmlFor="sandbox-thread-state" className="font-normal text-foreground">Thread preview</label>
      <NativeSelect id="sandbox-thread-state" value={selected} onChange={event => choose(event.target.value)} className="w-auto min-w-0 max-w-full text-xs" aria-label="Thread preview state">
        <option value="saved">Saved thread</option>
        <option value="all">All states ({THREAD_PREVIEW_CASES.length})</option>
        {[...new Set(THREAD_PREVIEW_CASES.map(item => item.group))].map(group => <optgroup key={group} label={group}>
          {THREAD_PREVIEW_CASES.filter(item => item.group === group).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </optgroup>)}
      </NativeSelect>
      {selected !== "saved" ? <>
        <Button size="sm" variant="outline" onClick={() => setGeneration(value => value + 1)}>Reset / replay</Button>
        <Button size="sm" variant="ghost" onClick={() => choose("saved")}>Show saved thread</Button>
        <span className="text-muted-foreground">Production renderers · synthetic data · preview actions stay local</span>
      </> : null}
    </div>
    {selected === "saved" ? children : <TaskChatPresentationProvider mode={streamlined ? "streamlined" : "production"}>
      <div ref={viewport} onScroll={onScroll} className={`scrollbar-while-scrolling flex min-h-0 flex-1 flex-col ${selected === "all" ? "overflow-y-auto" : ""}`} data-testid="sandbox-thread-viewport">
        {selected === "all" ? <div className="mx-auto w-full max-w-(--tc-shell-max-w) pt-3">{header}</div> : null}
        {cases.map(example => <PreviewCase key={`${selected}:${example.id}:${generation}`} example={example} header={header} agentName={agentName} agent={agent} replay={selected !== "all"} streamlined={streamlined} />)}
      </div>
    </TaskChatPresentationProvider>}
  </div>;
}

function PreviewCase({ example, header, agentName, agent, replay, streamlined }: {
  example: ThreadPreviewCase; header: ReactNode; agentName: string; agent?: Agent; replay: boolean; streamlined: boolean;
}) {
  const scenario = useMemo(() => example.build(), [example]);
  const startedAt = useRef(Date.now() - 40_000);
  const [characters, setCharacters] = useState(replay ? 1 : Infinity);
  const [decisions, setDecisions] = useState<Record<string, TaskChatRuntimeRequestDecision>>({});
  const [votes, setVotes] = useState<Record<string, FeedbackVoteValue>>({});
  const [stopped, setStopped] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [takeoverDismissed, setTakeoverDismissed] = useState(false);
  const [workMode, setWorkMode] = useState<IssueWorkMode>("standard");
  const [messages, setMessages] = useState<TaskChatItem[]>([]);
  const status = stopped ? "cancelled" : scenario.status;
  const terminal = isTerminalRunStatus(status);
  const parsed = useMemo(() => transcriptToTaskChatItems(scenario.entries, { runId: `synthetic-${example.id}`, agentName, running: !terminal }), [scenario, example.id, agentName, terminal]);
  const streamingLength = parsed.reduce((length, item) => item.kind === "message" && item.streaming ? Math.max(length, wordCount(item.text)) : item.kind === "thinking" && item.streaming ? Math.max(length, wordCount(item.lines.join("\n"))) : length, 0);
  useEffect(() => {
    if (!replay || !streamingLength) return;
    const interval = parseCssTimeMs(getComputedStyle(document.documentElement).getPropertyValue("--motion-sandbox-word-tick"));
    if (!interval || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setCharacters(Infinity); return; }
    const timer = window.setInterval(() => setCharacters(count => {
      if (count >= streamingLength) { window.clearInterval(timer); return Infinity; }
      return count + 1;
    }), interval);
    return () => window.clearInterval(timer);
  }, [replay, streamingLength]);
  const items = parsed.map(item => {
    if (item.kind === "message" && item.streaming) return { ...item, text: revealWords(item.text, characters) };
    if (item.kind === "thinking" && item.streaming) return { ...item, lines: [revealWords(item.lines.join("\n"), characters)] };
    if (item.kind === "protocol" && item.surface === "runtime_request" && decisions[item.id]) {
      const decision = decisions[item.id];
      return { ...item, status: "resolved" as const, resolvedAction: decision.action, ...("response" in decision ? { response: decision.response } : {}) };
    }
    return item;
  });
  const pending = items.find((item): item is TaskChatRuntimeRequestItem => item.kind === "protocol" && item.surface === "runtime_request" && item.status === "pending");
  const runtimeDecision = (item: TaskChatRuntimeRequestItem, decision: TaskChatRuntimeRequestDecision) => setDecisions(current => ({ ...current, [item.id]: decision }));
  const history = useMemo(() => {
    const prior = previewHistory(agentName);
    return [prior.human, ...settledReply({ ...prior.response, agent }, prior.entries, `synthetic-${example.id}-history`)];
  }, [agentName, agent, example.id]);
  const actions = (item: TaskChatMessageItem) => item.author === "agent" && !item.streaming ? <TaskChatBubbleActions copyText={item.text} feedback={{
    activeVote: votes[item.id] ?? null, sharingPreference: "allowed", termsUrl: null,
    onVote: async vote => { setVotes(current => ({ ...current, [item.id]: vote })); },
  }} /> : null;
  const followup: TaskChatMessageItem = { id: "synthetic-followup", kind: "message", author: "human", isCurrentUser: true, text: "Tell me your method for finding this out.", timestamp: "10:12 AM", optimistic: scenario.messageState };
  const final = terminal && !scenario.renderer ? paperclipRunnerFinalResponse(parsed, { allowFallback: true }) : undefined;
  const failed = ["failed", "timed_out", "cancelled"].includes(status);
  const notice: TaskChatItem[] = scenario.notice ? [{ id: "synthetic-notice", kind: "message", author: "system", text: "Synthetic workspace notice. Expand this row to inspect the details.", timestamp: "10:13 AM", presentation: { kind: "system_notice", tone: scenario.notice, title: `Workspace preview · ${scenario.notice}`, detailsDefaultOpen: false, density: "compact" } }] : [];
  const historyItems = [...history, followup, ...(final ? settledReply({ ...final, interstitial: false, streaming: false, authorName: agentName, agent, timestamp: "10:13 AM" }, scenario.entries, `synthetic-${example.id}`, failed) : []), ...notice, ...messages];
  const showTail = !final && !scenario.paused && !scenario.notice && !scenario.messageState;
  const showComposer = replay || Boolean(pending || scenario.paused || scenario.messageState);
  const agentMap = useMemo(() => new Map([[agent?.id ?? "synthetic-agent", agent ?? { id: "synthetic-agent", name: agentName }]]), [agent, agentName]);
  return <section className={`flex min-w-0 flex-1 flex-col ${replay ? "min-h-0" : "pt-4"}`} data-preview-case={example.id} data-preview-renderer={scenario.renderer ?? "transcript"} aria-label={example.label}>
    {!replay ? <h3 className="mx-auto mb-3 w-full max-w-(--tc-shell-max-w) border-t border-border pt-4 text-xs font-normal text-muted-foreground">{example.label}</h3> : null}
    <TaskChatThreadView items={historyItems} scroll={replay} header={replay ? header : undefined} className={replay ? "pt-3" : undefined} renderMessageActions={actions} onRuntimeRequestDecision={runtimeDecision} tail={showTail ? <>
      {scenario.renderer === "native" ? <TaskChatRunnerTurn
        runId={`synthetic-${example.id}`} agentName={agentName} agent={agent} items={items} status={status}
        startedAtMs={status === "queued" ? null : startedAt.current} finishedAtMs={terminal ? startedAt.current + 40_000 : null}
        activityUnavailable={scenario.activityUnavailable} continuedAfterSteering={scenario.continuedAfterSteering}
        onRuntimeRequestDecision={runtimeDecision}
      /> : <TaskChatShimmerScope items={items}>
        <TaskChatLiveRunPill status={status} startedAtMs={status === "queued" ? null : startedAt.current} finishedAtMs={terminal ? startedAt.current + 40_000 : null} toolSummary={toolCountSummaryFromEntries(scenario.entries)} />
        <MarkdownWordStreaming.Provider value={replay}><TaskChatLiveTail items={items} emptyMessage={scenario.emptyMessage ?? "Waiting for transcript…"} onRuntimeRequestDecision={runtimeDecision} /></MarkdownWordStreaming.Provider>
        {failed ? <TaskChatThreadView items={[{ id: "synthetic-run-stop", kind: "marker", variant: "interrupted", tone: status === "cancelled" ? "neutral" : "error", collapsible: true, label: status === "cancelled" ? "Run cancelled" : status === "timed_out" ? "Run timed out" : "Run failed", detail: status === "cancelled" ? "The synthetic run was stopped; no saved task was changed." : "Synthetic provider failure: the test process stopped before a final reply was available." }]} scroll={false} /> : null}
      </TaskChatShimmerScope>}
    </> : null} />
    {showComposer ? <TaskChatComposerDock mobile={false} streamlined={streamlined}>
      <TaskChatComposer
        agentMap={agentMap} modelAgents={agent ? new Map([[agent.id, agent]]) : undefined} currentAssigneeValue={`agent:${agent?.id ?? "synthetic-agent"}`}
        enableReassign reassignOptions={[{ id: `agent:${agent?.id ?? "synthetic-agent"}`, label: agentName }]}
        workMode={workMode} onWorkModeChange={setWorkMode}
        placeholder={`Message ${agentName} — synthetic reply…`}
        draftKey={`paperclip:design-sandbox:synthetic-thread:${example.id}`}
        onStop={!terminal ? async () => setStopped(true) : undefined}
        pause={scenario.paused && !resumed ? { scope: scenario.paused, onResume: async () => setResumed(true) } : null}
        takeover={pending && !takeoverDismissed ? {
          id: pending.id, label: pending.requestType === "permission" ? "Permission" : "Questions", pendingCount: 1,
          content: <TaskChatProtocolCard item={pending} presentation="takeover" onRuntimeRequestDecision={runtimeDecision} />,
          onDismiss: () => setTakeoverDismissed(true), onSkip: () => runtimeDecision(pending, { action: "cancel" }),
        } : null}
        pendingTakeover={pending && takeoverDismissed ? { count: 1, label: "1 pending input", onOpen: () => setTakeoverDismissed(false) } : null}
        onAdd={async body => setMessages(current => [...current,
          { id: `local-human-${current.length}`, kind: "message", author: "human", text: body, timestamp: "Just now", isCurrentUser: true },
          { id: `local-agent-${current.length}`, kind: "message", author: "agent", authorName: agentName, agent, text: "Preview reply received. This exchange exists only in your browser; no agent was started.", timestamp: "Just now" },
        ])}
      />
    </TaskChatComposerDock> : null}
  </section>;
}
