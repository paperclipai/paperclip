import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Braces, Check, ChevronDown, Copy, FileText, Terminal, Workflow } from "lucide-react";
import type { Agent, HeartbeatRun, HeartbeatRunEvent } from "@paperclipai/shared";
import type { PromptCacheCorrelation } from "@paperclipai/adapter-utils";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useToastActions } from "@/context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, formatDateTime, relativeTime } from "../lib/utils";
import { Link } from "@/lib/router";
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

function runTimeLabel(run: HeartbeatRun) {
  const value = run.startedAt ?? run.createdAt;
  return value ? relativeTime(value) : orchestrationInjectionPage.noData;
}

function runReason(run: HeartbeatRun) {
  const context = asRecord(run.contextSnapshot);
  return asString(context?.wakeReason) ?? run.invocationSource;
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

export function OrchestrationInjection() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
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
    setBreadcrumbs([{ label: nav.work }, { label: nav.orchestrationInjection }]);
  }, [setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const runsQuery = useQuery({
    queryKey: selectedCompanyId ? [...queryKeys.heartbeats(selectedCompanyId), "orchestration-injection"] : ["heartbeats", "none", "orchestration-injection"],
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, undefined, 80),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 30_000,
  });

  const selectedRun = useMemo(() => {
    const runs = runsQuery.data ?? [];
    if (selectedRunId) return runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
    return runs[0] ?? null;
  }, [runsQuery.data, selectedRunId]);

  useEffect(() => {
    if (!selectedRunId && selectedRun?.id) setSelectedRunId(selectedRun.id);
  }, [selectedRun?.id, selectedRunId]);

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
  }, [selectedRun?.id]);

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
    queryKey: selectedRun ? queryKeys.runEvents(selectedRun.id) : ["heartbeat-run", "none", "events"],
    queryFn: () => heartbeatsApi.events(selectedRun!.id, 0, 200),
    enabled: Boolean(selectedRun),
    refetchInterval: selectedRun && ["queued", "running"].includes(selectedRun.status) ? 5000 : false,
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
  }, [
    adapterEvent,
    payload?.adapterType,
    payload?.command,
    payload?.cwd,
    commandNotes,
  ]);

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
    if (!selectedRun) return "";
    const agentDisplay = agentsById.get(selectedRun.agentId)?.name ?? selectedRun.agentId;
    const started = selectedRun.startedAt ? formatDateTime(selectedRun.startedAt) : orchestrationInjectionPage.noData;
    const created = formatDateTime(selectedRun.createdAt);
    return [
      `${orchestrationInjectionPage.runRowIdLabel}: ${selectedRun.id}`,
      `${orchestrationInjectionPage.status}: ${selectedRun.status}`,
      `${orchestrationInjectionPage.source}: ${runReason(selectedRun)}`,
      `${orchestrationInjectionPage.startedAt}: ${started}`,
      `${orchestrationInjectionPage.createdAt}: ${created}`,
      `${orchestrationInjectionPage.agent}: ${agentDisplay}`,
    ].join("\n");
  }, [selectedRun, agentsById]);

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
    if (!selectedRun) return "";
    const title = orchestrationInjectionPage.contextSnapshot;
    const body = prettyJson(selectedRun.contextSnapshot);
    return `${title}\n\n${body}`;
  }, [selectedRun]);

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

  if (!selectedCompanyId) {
    return <EmptyState icon={Workflow} message={orchestrationInjectionPage.selectCompany} />;
  }

  if (runsQuery.isLoading || agentsQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (runsQuery.error || agentsQuery.error) {
    const error = runsQuery.error ?? agentsQuery.error;
    return (
      <div className="text-sm text-destructive">
        {error instanceof Error ? error.message : orchestrationInjectionPage.failedToLoad}
      </div>
    );
  }

  const runs = runsQuery.data ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Workflow className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">{orchestrationInjectionPage.title}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{orchestrationInjectionPage.subtitle}</p>
        </div>
      </div>

      {runs.length === 0 ? (
        <EmptyState icon={Activity} message={orchestrationInjectionPage.empty} />
      ) : (
        <div className="grid min-h-[640px] gap-4 lg:grid-cols-[minmax(20rem,24rem)_1fr]">
          <div className="min-h-0 border border-border">
            <div className="border-b px-3 py-2 text-sm font-medium">{orchestrationInjectionPage.recentRuns}</div>
            <div className="max-h-[720px] overflow-y-auto">
              {runs.map((run) => {
                const agent = agentsById.get(run.agentId);
                const active = selectedRun?.id === run.id;
                return (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => setSelectedRunId(run.id)}
                    className={`block w-full border-b px-3 py-3 text-left transition-colors hover:bg-accent/40 ${active ? "bg-accent/50" : ""}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{agent?.name ?? run.agentId}</span>
                      <Badge variant={run.status === "succeeded" ? "secondary" : run.status === "failed" ? "destructive" : "outline"} className="text-[10px]">
                        {run.status}
                      </Badge>
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{runReason(run)}</div>
                    <div className="mt-1 text-xs text-muted-foreground" title={formatDateTime(run.createdAt)}>
                      {runTimeLabel(run)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {!selectedRun ? (
            <EmptyState icon={FileText} message={orchestrationInjectionPage.noSelection} />
          ) : (
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Activity className="h-4 w-4 text-muted-foreground" />
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
                      {runCardCopied ? (
                        <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      )}
                      {runCardCopied ? orchestrationInjectionPage.copyFinalPromptDone : orchestrationInjectionPage.copyFinalPrompt}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <DetailRow label={orchestrationInjectionPage.runRowIdLabel} value={selectedRun.id} />
                  <DetailRow label={orchestrationInjectionPage.status} value={selectedRun.status} />
                  <DetailRow label={orchestrationInjectionPage.source} value={runReason(selectedRun)} />
                  <DetailRow label={orchestrationInjectionPage.startedAt} value={selectedRun.startedAt ? formatDateTime(selectedRun.startedAt) : null} />
                  <DetailRow label={orchestrationInjectionPage.createdAt} value={formatDateTime(selectedRun.createdAt)} />
                  <DetailRow
                    label={orchestrationInjectionPage.agent}
                    value={agentsById.get(selectedRun.agentId)?.name ?? selectedRun.agentId}
                  />
                  {agentsById.get(selectedRun.agentId) ? (
                    <Link to={agentUrl(agentsById.get(selectedRun.agentId)!)} className="text-sm text-primary hover:underline">
                      {agentsById.get(selectedRun.agentId)!.name}
                    </Link>
                  ) : null}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Terminal className="h-4 w-4 text-muted-foreground" />
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
                      {adapterInvocationCardCopied ? (
                        <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      )}
                      {adapterInvocationCardCopied
                        ? orchestrationInjectionPage.copyFinalPromptDone
                        : orchestrationInjectionPage.copyFinalPrompt}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {!adapterEvent ? (
                    <div className="border border-dashed border-border p-3 text-sm text-muted-foreground">
                      {orchestrationInjectionPage.eventUnavailable}
                    </div>
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

              <Card>
                <CardHeader className="pb-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FileText className="h-4 w-4 text-muted-foreground" />
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
                      {finalPromptCopied ? (
                        <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      )}
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
                          <div className="mb-1 font-medium text-foreground">
                            {orchestrationInjectionPage.promptCacheSuppressedLabel}
                          </div>
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
                      <PromptSectionsList key={selectedRun.id} sections={parsedPromptSections} />
                    </div>
                  ) : paragraphSplitChunks.length > 1 ? (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">{orchestrationInjectionPage.promptParagraphFallbackHint}</p>
                      <ParagraphSplitChunksList key={selectedRun.id} chunks={paragraphSplitChunks} />
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
                        <Braces className="h-4 w-4 text-muted-foreground" />
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
                        {contextSnapshotCardCopied ? (
                          <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        ) : (
                          <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        )}
                        {contextSnapshotCardCopied
                          ? orchestrationInjectionPage.copyFinalPromptDone
                          : orchestrationInjectionPage.copyFinalPrompt}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <JsonBlock value={selectedRun.contextSnapshot} />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Workflow className="h-4 w-4 text-muted-foreground" />
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
                        {wakePayloadCardCopied ? (
                          <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        ) : (
                          <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        )}
                        {wakePayloadCardCopied
                          ? orchestrationInjectionPage.copyFinalPromptDone
                          : orchestrationInjectionPage.copyFinalPrompt}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <JsonBlock value={context?.paperclipWake ?? null} />
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
