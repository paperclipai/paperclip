import { useEffect, useRef, useState, type ReactNode } from "react";
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
  issueChatUxTranscriptsByRunId,
} from "../fixtures/issueChatUxFixtures";
import { cn } from "../lib/utils";
import { Bot, Brain, FlaskConical, MessagesSquare, Route, Sparkles, WandSparkles } from "lucide-react";

const noop = async () => {};

const highlights = [
  "Running assistant replies with streamed text, reasoning, tool cards, and background status notes",
  "Historical issue events and linked runs rendered inline with the chat timeline",
  "Queued user messages, settled assistant comments, and feedback controls",
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
