import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft, Braces, Check, ChevronDown, Copy, FileText, ListTree, Terminal, Workflow } from "lucide-react";
import type { Agent, HeartbeatRun, HeartbeatRunEvent } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import type { PromptCacheCorrelation } from "@paperclipai/adapter-utils";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useToastActions } from "@/context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { parseEffectiveTrigger } from "../lib/wake-attribution";
import { agentUrl, formatDateTime } from "../lib/utils";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { nav, orchestrationInjectionPage } from "../lib/i18n";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function prettyJson(value: unknown) {
  if (value === null || value === undefined) return orchestrationInjectionPage.noData;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function firstAdapterInvokeEvent(events: HeartbeatRunEvent[] | undefined) {
  return (events ?? []).find((event) => event.eventType === "adapter.invoke") ?? null;
}

function runReason(run: HeartbeatRun) {
  const context = asRecord(run.contextSnapshot);
  return asString(context?.wakeReason) ?? run.invocationSource;
}

function runStatusLabel(status: string) {
  const map = orchestrationInjectionPage.runStatusDisplay as Record<string, string>;
  return map[status] ?? status;
}

function wakeAttributionSourceLabel(source: string): string {
  const labels = orchestrationInjectionPage.wakeAttributionSourceLabels;
  return source in labels ? labels[source as keyof typeof labels] : source;
}

function wakeAttributionReasonLabel(reason: string): string {
  const labels = orchestrationInjectionPage.wakeReasonLabels;
  return reason in labels ? labels[reason as keyof typeof labels] : reason;
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap break-words border border-border bg-muted/20 p-3 font-mono text-xs leading-relaxed">
      {prettyJson(value)}
    </pre>
  );
}

function parsePromptCacheCorrelation(raw: unknown): PromptCacheCorrelation | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const mode = rec.mode === "cold" || rec.mode === "resumed" ? rec.mode : null;
  if (!mode) return null;
  const stabilityKey =
    typeof rec.stabilityKey === "string" && rec.stabilityKey.trim().length > 0 ? rec.stabilityKey.trim() : null;
  let suppressedSectionIds: string[] | undefined;
  const idsRaw = rec.suppressedSectionIds;
  if (Array.isArray(idsRaw)) {
    const ids = idsRaw
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((s) => s.trim());
    suppressedSectionIds = ids.length > 0 ? ids : undefined;
  }
  return {
    mode,
    ...(stabilityKey ? { stabilityKey } : {}),
    ...(suppressedSectionIds ? { suppressedSectionIds } : {}),
  };
}

function parsePromptSections(raw: unknown): Array<{ id: string; body: string }> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<{ id: string; body: string }> = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) continue;
    const body = typeof rec.body === "string" ? rec.body : "";
    out.push({ id, body });
  }
  return out.length > 0 ? out : null;
}

function promptSectionLabel(sectionId: string): string {
  const titles = orchestrationInjectionPage.promptSectionTitles;
  return sectionId in titles ? titles[sectionId as keyof typeof titles] : sectionId;
}

