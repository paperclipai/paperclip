import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { IssueChatThread } from "../components/IssueChatThread";
import {
  issueChatUxAgentMap,
  issueChatUxFeedbackVotes,
  issueChatUxLinkedRuns,
  issueChatUxLiveComments,
  issueChatUxLiveEvents,
  issueChatUxLiveRuns,
  issueChatUxMentions,
  issueChatUxReassignOptions,
  issueChatUxReviewComments,
  issueChatUxReviewEvents,
  issueChatUxSubmittingComments,
  issueChatUxTranscriptsByRunId,
} from "../fixtures/issueChatUxFixtures";
import { cn } from "../lib/utils";
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  FileText,
  FlaskConical,
  GripVertical,
  Layout as LayoutIcon,
  Loader2,
  MessagesSquare,
  Route,
  Sparkles,
  WandSparkles,
} from "lucide-react";

const noop = async () => {};

const highlights = [
  "Running assistant replies with streamed text, reasoning, tool cards, and background status notes",
  "Historical issue events and linked runs rendered inline with the chat timeline",
  "Queued user messages, settled assistant comments, and feedback controls",
  "Submitting (pending) message bubble with Sending... label and reduced opacity",
  "Empty and disabled-composer states without relying on live backend data",
];

function LabSection({
  id,
  eyebrow,
  title,
  description,
  accentClassName,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  description: string;
  accentClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "rounded-[28px] border border-border/70 bg-background/80 p-4 shadow-[0_24px_60px_rgba(15,23,42,0.08)] sm:p-5",
        accentClassName,
      )}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            {eyebrow}
          </div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

const DEMO_REASONING_LINES = [
  "Analyzing the user's request about the animation smoothness...",
  "The current implementation unmounts the old span instantly, causing a flash...",
  "Looking at the CSS keyframes for cot-line-slide-up...",
  "We need a paired exit animation so the old line slides out while the new one slides in...",
  "Implementing a two-span ticker: exiting line goes up and out, entering line comes up from below...",
  "Testing the 280ms cubic-bezier transition timing...",
];

function RotatingReasoningDemo({ intervalMs = 2200 }: { intervalMs?: number }) {
  const [index, setIndex] = useState(0);
  const prevRef = useRef(DEMO_REASONING_LINES[0]);
  const [ticker, setTicker] = useState<{
    key: number;
    current: string;
    exiting: string | null;
  }>({ key: 0, current: DEMO_REASONING_LINES[0], exiting: null });

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % DEMO_REASONING_LINES.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  const currentLine = DEMO_REASONING_LINES[index];

  useEffect(() => {
    if (currentLine !== prevRef.current) {
      const prev = prevRef.current;
      prevRef.current = currentLine;
      setTicker((t) => ({ key: t.key + 1, current: currentLine, exiting: prev }));
    }
  }, [currentLine]);

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-0.5">
        <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
      </div>
      <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
        {ticker.exiting !== null && (
          <span
            key={`out-${ticker.key}`}
            className="cot-line-exit absolute inset-x-0 truncate text-[13px] italic leading-5 text-muted-foreground/70"
            onAnimationEnd={() => setTicker((t) => ({ ...t, exiting: null }))}
          >
            {ticker.exiting}
          </span>
        )}
        <span
          key={`in-${ticker.key}`}
          className={cn(
            "absolute inset-x-0 truncate text-[13px] italic leading-5 text-muted-foreground/70",
            ticker.key > 0 && "cot-line-enter",
          )}
        >
          {ticker.current}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat-first layout v1 (mock)
// ---------------------------------------------------------------------------

const MOCK_ISSUE_TITLE = "Smooth out reasoning ticker animation on long-running runs";
const MOCK_ISSUE_BODY = `When the assistant streams a long chain of reasoning, the rotating ticker pops abruptly between lines. We see this most on runs longer than ~30s where 6+ lines cycle in quick succession.

**Repro**
1. Open any in-progress issue with an active assistant reply.
2. Watch the reasoning ticker under the run header.
3. Note the exit/entry happens in the same frame, causing a flash.

**Expected**
The exiting line should slide up + fade while the entering line slides in from below — symmetric, ~280ms cubic-bezier.

**Notes**
- Component lives in IssueChatThread / RotatingReasoningDemo
- Don't tie this to the live transcript stream timing — keep the animation independent from message arrival.
- Mobile should keep the same easing but reduce vertical travel by ~40%.
`;

type MockDoc = { id: string; title: string; kind: string; updated: string; body: string };

const MOCK_DOCUMENTS: MockDoc[] = [
  {
    id: "doc-plan",
    title: "Plan: animation ticker rework",
    kind: "Plan",
    updated: "12m ago",
    body: "1. Add paired exit/enter animation\n2. Decouple from stream tick\n3. Mobile: reduce travel\n4. Verify on /tests/ux/chat",
  },
  {
    id: "doc-spec",
    title: "Spec: cot-line transitions",
    kind: "Spec",
    updated: "2h ago",
    body: "Two-span ticker. Exit: translateY(-100%) + opacity 0 over 280ms. Enter: translateY(100% → 0) over 280ms.",
  },
  {
    id: "doc-notes",
    title: "Review notes from prior run",
    kind: "Notes",
    updated: "yesterday",
    body: "Reviewer asked about reduced-motion behavior. We should respect prefers-reduced-motion and snap-cut.",
  },
];

const SPLIT_STORAGE_KEY = "issue-chat-ux-lab.chat-first.split-pct";
const MIN_RIGHT_PCT = 28;
const MAX_RIGHT_PCT = 60;

function useStickySplitPct(defaultPct: number) {
  const [pct, setPct] = useState<number>(() => {
    if (typeof window === "undefined") return defaultPct;
    const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed >= MIN_RIGHT_PCT && parsed <= MAX_RIGHT_PCT) return parsed;
    return defaultPct;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(pct)));
  }, [pct]);
  return [pct, setPct] as const;
}

