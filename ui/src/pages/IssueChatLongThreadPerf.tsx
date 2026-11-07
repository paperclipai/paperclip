import { getPageValueLabel } from "@/pages/tools/shared";
import { t as translateShell, useTranslation } from "@/i18n";
import { Profiler, useEffect, useLayoutEffect, useMemo, useRef, useState, type ProfilerOnRenderCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IssueChatThread } from "../components/IssueChatThread";
import {
  issueChatLongThreadAgentMap,
  issueChatLongThreadComments,
  issueChatLongThreadEvents,
  issueChatLongThreadFixtureContext,
  issueChatLongThreadLinkedRuns,
  issueChatLongThreadLiveRuns,
  issueChatLongThreadMarkdownCommentIds,
  issueChatLongThreadTranscriptsByRunId,
  LONG_THREAD_COMMENT_COUNT,
  LONG_THREAD_MARKDOWN_COMMENT_COUNT,
} from "../fixtures/issueChatLongThreadFixture";

const noop = async () => {};

type RenderMetrics = {
  commitCount: number;
  mountActualDuration: number | null;
  latestActualDuration: number | null;
  maxActualDuration: number;
  totalActualDuration: number;
};

const initialMetrics: RenderMetrics = {
  commitCount: 0,
  mountActualDuration: null,
  latestActualDuration: null,
  maxActualDuration: 0,
  totalActualDuration: 0,
};

function formatMs(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "pending";
  return translateShell("shell:ms", { value1: value.toFixed(1) });
}

function MetricTile({ label, value, testId }: { label: string; value: string; testId: string }) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
        {label}
      </div>
      <div data-testid={testId} className="mt-1 font-mono text-sm text-foreground">
        {value}
      </div>
    </div>
  );
}

export function IssueChatLongThreadPerf() {
  const { t: translateShell } = useTranslation("shell");
  const [metrics, setMetrics] = useState<RenderMetrics>(initialMetrics);
  const metricsRef = useRef<RenderMetrics>(initialMetrics);
  const renderStartedAtRef = useRef(performance.now());
  const publishTimerRef = useRef<number | null>(null);
  const publishedRef = useRef(false);
  const fixture = issueChatLongThreadFixtureContext;
  const rowTarget = useMemo(
    () => LONG_THREAD_COMMENT_COUNT + issueChatLongThreadEvents.length + issueChatLongThreadLinkedRuns.length,
    [translateShell],
  );

  useEffect(() => () => {
    if (publishTimerRef.current !== null) {
      window.clearTimeout(publishTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    if (publishedRef.current || metricsRef.current.commitCount > 0) return;
    const mountDuration = performance.now() - renderStartedAtRef.current;
    const next = {
      commitCount: 1,
      mountActualDuration: mountDuration,
      latestActualDuration: mountDuration,
      maxActualDuration: mountDuration,
      totalActualDuration: mountDuration,
    };
    metricsRef.current = next;
    publishedRef.current = true;
    setMetrics(next);
  }, []);

  const handleRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
    const current = metricsRef.current;
    metricsRef.current = {
      commitCount: current.commitCount + 1,
      mountActualDuration: phase === "mount" && current.mountActualDuration === null
        ? actualDuration
        : current.mountActualDuration,
      latestActualDuration: actualDuration,
      maxActualDuration: Math.max(current.maxActualDuration, actualDuration),
      totalActualDuration: current.totalActualDuration + actualDuration,
    };

    if (publishedRef.current || publishTimerRef.current !== null) return;
    publishTimerRef.current = window.setTimeout(() => {
      publishTimerRef.current = null;
      publishedRef.current = true;
      setMetrics(metricsRef.current);
    }, 0);
  };

  return (
    <div data-testid="issue-chat-long-thread-perf" className="space-y-5">
      <div className="flex flex-col gap-3 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono text-(length:--text-micro)">
              {fixture.issue.identifier}
            </Badge>
            <Badge variant="secondary">{getPageValueLabel(fixture.issue.status, true)}</Badge>
            <Badge variant="outline">{fixture.issue.projectName}</Badge>
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">{fixture.issue.title}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{translateShell("shell:deterministic_local_fixture_for_measuring_the_current")}</p>
        </div>
        <div className="grid min-w-(--sz-280px) grid-cols-2 gap-2">
          <MetricTile label={translateShell("shell:fixture_rows")} value={String(rowTarget)} testId="perf-fixture-row-target" />
          <MetricTile label={translateShell("shell:markdown_rows")} value={String(LONG_THREAD_MARKDOWN_COMMENT_COUNT)} testId="perf-fixture-markdown-rows" />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-(--gtc-40)">
        <main className="min-w-0 space-y-4">
          <Card className="border-border/70">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{translateShell("shell:issue_documents")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {fixture.documents.map((document) => (
                <div key={document} className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                  {document}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-border/70">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{translateShell("shell:sub_issues")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {fixture.subIssues.map((subIssue, index) => (
                <div key={subIssue} className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">#{index + 1}</span>
                  <span>{subIssue}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Profiler id="issue-chat-long-thread" onRender={handleRender}>
            <IssueChatThread
              comments={issueChatLongThreadComments}
              linkedRuns={issueChatLongThreadLinkedRuns}
              timelineEvents={issueChatLongThreadEvents}
              liveRuns={issueChatLongThreadLiveRuns}
              issueStatus="in_progress"
              agentMap={issueChatLongThreadAgentMap}
              currentUserId="user-board"
              onAdd={noop}
              showComposer={false}
              showJumpToLatest={false}
              enableLiveTranscriptPolling={false}
              transcriptsByRunId={issueChatLongThreadTranscriptsByRunId}
              hasOutputForRun={(runId) => issueChatLongThreadTranscriptsByRunId.has(runId)}
            />
          </Profiler>
        </main>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <Card className="border-border/70">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{translateShell("shell:baseline_metrics")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              <MetricTile label={translateShell("shell:profiler_commits")} value={String(metrics.commitCount)} testId="perf-commit-count" />
              <MetricTile label={translateShell("shell:mount_duration")} value={formatMs(metrics.mountActualDuration)} testId="perf-mount-duration" />
              <MetricTile label={translateShell("shell:latest_duration")} value={formatMs(metrics.latestActualDuration)} testId="perf-latest-duration" />
              <MetricTile label={translateShell("shell:max_duration")} value={formatMs(metrics.maxActualDuration)} testId="perf-max-duration" />
              <MetricTile label={translateShell("shell:total_duration")} value={formatMs(metrics.totalActualDuration)} testId="perf-total-duration" />
            </CardContent>
          </Card>

          <Card className="border-border/70">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{translateShell("shell:fixture_shape")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {fixture.sidebarStats.map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-mono">{value}</span>
                </div>
              ))}
              <div className="hidden" data-testid="perf-markdown-comment-id-sample">
                {[...issueChatLongThreadMarkdownCommentIds].slice(0, 3).join(",")}
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