function CollapsiblePromptChunksList({ items }: { items: Array<{ key: string; title: string; body: string }> }) {
  const { pushToast } = useToastActions();
  const [copiedSectionKey, setCopiedSectionKey] = useState<string | null>(null);
  const sectionCopiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (sectionCopiedTimerRef.current != null) window.clearTimeout(sectionCopiedTimerRef.current);
    };
  }, []);

  const copySectionBody = useCallback(
    async (sectionKey: string, text: string) => {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        setCopiedSectionKey(sectionKey);
        if (sectionCopiedTimerRef.current != null) window.clearTimeout(sectionCopiedTimerRef.current);
        sectionCopiedTimerRef.current = window.setTimeout(() => {
          setCopiedSectionKey(null);
          sectionCopiedTimerRef.current = null;
        }, 2000);
      } catch {
        pushToast({
          title: orchestrationInjectionPage.copyFinalPromptFailedTitle,
          body: orchestrationInjectionPage.copyFinalPromptFailedBody,
          tone: "error",
        });
      }
    },
    [pushToast],
  );

  return (
    <div className="space-y-2">
      {items.map((row, index) => {
        const sectionCopied = copiedSectionKey === row.key;
        return (
          <Collapsible key={row.key} defaultOpen={index === 0} className="overflow-hidden border border-border">
            <div className="flex items-stretch">
              <CollapsibleTrigger className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40 [&[data-state=open]>svg]:rotate-180">
                <ChevronDown className="h-4 w-4 shrink-0 transition-transform text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 font-medium">{row.title}</span>
                <span className="tabular-nums text-xs text-muted-foreground">{orchestrationInjectionPage.chars(row.body.length)}</span>
              </CollapsibleTrigger>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-auto min-h-10 w-11 shrink-0 rounded-none border-b-0 border-r-0 border-t-0 bg-background"
                aria-label={orchestrationInjectionPage.copyPromptSectionAria(row.title)}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void copySectionBody(row.key, row.body);
                }}
              >
                {sectionCopied ? <Check className="h-3.5 w-3.5 text-green-600" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
              </Button>
            </div>
            <CollapsibleContent>
              <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap break-words border-t border-border bg-muted/15 p-3 font-mono text-xs leading-relaxed">
                {row.body}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}

function PromptSectionsList({ sections }: { sections: Array<{ id: string; body: string }> }) {
  const items = useMemo(
    () =>
      sections.map((section, index) => ({
        key: `${index}:${section.id}`,
        title: promptSectionLabel(section.id),
        body: section.body,
      })),
    [sections],
  );
  return <CollapsiblePromptChunksList items={items} />;
}

function ParagraphSplitChunksList({ chunks }: { chunks: string[] }) {
  const items = useMemo(
    () =>
      chunks.map((body, index) => ({
        key: `p:${index}`,
        title: orchestrationInjectionPage.promptParagraphLabel(index + 1),
        body,
      })),
    [chunks],
  );
  return <CollapsiblePromptChunksList items={items} />;
}

function PromptBlock({ prompt }: { prompt: string | null }) {
  if (!prompt) {
    return (
      <div className="border border-dashed border-border p-3 text-sm text-muted-foreground">
        {orchestrationInjectionPage.promptUnavailable}
      </div>
    );
  }

  return (
    <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words border border-border bg-muted/20 p-3 font-mono text-xs leading-relaxed">
      {prompt}
    </pre>
  );
}

function MetricPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium tabular-nums">{orchestrationInjectionPage.chars(value)}</div>
    </div>
  );
}

function formatAdapterInvocationCopyText(parts: {
  adapterTypeLabel: string;
  adapterType: string | null;
  commandLabel: string;
  command: string | null;
  cwdLabel: string;
  cwd: string | null;
  commandNotesLabel: string;
  commandNotes: string[];
  noData: string;
}): string {
  const line = (label: string, value: string | null) =>
    `${label}: ${value != null && value.trim().length > 0 ? value : parts.noData}`;
  const sections: string[] = [
    line(parts.adapterTypeLabel, parts.adapterType),
    line(parts.commandLabel, parts.command),
    line(parts.cwdLabel, parts.cwd),
    "",
    `${parts.commandNotesLabel}:`,
  ];
  if (parts.commandNotes.length > 0) {
    for (const note of parts.commandNotes) {
      sections.push(`- ${note}`);
    }
  } else {
    sections.push(parts.noData);
  }
  return sections.join("\n");
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[8rem_1fr]">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="break-all text-sm">{value || orchestrationInjectionPage.noData}</div>
    </div>
  );
}
const DETAIL_TAB_VALUES = ["enqueue", "input", "execution", "record"] as const;
type DetailTab = (typeof DETAIL_TAB_VALUES)[number];