/** Drag handle between two columns. Reports the right column's percentage. */
function SplitHandle({
  containerRef,
  rightPct,
  setRightPct,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  rightPct: number;
  setRightPct: (n: number) => void;
}) {
  const draggingRef = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const xFromRight = rect.right - e.clientX;
      const pct = (xFromRight / rect.width) * 100;
      const clamped = Math.max(MIN_RIGHT_PCT, Math.min(MAX_RIGHT_PCT, pct));
      setRightPct(clamped);
    },
    [containerRef, setRightPct],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(100 - rightPct)}
      aria-valuemin={100 - MAX_RIGHT_PCT}
      aria-valuemax={100 - MIN_RIGHT_PCT}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => setRightPct(40)}
      className="group relative hidden w-1.5 cursor-col-resize items-center justify-center bg-border/30 transition-colors hover:bg-border md:flex"
      title="Drag to resize · double-click to reset to 60/40"
    >
      <div className="absolute inset-y-0 -inset-x-2" />
      <GripVertical className="relative z-10 h-4 w-4 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
    </div>
  );
}

/** Truncates a long markdown-ish body with a Show more / Show less toggle. */
function TruncatedBody({ body, lines = 6 }: { body: string; lines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const measureRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(true);

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 2);
  }, [body, lines]);

  return (
    <div className="space-y-2">
      <div
        ref={measureRef}
        className={cn(
          "whitespace-pre-wrap text-[13px] leading-6 text-foreground/80",
          !expanded && "overflow-hidden",
        )}
        style={!expanded ? { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical" } : undefined}
      >
        {body}
      </div>
      {(overflowing || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function DocumentList({
  docs,
  openId,
  onToggle,
}: {
  docs: MockDoc[];
  openId: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      {docs.map((doc) => {
        const open = openId === doc.id;
        return (
          <div key={doc.id} className="overflow-hidden rounded-lg border border-border/60 bg-background/70">
            <button
              type="button"
              onClick={() => onToggle(doc.id)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/30"
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{doc.title}</div>
                <div className="text-[11px] text-muted-foreground">
                  {doc.kind} · updated {doc.updated}
                </div>
              </div>
              {open ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
            </button>
            {open && (
              <div className="border-t border-border/60 bg-accent/10 px-3 py-2.5 text-[12.5px] leading-5 text-foreground/80 whitespace-pre-wrap">
                {doc.body}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Right rail: issue header + truncated body + documents. */
function IssueRail({
  collapsibleOnMobile = false,
  initiallyCollapsedMobile = true,
}: {
  collapsibleOnMobile?: boolean;
  initiallyCollapsedMobile?: boolean;
}) {
  const [openDoc, setOpenDoc] = useState<string | null>("doc-plan");
  const [mobileOpen, setMobileOpen] = useState(!initiallyCollapsedMobile);

  return (
    <aside className="flex h-full min-h-0 flex-col bg-background/60">
      {collapsibleOnMobile && (
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-2.5 text-left md:hidden"
        >
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Issue</div>
            <div className="truncate text-sm font-medium text-foreground">{MOCK_ISSUE_TITLE}</div>
          </div>
          {mobileOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        </button>
      )}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-5",
          collapsibleOnMobile && !mobileOpen && "hidden md:flex",
        )}
      >
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]">
              ISSUE-482
            </Badge>
            <Badge className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">
              In progress
            </Badge>
            <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.16em]">
              UI · animations
            </Badge>
          </div>
          <h3 className="text-base font-semibold leading-snug tracking-tight text-foreground">
            {MOCK_ISSUE_TITLE}
          </h3>
          <div className="text-[11px] text-muted-foreground">
            Opened by Frank · assigned to <span className="text-foreground/80">CodexCoder</span>
          </div>
        </header>

        <section>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Description
          </div>
          <TruncatedBody body={MOCK_ISSUE_BODY} />
        </section>

        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Documents · {MOCK_DOCUMENTS.length}
            </div>
            <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground">
              View all
            </button>
          </div>
          <DocumentList docs={MOCK_DOCUMENTS} openId={openDoc} onToggle={(id) => setOpenDoc((cur) => (cur === id ? null : id))} />
        </section>

        <section>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Activity
          </div>
          <div className="rounded-lg border border-dashed border-border/60 bg-background/50 px-3 py-2.5 text-[12px] text-muted-foreground">
            Inline activity events appear in the conversation timeline (see chat column).
            Switch this rail to a separate &quot;Activity&quot; tab if needed — TBD.
          </div>
        </section>
      </div>
    </aside>
  );
}

function ChatColumn() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border/70 bg-background/70 px-4 py-2.5">
        <MessagesSquare className="h-4 w-4 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">Conversation</div>
        <div className="ml-auto text-[11px] text-muted-foreground">
          Auto-jumps to latest on open · stays put while you scroll
        </div>
      </div>
      <IssueChatThread
        layout="filled"
        comments={issueChatUxLiveComments}
        linkedRuns={issueChatUxLinkedRuns.slice(0, 1)}
        timelineEvents={issueChatUxLiveEvents}
        liveRuns={issueChatUxLiveRuns}
        issueStatus="todo"
        agentMap={issueChatUxAgentMap}
        currentUserId="user-1"
        onAdd={noop}
        onVote={noop}
        onCancelRun={noop}
        onInterruptQueued={noop}
        draftKey="issue-chat-ux-lab-chatfirst"
        enableReassign
        reassignOptions={issueChatUxReassignOptions}
        currentAssigneeValue="agent:agent-1"
        suggestedAssigneeValue="agent:agent-2"
        mentions={issueChatUxMentions}
        enableLiveTranscriptPolling={false}
        transcriptsByRunId={issueChatUxTranscriptsByRunId}
        hasOutputForRun={(runId) => issueChatUxTranscriptsByRunId.has(runId)}
      />
    </div>
  );
}

type LayoutMode = "current" | "chat-first";

function ChatFirstPreview() {
  const [mode, setMode] = useState<LayoutMode>("chat-first");
  const [rightPct, setRightPct] = useStickySplitPct(40);
  const containerRef = useRef<HTMLDivElement>(null);

  const presets: { label: string; right: number }[] = useMemo(
    () => [
      { label: "60 / 40", right: 40 },
      { label: "50 / 50", right: 50 },
      { label: "70 / 30", right: 30 },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-full border border-border/70 bg-background/80 p-0.5 text-[11px] font-medium">
          {(["current", "chat-first"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "rounded-full px-3 py-1 transition-colors",
                mode === m
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "current" ? "Current (top-down)" : "Chat-first (proposed)"}
            </button>
          ))}
        </div>

        {mode === "chat-first" && (
          <>
            <div className="hidden items-center gap-1 md:inline-flex">
              <span className="text-[11px] text-muted-foreground">Split:</span>
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setRightPct(p.right)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
                    Math.round(rightPct) === p.right
                      ? "border-foreground/60 bg-foreground/[0.06] text-foreground"
                      : "border-border/70 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p.label}
                </button>
              ))}
              <span className="ml-2 text-[11px] tabular-nums text-muted-foreground">
                chat {Math.round(100 - rightPct)}% / issue {Math.round(rightPct)}%
              </span>
            </div>
            <div className="ml-auto text-[11px] text-muted-foreground">
              Drag the divider · double-click to reset
            </div>
          </>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border/70 bg-background shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
        {mode === "current" ? (
          <CurrentLayoutPreview />
        ) : (
          <div
            ref={containerRef}
            className="flex h-[78vh] min-h-[640px] w-full flex-col md:flex-row"
          >
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col"
              style={{ flexBasis: `${100 - rightPct}%` }}
            >
              <ChatColumn />
            </div>
            <SplitHandle containerRef={containerRef} rightPct={rightPct} setRightPct={setRightPct} />
            <div
              className="flex min-h-0 flex-col border-t border-border/70 md:border-l md:border-t-0"
              style={{ flexBasis: `${rightPct}%` }}
            >
              <IssueRail collapsibleOnMobile />
            </div>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-dashed border-border/60 bg-accent/10 px-4 py-3 text-[12px] text-muted-foreground">
        <div className="mb-1 font-medium text-foreground">Mobile behavior (resize the viewport &lt; md)</div>
        Chat takes the full screen with the composer pinned. The issue collapses into a tappable header at the top
        of the chat column — tap to unfold the truncated description and documents in place. No bottom-sheet for v1
        to keep gestures predictable.
      </div>
    </div>
  );
}

/** "Current" layout reference: stacked top-down. Reuses the existing chat thread with composer. */
function CurrentLayoutPreview() {
  return (
    <div className="flex flex-col">
      <div className="border-b border-border/70 bg-background/70 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]">
            ISSUE-482
          </Badge>
          <Badge className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">
            In progress
          </Badge>
        </div>
        <h3 className="mt-2 text-base font-semibold leading-snug tracking-tight text-foreground">
          {MOCK_ISSUE_TITLE}
        </h3>
        <div className="mt-2 text-[13px] leading-6 text-foreground/80 whitespace-pre-wrap">
          {MOCK_ISSUE_BODY}
        </div>
      </div>
      <div className="border-b border-border/70 bg-background/40 p-4 sm:p-5">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Documents
        </div>
        <DocumentList docs={MOCK_DOCUMENTS} openId={null} onToggle={() => {}} />
      </div>
      <div className="p-4 sm:p-5">
        <div className="mb-2 inline-flex rounded-full border border-border/70 bg-background/80 p-0.5 text-[11px] font-medium">
          <span className="rounded-full bg-foreground px-3 py-1 text-background">Chat</span>
          <span className="rounded-full px-3 py-1 text-muted-foreground">Activity</span>
        </div>
        <IssueChatThread
          comments={issueChatUxLiveComments}
          linkedRuns={issueChatUxLinkedRuns.slice(0, 1)}
          timelineEvents={issueChatUxLiveEvents}
          liveRuns={issueChatUxLiveRuns}
          issueStatus="todo"
          agentMap={issueChatUxAgentMap}
          currentUserId="user-1"
          onAdd={noop}
          onVote={noop}
          draftKey="issue-chat-ux-lab-current-ref"
          mentions={issueChatUxMentions}
          enableLiveTranscriptPolling={false}
          transcriptsByRunId={issueChatUxTranscriptsByRunId}
          hasOutputForRun={(runId) => issueChatUxTranscriptsByRunId.has(runId)}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function IssueChatUxLab() {
  const [showComposer, setShowComposer] = useState(true);

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-[32px] border border-border/70 bg-[linear-gradient(135deg,rgba(8,145,178,0.10),transparent_28%),linear-gradient(180deg,rgba(245,158,11,0.10),transparent_44%),var(--background)] shadow-[0_30px_80px_rgba(15,23,42,0.10)]">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_320px]">
          <div className="p-6 sm:p-7">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/25 bg-cyan-500/[0.08] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-700 dark:text-cyan-300">
              <FlaskConical className="h-3.5 w-3.5" />
              Chat UX Lab
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">Issue chat review surface</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
              This page exercises the real assistant-ui issue chat with fixture-backed messages. Use it to review
              spacing, chronology, running states, tool rendering, activity rows, queueing, and composer behavior
              without needing a live issue in progress.
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.18em]">
                /tests/ux/chat
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.18em]">
                assistant-ui thread
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.18em]">
                fixture-backed live run
              </Badge>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => setShowComposer((value) => !value)}>
                {showComposer ? "Hide composer in primary preview" : "Show composer in primary preview"}
              </Button>
              <a
                href="#live-execution"
                className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <Route className="h-3.5 w-3.5" />
                Jump to live execution preview
              </a>
            </div>
          </div>

          <aside className="border-t border-border/60 bg-background/70 p-6 lg:border-l lg:border-t-0">
            <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              <WandSparkles className="h-4 w-4 text-cyan-700 dark:text-cyan-300" />
              Covered states
            </div>
            <div className="space-y-3">
              {highlights.map((highlight) => (
                <div
                  key={highlight}
                  className="rounded-2xl border border-border/70 bg-background/85 px-4 py-3 text-sm text-muted-foreground"
                >
                  {highlight}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>

      <LabSection
        id="chat-first-layout"
        eyebrow="Layout proposal"
        title="Chat-first issue layout v1"
        description="Mock of the proposed redesign: full-height chat on the left with a pinned composer, issue + documents on the right rail. Toggle between the current top-down stack and the new chat-first layout to A/B them. Resize the split, persist your preference, and check the &lt; md viewport for mobile collapse."
        accentClassName="bg-[linear-gradient(180deg,rgba(6,182,212,0.07),transparent_28%),var(--background)]"
      >
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/[0.06] px-3 py-2 text-[12px] text-cyan-900 dark:text-cyan-200">
          <LayoutIcon className="h-4 w-4 shrink-0" />
          Mock only — composer, document open, and split state are fixture-backed and don&apos;t persist to the server.
        </div>
        <ChatFirstPreview />
      </LabSection>

      <LabSection
        id="rotating-text"
        eyebrow="Animation demo"
        title="Rotating reasoning text"
        description="Isolated ticker that cycles sample reasoning lines on a timer. The outgoing line slides up and fades out while the incoming line slides up from below. Runs in a loop so you can tune timing and easing without needing a live stream."
        accentClassName="bg-[linear-gradient(180deg,rgba(168,85,247,0.06),transparent_28%),var(--background)]"
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-border/60 bg-accent/10 p-4">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Default interval (2.2s)
            </div>
            <RotatingReasoningDemo />
          </div>
          <div className="rounded-xl border border-border/60 bg-accent/10 p-4">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Fast interval (1s) — stress test
            </div>
            <RotatingReasoningDemo intervalMs={1000} />
          </div>
        </div>
      </LabSection>

      <LabSection
        id="working-tokens"
        eyebrow="Status tokens"
        title="Working / Worked header verb"
        description='The "Working" token uses the shimmer-text gradient sweep to signal an active run. Once the run completes it becomes the static "Worked" token.'
        accentClassName="bg-[linear-gradient(180deg,rgba(16,185,129,0.06),transparent_28%),var(--background)]"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-border/60 bg-accent/10 p-4">
            <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Active run — shimmer
            </div>
            <div className="flex items-center gap-2.5 rounded-lg px-1 py-2">
              <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                <span className="shimmer-text">Working</span>
              </span>
              <span className="text-xs text-muted-foreground/60">for 12s</span>
            </div>
          </div>
          <div className="rounded-xl border border-border/60 bg-accent/10 p-4">
            <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Completed run — static
            </div>
            <div className="flex items-center gap-2.5 rounded-lg px-1 py-2">
              <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
                </span>
                Worked
              </span>
              <span className="text-xs text-muted-foreground/60">for 1 min 24s</span>
            </div>
          </div>
        </div>
      </LabSection>

      <LabSection
        id="live-execution"
        eyebrow="Primary preview"
        title="Live execution thread"
        description="Shows the fully active state: timeline events, historical run marker, a running assistant reply with reasoning and tools, and a queued follow-up from the user."
        accentClassName="bg-[linear-gradient(180deg,rgba(6,182,212,0.05),transparent_28%),var(--background)]"
      >
        <IssueChatThread
          comments={issueChatUxLiveComments}
          linkedRuns={issueChatUxLinkedRuns.slice(0, 1)}
          timelineEvents={issueChatUxLiveEvents}
          liveRuns={issueChatUxLiveRuns}
          issueStatus="todo"
          agentMap={issueChatUxAgentMap}
          currentUserId="user-1"
          onAdd={noop}
          onVote={noop}
          onCancelRun={noop}
          onInterruptQueued={noop}
          draftKey="issue-chat-ux-lab-primary"
          enableReassign
          reassignOptions={issueChatUxReassignOptions}
          currentAssigneeValue="agent:agent-1"
          suggestedAssigneeValue="agent:agent-2"
          mentions={issueChatUxMentions}
          showComposer={showComposer}
          enableLiveTranscriptPolling={false}
          transcriptsByRunId={issueChatUxTranscriptsByRunId}
          hasOutputForRun={(runId) => issueChatUxTranscriptsByRunId.has(runId)}
        />
      </LabSection>

      <LabSection
        eyebrow="Submitting state"
        title="Pending message bubble"
        description='When a user sends a message, the bubble briefly shows a "Sending..." label at reduced opacity until the server confirms receipt. This preview renders that transient state.'
        accentClassName="bg-[linear-gradient(180deg,rgba(59,130,246,0.06),transparent_28%),var(--background)]"
      >
        <IssueChatThread
          comments={issueChatUxSubmittingComments}
          linkedRuns={[]}
          timelineEvents={[]}
          issueStatus="in_progress"
          agentMap={issueChatUxAgentMap}
          currentUserId="user-1"
          onAdd={noop}
          draftKey="issue-chat-ux-lab-submitting"
          showComposer={false}
          enableLiveTranscriptPolling={false}
        />
      </LabSection>

      <div className="grid gap-6 xl:grid-cols-2">
        <LabSection
          eyebrow="Settled review"
          title="Durable comments and feedback"
          description="Shows the post-run state: assistant comment feedback controls, historical run context, and timeline reassignment without any active stream."
          accentClassName="bg-[linear-gradient(180deg,rgba(168,85,247,0.05),transparent_26%),var(--background)]"
        >
          <IssueChatThread
            comments={issueChatUxReviewComments}
            linkedRuns={issueChatUxLinkedRuns.slice(1)}
            timelineEvents={issueChatUxReviewEvents}
            feedbackVotes={issueChatUxFeedbackVotes}
            feedbackTermsUrl="/feedback-terms"
            issueStatus="in_review"
            agentMap={issueChatUxAgentMap}
            currentUserId="user-1"
            onAdd={noop}
            onVote={noop}
            draftKey="issue-chat-ux-lab-review"
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </LabSection>

        <div className="space-y-6">
          <LabSection
            eyebrow="Empty thread"
            title="Empty state and disabled composer"
            description="Keeps the message area visible even when there is no thread yet, and replaces the composer with an explicit warning when replies are blocked."
            accentClassName="bg-[linear-gradient(180deg,rgba(245,158,11,0.08),transparent_26%),var(--background)]"
          >
            <IssueChatThread
              comments={[]}
              linkedRuns={[]}
              timelineEvents={[]}
              issueStatus="done"
              agentMap={issueChatUxAgentMap}
              currentUserId="user-1"
              onAdd={noop}
              composerDisabledReason="This workspace is closed, so new chat replies are disabled until the issue is reopened."
              draftKey="issue-chat-ux-lab-empty"
              enableLiveTranscriptPolling={false}
            />
          </LabSection>

          <Card className="gap-4 border-border/70 bg-background/85 py-0">
            <CardHeader className="px-5 pt-5 pb-0">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                <MessagesSquare className="h-4 w-4 text-cyan-700 dark:text-cyan-300" />
                Review checklist
              </div>
              <CardTitle className="text-lg">What to evaluate on this page</CardTitle>
              <CardDescription>
                This route should be the fastest way to inspect the chat system before or after tweaks.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-5 pb-5 pt-0 text-sm text-muted-foreground">
              <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
                <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
                  <Bot className="h-4 w-4 text-cyan-700 dark:text-cyan-300" />
                  Message hierarchy
                </div>
                Check that user, assistant, and system rows scan differently without feeling like separate products.
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
                <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
                  <Sparkles className="h-4 w-4 text-cyan-700 dark:text-cyan-300" />
                  Stream polish
                </div>
                Watch the live preview for reasoning density, tool expansion behavior, and queued follow-up readability.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