export function OrchestrationInjectionRunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: DetailTab = DETAIL_TAB_VALUES.includes(tabParam as DetailTab)
    ? (tabParam as DetailTab)
    : "input";
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const [finalPromptCopied, setFinalPromptCopied] = useState(false);
  const finalPromptCopiedTimerRef = useRef<number | null>(null);
  const [adapterInvocationCardCopied, setAdapterInvocationCardCopied] = useState(false);
  const adapterInvocationCardCopiedTimerRef = useRef<number | null>(null);
  const [runCardCopied, setRunCardCopied] = useState(false);
  const runCardCopiedTimerRef = useRef<number | null>(null);
  const [contextSnapshotCardCopied, setContextSnapshotCardCopied] = useState(false);
  const contextSnapshotCardCopiedTimerRef = useRef<number | null>(null);
  const [wakePayloadCardCopied, setWakePayloadCardCopied] = useState(false);
  const wakePayloadCardCopiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: nav.work },
      { label: nav.orchestrationInjection, href: "/orchestration-injection" },
      { label: orchestrationInjectionPage.runDetailTitle },
    ]);
  }, [setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const runDetailQuery = useQuery({
    queryKey: runId ? queryKeys.runDetail(runId) : ["heartbeat-run", "none", "detail"],
    queryFn: () => heartbeatsApi.get(runId!),
    enabled: Boolean(selectedCompanyId && runId),
    retry: (_count, err) => !(err instanceof ApiError && err.status === 404),
  });

  const run = runDetailQuery.data ?? null;

  const parsedEffectiveTrigger = useMemo(
    () => (run ? parseEffectiveTrigger(run.contextSnapshot) : null),
    [run],
  );

  useEffect(() => {
    if (finalPromptCopiedTimerRef.current != null) {
      window.clearTimeout(finalPromptCopiedTimerRef.current);
      finalPromptCopiedTimerRef.current = null;
    }
    if (adapterInvocationCardCopiedTimerRef.current != null) {
      window.clearTimeout(adapterInvocationCardCopiedTimerRef.current);
      adapterInvocationCardCopiedTimerRef.current = null;
    }
    if (runCardCopiedTimerRef.current != null) {
      window.clearTimeout(runCardCopiedTimerRef.current);
      runCardCopiedTimerRef.current = null;
    }
    if (contextSnapshotCardCopiedTimerRef.current != null) {
      window.clearTimeout(contextSnapshotCardCopiedTimerRef.current);
      contextSnapshotCardCopiedTimerRef.current = null;
    }
    if (wakePayloadCardCopiedTimerRef.current != null) {
      window.clearTimeout(wakePayloadCardCopiedTimerRef.current);
      wakePayloadCardCopiedTimerRef.current = null;
    }
    setFinalPromptCopied(false);
    setAdapterInvocationCardCopied(false);
    setRunCardCopied(false);
    setContextSnapshotCardCopied(false);
    setWakePayloadCardCopied(false);
  }, [run?.id]);

  useEffect(() => {
    return () => {
      if (finalPromptCopiedTimerRef.current != null) window.clearTimeout(finalPromptCopiedTimerRef.current);
      if (adapterInvocationCardCopiedTimerRef.current != null) window.clearTimeout(adapterInvocationCardCopiedTimerRef.current);
      if (runCardCopiedTimerRef.current != null) window.clearTimeout(runCardCopiedTimerRef.current);
      if (contextSnapshotCardCopiedTimerRef.current != null) window.clearTimeout(contextSnapshotCardCopiedTimerRef.current);
      if (wakePayloadCardCopiedTimerRef.current != null) window.clearTimeout(wakePayloadCardCopiedTimerRef.current);
    };
  }, []);

  const eventsQuery = useQuery({
    queryKey: run ? queryKeys.runEvents(run.id) : ["heartbeat-run", "none", "events"],
    queryFn: () => heartbeatsApi.events(run!.id, 0, 200),
    enabled: Boolean(run),
    refetchInterval: run && ["queued", "running"].includes(run.status) ? 5000 : false,
  });

  const agentsById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.id, agent);
    return map;
  }, [agentsQuery.data]);

  const adapterEvent = firstAdapterInvokeEvent(eventsQuery.data);
  const payload = asRecord(adapterEvent?.payload);
  const context = asRecord(payload?.context);
  const promptMetrics = asRecord(payload?.promptMetrics);
  const prompt = asString(payload?.prompt);
  const commandNotes = Array.isArray(payload?.commandNotes)
    ? payload.commandNotes.filter((item): item is string => typeof item === "string")
    : [];
  const metricEntries = Object.entries(promptMetrics ?? {})
    .map(([key, value]) => ({ key, value: asNumber(value) }))
    .filter((entry): entry is { key: string; value: number } => entry.value !== null);
  const parsedPromptSections = parsePromptSections(payload?.promptSections);
  const promptCacheCorrelation = parsePromptCacheCorrelation(payload?.promptCacheCorrelation);
  const promptRawUnknown = payload?.prompt;
  const fullPromptForCopy = useMemo(() => {
    if (typeof promptRawUnknown === "string" && promptRawUnknown.length > 0) return promptRawUnknown;
    if (parsedPromptSections?.length) return parsedPromptSections.map((section) => section.body).join("\n\n");
    return "";
  }, [promptRawUnknown, parsedPromptSections]);

  const rawPromptStr = typeof promptRawUnknown === "string" ? promptRawUnknown : "";
  const paragraphSplitChunks = useMemo(
    () => rawPromptStr.split(/\n\n+/).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph.length > 0),
    [rawPromptStr],
  );
  const displayPromptForBlock = prompt ?? (rawPromptStr.trim().length > 0 ? rawPromptStr : null);

  const copyFullFinalPrompt = useCallback(async () => {
    if (!fullPromptForCopy) return;
    try {
      await navigator.clipboard.writeText(fullPromptForCopy);
      setFinalPromptCopied(true);
      if (finalPromptCopiedTimerRef.current != null) window.clearTimeout(finalPromptCopiedTimerRef.current);
      finalPromptCopiedTimerRef.current = window.setTimeout(() => {
        setFinalPromptCopied(false);
        finalPromptCopiedTimerRef.current = null;
      }, 2000);
    } catch {
      pushToast({
        title: orchestrationInjectionPage.copyFinalPromptFailedTitle,
        body: orchestrationInjectionPage.copyFinalPromptFailedBody,
        tone: "error",
      });
    }
  }, [fullPromptForCopy, pushToast]);

  const adapterInvocationCardCopyText = useMemo(() => {
    if (!adapterEvent) return "";
    return formatAdapterInvocationCopyText({
      adapterTypeLabel: orchestrationInjectionPage.adapterType,
      adapterType: asString(payload?.adapterType),
      commandLabel: orchestrationInjectionPage.command,
      command: asString(payload?.command),
      cwdLabel: orchestrationInjectionPage.cwd,
      cwd: asString(payload?.cwd),
      commandNotesLabel: orchestrationInjectionPage.commandNotes,
      commandNotes,
      noData: orchestrationInjectionPage.noData,
    });
  }, [adapterEvent, payload?.adapterType, payload?.command, payload?.cwd, commandNotes]);

  const copyAdapterInvocationCard = useCallback(async () => {
    if (!adapterInvocationCardCopyText) return;
    try {
      await navigator.clipboard.writeText(adapterInvocationCardCopyText);
      setAdapterInvocationCardCopied(true);
      if (adapterInvocationCardCopiedTimerRef.current != null) window.clearTimeout(adapterInvocationCardCopiedTimerRef.current);
      adapterInvocationCardCopiedTimerRef.current = window.setTimeout(() => {
        setAdapterInvocationCardCopied(false);
        adapterInvocationCardCopiedTimerRef.current = null;
      }, 2000);
    } catch {
      pushToast({
        title: orchestrationInjectionPage.copyFinalPromptFailedTitle,
        body: orchestrationInjectionPage.copyFinalPromptFailedBody,
        tone: "error",
      });
    }
  }, [adapterInvocationCardCopyText, pushToast]);

  const runCardCopyText = useMemo(() => {
    if (!run) return "";
    const agentDisplay = agentsById.get(run.agentId)?.name ?? run.agentId;
    const started = run.startedAt ? formatDateTime(run.startedAt) : orchestrationInjectionPage.noData;
    const created = formatDateTime(run.createdAt);
    return [
      `${orchestrationInjectionPage.runRowIdLabel}: ${run.id}`,
      `${orchestrationInjectionPage.status}: ${runStatusLabel(run.status)}`,
      `${orchestrationInjectionPage.source}: ${runReason(run)}`,
      `${orchestrationInjectionPage.startedAt}: ${started}`,
      `${orchestrationInjectionPage.createdAt}: ${created}`,
      `${orchestrationInjectionPage.agent}: ${agentDisplay}`,
    ].join("\n");
  }, [run, agentsById]);

  const copyRunCard = useCallback(async () => {
    if (!runCardCopyText) return;
    try {
      await navigator.clipboard.writeText(runCardCopyText);
      setRunCardCopied(true);
      if (runCardCopiedTimerRef.current != null) window.clearTimeout(runCardCopiedTimerRef.current);
      runCardCopiedTimerRef.current = window.setTimeout(() => {
        setRunCardCopied(false);
        runCardCopiedTimerRef.current = null;
      }, 2000);
    } catch {
      pushToast({
        title: orchestrationInjectionPage.copyFinalPromptFailedTitle,
        body: orchestrationInjectionPage.copyFinalPromptFailedBody,
        tone: "error",
      });
    }
  }, [runCardCopyText, pushToast]);

  const contextSnapshotCopyText = useMemo(() => {
    if (!run) return "";
    const title = orchestrationInjectionPage.contextSnapshot;
    const body = prettyJson(run.contextSnapshot);
    return `${title}\n\n${body}`;
  }, [run]);

  const wakePayloadCopyText = useMemo(() => {
    const title = orchestrationInjectionPage.wakePayload;
    const body = prettyJson(context?.paperclipWake ?? null);
    return `${title}\n\n${body}`;
  }, [context?.paperclipWake]);

  const copyContextSnapshotCard = useCallback(async () => {
    if (!contextSnapshotCopyText) return;
    try {
      await navigator.clipboard.writeText(contextSnapshotCopyText);
      setContextSnapshotCardCopied(true);
      if (contextSnapshotCardCopiedTimerRef.current != null) window.clearTimeout(contextSnapshotCardCopiedTimerRef.current);
      contextSnapshotCardCopiedTimerRef.current = window.setTimeout(() => {
        setContextSnapshotCardCopied(false);
        contextSnapshotCardCopiedTimerRef.current = null;
      }, 2000);
    } catch {
      pushToast({
        title: orchestrationInjectionPage.copyFinalPromptFailedTitle,
        body: orchestrationInjectionPage.copyFinalPromptFailedBody,
        tone: "error",
      });
    }
  }, [contextSnapshotCopyText, pushToast]);

  const copyWakePayloadCard = useCallback(async () => {
    if (!wakePayloadCopyText) return;
    try {
      await navigator.clipboard.writeText(wakePayloadCopyText);
      setWakePayloadCardCopied(true);
      if (wakePayloadCardCopiedTimerRef.current != null) window.clearTimeout(wakePayloadCardCopiedTimerRef.current);
      wakePayloadCardCopiedTimerRef.current = window.setTimeout(() => {
        setWakePayloadCardCopied(false);
        wakePayloadCardCopiedTimerRef.current = null;
      }, 2000);
    } catch {
      pushToast({
        title: orchestrationInjectionPage.copyFinalPromptFailedTitle,
        body: orchestrationInjectionPage.copyFinalPromptFailedBody,
        tone: "error",
      });
    }
  }, [wakePayloadCopyText, pushToast]);

  const backLink = (
    <Link
      to="/orchestration-injection"
      className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
      {orchestrationInjectionPage.backToList}
    </Link>
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Workflow} message={orchestrationInjectionPage.selectCompany} />;
  }

  if (!runId) {
    return (
      <div className="space-y-4">
        {backLink}
        <div className="text-sm text-destructive">{orchestrationInjectionPage.failedToLoad}</div>
      </div>
    );
  }

  if (agentsQuery.isLoading || (runDetailQuery.isLoading && !runDetailQuery.data)) {
    return <PageSkeleton variant="list" />;
  }

  if (agentsQuery.error) {
    const error = agentsQuery.error;
    return (
      <div className="space-y-4">
        {backLink}
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : orchestrationInjectionPage.failedToLoad}
        </div>
      </div>
    );
  }

  if (runDetailQuery.isError) {
    const err = runDetailQuery.error;
    const is404 = err instanceof ApiError && err.status === 404;
    return (
      <div className="space-y-4">
        {backLink}
        <EmptyState icon={FileText} message={is404 ? orchestrationInjectionPage.runNotFound : err instanceof Error ? err.message : orchestrationInjectionPage.failedToLoad} />
      </div>
    );
  }

  if (!run) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          {backLink}
          <h1 className="text-lg font-semibold">{orchestrationInjectionPage.runDetailTitle}</h1>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.set("tab", v);
              return next;
            },
            { replace: true },
          );
        }}
      >
        <TabsList className="mb-1 flex h-auto min-h-10 w-full flex-wrap justify-start gap-1 sm:w-fit">
          <TabsTrigger value="enqueue">{orchestrationInjectionPage.detailTabEnqueue}</TabsTrigger>
          <TabsTrigger value="input">{orchestrationInjectionPage.detailTabInput}</TabsTrigger>
          <TabsTrigger value="execution">{orchestrationInjectionPage.detailTabExecution}</TabsTrigger>
          <TabsTrigger value="record">{orchestrationInjectionPage.detailTabRecord}</TabsTrigger>
        </TabsList>

        <TabsContent value="enqueue" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{orchestrationInjectionPage.detailTabEnqueue}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>{orchestrationInjectionPage.detailTabEnqueueIntro}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                <Link to="/orchestration-gates" className="text-primary hover:underline">
                  {orchestrationInjectionPage.detailTabLinkGates}
                </Link>
                <Link to="/heartbeat-tasks" className="text-primary hover:underline">
                  {orchestrationInjectionPage.detailTabLinkHeartbeatTasks}
                </Link>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="input" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ListTree className="h-4 w-4 text-muted-foreground" aria-hidden />
                {orchestrationInjectionPage.wakeAttributionTitle}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {parsedEffectiveTrigger ? (
                <>
                  <DetailRow
                    label={orchestrationInjectionPage.wakeAttributionWinningLabel}
                    value={`${wakeAttributionSourceLabel(parsedEffectiveTrigger.winning.source)} · ${wakeAttributionReasonLabel(parsedEffectiveTrigger.winning.reason)}`}
                  />
                  {parsedEffectiveTrigger.winning.triggerDetail ? (
                    <DetailRow
                      label={orchestrationInjectionPage.wakeAttributionTriggerDetailLabel}
                      value={parsedEffectiveTrigger.winning.triggerDetail}
                    />
                  ) : null}
                  {parsedEffectiveTrigger.lastMergeAt ? (
                    <DetailRow
                      label={orchestrationInjectionPage.wakeAttributionLastMergeLabel}
                      value={formatDateTime(parsedEffectiveTrigger.lastMergeAt)}
                    />
                  ) : null}
                  {parsedEffectiveTrigger.absorbed.length > 0 ? (
                    <div>
                      <div className="mb-2 text-xs font-medium text-muted-foreground">
                        {orchestrationInjectionPage.wakeAttributionAbsorbedTitle}
                      </div>
                      <ul className="space-y-2">
                        {parsedEffectiveTrigger.absorbed.map((row, index) => (
                          <li
                            key={`${row.absorbedAt}-${row.source}-${row.reason}-${index}`}
                            className="border-l border-border pl-3 text-sm leading-relaxed"
                          >
                            <div>
                              {wakeAttributionSourceLabel(row.source)} · {wakeAttributionReasonLabel(row.reason)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {orchestrationInjectionPage.wakeAttributionAbsorbedAtLabel}： {formatDateTime(row.absorbedAt)}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-xs leading-relaxed text-muted-foreground">{orchestrationInjectionPage.wakeAttributionFallbackHint}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
                  {orchestrationInjectionPage.finalPrompt}
                </CardTitle>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full shrink-0 sm:w-auto"
                  disabled={!fullPromptForCopy}
                  aria-label={orchestrationInjectionPage.copyFinalPromptAria}
                  onClick={() => void copyFullFinalPrompt()}
                >
                  {finalPromptCopied ? <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
                  {finalPromptCopied ? orchestrationInjectionPage.copyFinalPromptDone : orchestrationInjectionPage.copyFinalPrompt}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {promptCacheCorrelation ? (
                <div className="space-y-2 rounded-md border border-border bg-muted/15 p-3 text-xs leading-relaxed">
                  <div className="font-medium text-foreground">{orchestrationInjectionPage.promptCacheCorrelationTitle}</div>
                  <div className="text-muted-foreground">
                    {promptCacheCorrelation.mode === "cold"
                      ? orchestrationInjectionPage.promptCacheModeCold
                      : orchestrationInjectionPage.promptCacheModeResumed}
                  </div>
                  {promptCacheCorrelation.stabilityKey ? (
                    <div>
                      <span className="text-muted-foreground">{orchestrationInjectionPage.promptCacheStabilityKeyLabel}：</span>
                      <code className="break-all font-mono text-[11px]">{promptCacheCorrelation.stabilityKey}</code>
                    </div>
                  ) : null}
                  {promptCacheCorrelation.suppressedSectionIds?.length ? (
                    <div>
                      <div className="mb-1 font-medium text-foreground">{orchestrationInjectionPage.promptCacheSuppressedLabel}</div>
                      <ul className="list-inside list-disc space-y-0.5">
                        {promptCacheCorrelation.suppressedSectionIds.map((id) => (
                          <li key={id}>{promptSectionLabel(id)}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {metricEntries.length > 0 ? (
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {metricEntries.map((entry) => (
                    <MetricPill key={entry.key} label={entry.key} value={entry.value} />
                  ))}
                </div>
              ) : null}
              {parsedPromptSections ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{orchestrationInjectionPage.promptCombinationHint}</p>
                  <PromptSectionsList key={run.id} sections={parsedPromptSections} />
                </div>
              ) : paragraphSplitChunks.length > 1 ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{orchestrationInjectionPage.promptParagraphFallbackHint}</p>
                  <ParagraphSplitChunksList key={run.id} chunks={paragraphSplitChunks} />
                </div>
              ) : (
                <PromptBlock prompt={displayPromptForBlock} />
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Braces className="h-4 w-4 text-muted-foreground" aria-hidden />
                    {orchestrationInjectionPage.contextSnapshot}
                  </CardTitle>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full shrink-0 sm:w-auto"
                    disabled={!contextSnapshotCopyText}
                    aria-label={orchestrationInjectionPage.copyContextSnapshotCardAria}
                    onClick={() => void copyContextSnapshotCard()}
                  >
                    {contextSnapshotCardCopied ? <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
                    {contextSnapshotCardCopied ? orchestrationInjectionPage.copyFinalPromptDone : orchestrationInjectionPage.copyFinalPrompt}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <JsonBlock value={run.contextSnapshot} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Workflow className="h-4 w-4 text-muted-foreground" aria-hidden />
                    {orchestrationInjectionPage.wakePayload}
                  </CardTitle>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full shrink-0 sm:w-auto"
                    disabled={!wakePayloadCopyText}
                    aria-label={orchestrationInjectionPage.copyWakePayloadCardAria}
                    onClick={() => void copyWakePayloadCard()}
                  >
                    {wakePayloadCardCopied ? <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
                    {wakePayloadCardCopied ? orchestrationInjectionPage.copyFinalPromptDone : orchestrationInjectionPage.copyFinalPrompt}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <JsonBlock value={context?.paperclipWake ?? null} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="execution" className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            {orchestrationInjectionPage.executionPromptCrossRef}{" "}
            <Link to="?tab=input" replace className="text-primary hover:underline">
              {orchestrationInjectionPage.detailTabInput}
            </Link>
          </p>
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Terminal className="h-4 w-4 text-muted-foreground" aria-hidden />
                  {orchestrationInjectionPage.adapterInvocation}
                </CardTitle>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full shrink-0 sm:w-auto"
                  disabled={!adapterInvocationCardCopyText}
                  aria-label={orchestrationInjectionPage.copyAdapterInvocationCardAria}
                  onClick={() => void copyAdapterInvocationCard()}
                >
                  {adapterInvocationCardCopied ? <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
                  {adapterInvocationCardCopied ? orchestrationInjectionPage.copyFinalPromptDone : orchestrationInjectionPage.copyFinalPrompt}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {!adapterEvent ? (
                <div className="border border-dashed border-border p-3 text-sm text-muted-foreground">{orchestrationInjectionPage.eventUnavailable}</div>
              ) : (
                <>
                  <DetailRow label={orchestrationInjectionPage.adapterType} value={asString(payload?.adapterType)} />
                  <DetailRow label={orchestrationInjectionPage.command} value={asString(payload?.command)} />
                  <DetailRow label={orchestrationInjectionPage.cwd} value={asString(payload?.cwd)} />
                  {commandNotes.length > 0 ? (
                    <div>
                      <div className="mb-2 text-xs text-muted-foreground">{orchestrationInjectionPage.commandNotes}</div>
                      <ul className="space-y-1 text-sm">
                        {commandNotes.map((note, index) => (
                          <li key={`${index}-${note}`} className="border-l border-border pl-3">
                            {note}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="record" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
                  {orchestrationInjectionPage.run}
                </CardTitle>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full shrink-0 sm:w-auto"
                  disabled={!runCardCopyText}
                  aria-label={orchestrationInjectionPage.copyRunCardAria}
                  onClick={() => void copyRunCard()}
                >
                  {runCardCopied ? <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
                  {runCardCopied ? orchestrationInjectionPage.copyFinalPromptDone : orchestrationInjectionPage.copyFinalPrompt}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <DetailRow label={orchestrationInjectionPage.runRowIdLabel} value={run.id} />
              <DetailRow label={orchestrationInjectionPage.status} value={runStatusLabel(run.status)} />
              <DetailRow label={orchestrationInjectionPage.source} value={runReason(run)} />
              <DetailRow label={orchestrationInjectionPage.startedAt} value={run.startedAt ? formatDateTime(run.startedAt) : null} />
              <DetailRow label={orchestrationInjectionPage.createdAt} value={formatDateTime(run.createdAt)} />
              <DetailRow label={orchestrationInjectionPage.agent} value={agentsById.get(run.agentId)?.name ?? run.agentId} />
              {agentsById.get(run.agentId) ? (
                <Link to={agentUrl(agentsById.get(run.agentId)!)} className="text-sm text-primary hover:underline">
                  {agentsById.get(run.agentId)!.name}
                </Link>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
