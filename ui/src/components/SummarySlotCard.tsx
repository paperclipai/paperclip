import { resolveUiMessage, uiErrorDescriptor, type UiMessageDescriptor } from "@/lib/localized-ui-error";
import { t, i18n, useTranslation, Trans } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SummarySlotDocument,
  SummarySlotIssueRef,
  SummarySlotKey,
  SummarySlotRevision,
  SummarySlotScopeKind,
} from "@paperclipai/shared";
import { Bot, Clock3, History, Loader2, RefreshCw, Sparkles } from "lucide-react";

import { agentsApi } from "@/api/agents";
import { builtInAgentsApi, type BuiltInAgentState } from "@/api/builtInAgents";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { summarySlotsApi, type SummarySlotSelector } from "@/api/summarySlots";
import { MarkdownBody } from "@/components/MarkdownBody";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { ConfigureBuiltInAgentModal } from "@/components/ConfigureBuiltInAgentModal";
import { InlineBanner } from "@/components/InlineBanner";
import { describeError } from "@/api/errors";
import { useSummaryDraftStream } from "@/components/useSummaryDraftStream";
import { useCompanyLiveEvent } from "@/context/LiveUpdatesProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";

const SUMMARIZER_KEY = "summarizer";
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const LATEST_REVISION_SELECT_VALUE = "__latest__";
const MAX_REVISION_OPTIONS = 30;

export interface SummarySlotCardProps {
  companyId: string | null | undefined;
  scopeKind: SummarySlotScopeKind;
  scopeId?: string | null;
  slotKey?: SummarySlotKey;
  title: string;
  description?: string;
  className?: string;
}

function issueLabel(issue: SummarySlotIssueRef) {
  return issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title;
}

function revisionLabel(revision: SummarySlotRevision) {
  return t("task-components:rev_29a104d8", { value1: revision.revisionNumber });
}

function formatRevisionTimestamp(date: Date | string) {
  return new Intl.DateTimeFormat(i18n.language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(date)).replace(",", "");
}

function revisionOptionLabel(revision: SummarySlotRevision) {
  return `${revisionLabel(revision)} - ${formatRevisionTimestamp(revision.createdAt)}`;
}

function latestRevisionOptionLabel(
  document: SummarySlotDocument,
  revision: SummarySlotRevision | null,
) {
  return t("final-components-a:latestRevRevisionTime_beb5054d", { revision: document.latestRevisionNumber, time: formatRevisionTimestamp(revision?.createdAt ?? document.updatedAt) });
}

interface LiveGenerationStatus {
  message: string | null;
  currentToolName: string | null;
  lastAssistantSnippet: string | null;
}

function readPayloadString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Pick the single most useful line to show while a summary is generating.
 * Prefers the server-derived status `message`, then the last streamed
 * assistant snippet, then the active tool name. Returns null when nothing
 * has streamed yet so the card falls back to its static generating text.
 */
export function resolveGenerationStatusLine(status: LiveGenerationStatus | null): string | null {
  if (!status) return null;
  if (status.message) return status.message;
  if (status.lastAssistantSnippet) return status.lastAssistantSnippet;
  if (status.currentToolName) return t("final-components-a:workingWithTool_c1f9088c", { tool: status.currentToolName });
  return null;
}

/**
 * Subscribe to the shared LiveUpdates socket and track the generation run's
 * live status derived from `heartbeat.run.progress` events matching the slot's
 * generating issue. Resets whenever the tracked generation changes, and stays
 * null (static fallback) when no events arrive.
 */
function useGenerationStatus(generatingIssueId: string | null): LiveGenerationStatus | null {
  const [status, setStatus] = useState<LiveGenerationStatus | null>(null);

  useEffect(() => {
    setStatus(null);
  }, [generatingIssueId]);

  useCompanyLiveEvent((event) => {
    if (!generatingIssueId) return;
    if (event.type !== "heartbeat.run.progress") return;
    const payload = event.payload ?? {};
    if (payload.issueId !== generatingIssueId) return;
    setStatus({
      message: readPayloadString(payload.message),
      currentToolName: readPayloadString(payload.currentToolName),
      lastAssistantSnippet: readPayloadString(payload.lastAssistantSnippet),
    });
  });

  return generatingIssueId ? status : null;
}

function setupState(state: BuiltInAgentState | undefined) {
  if (!state) return null;
  return state.status === "not_provisioned"
    || state.status === "needs_setup"
    || state.status === "pending_approval"
    ? state
    : null;
}

export function SummarySlotCard({
  companyId,
  scopeKind,
  scopeId = null,
  slotKey = "header",
  title,
  description,
  className,
}: SummarySlotCardProps) {
  useTranslation("task-components");
  const queryClient = useQueryClient();
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [configureOpen, setConfigureOpen] = useState(false);
  const [actionError, setActionError] = useState<UiMessageDescriptor | { raw: string } | null>(null);
  const selector: SummarySlotSelector | null = companyId
    ? { companyId, scopeKind, scopeId, slotKey }
    : null;

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const summariesEnabled = experimentalQuery.data?.enableSummaries === true;
  const builtInAgentsEnabled = experimentalQuery.data?.enableBuiltInAgents === true;

  const builtInAgentsQuery = useQuery({
    queryKey: queryKeys.builtInAgents.list(companyId ?? "__none__"),
    queryFn: () => builtInAgentsApi.list(companyId!),
    enabled: Boolean(companyId && summariesEnabled && builtInAgentsEnabled),
  });

  const summarizerState = builtInAgentsQuery.data?.find(
    (entry) => entry.definition.key === SUMMARIZER_KEY,
  );
  const needsSetup = setupState(summarizerState);

  const slotQueryKey = selector
    ? queryKeys.summarySlots.detail(selector.companyId, selector.scopeKind, selector.slotKey, selector.scopeId)
    : queryKeys.summarySlots.detail("__none__", scopeKind, slotKey, scopeId);
  const revisionsQueryKey = selector
    ? queryKeys.summarySlots.revisions(selector.companyId, selector.scopeKind, selector.slotKey, selector.scopeId)
    : queryKeys.summarySlots.revisions("__none__", scopeKind, slotKey, scopeId);

  const slotQuery = useQuery({
    queryKey: slotQueryKey,
    queryFn: () => summarySlotsApi.get(selector!),
    enabled: Boolean(selector && summariesEnabled),
    refetchInterval: (query) => query.state.data?.slot?.status === "generating" ? 3_000 : false,
  });
  const slotView = useQueryView(slotQuery);
  const slotReady = slotView.kind === "ready" || slotView.kind === "stale";

  const revisionsQuery = useQuery({
    queryKey: revisionsQueryKey,
    queryFn: () => summarySlotsApi.revisions(selector!),
    enabled: Boolean(selector && summariesEnabled && slotQuery.data?.document),
  });

  const generateMutation = useMutation({
    mutationFn: () => summarySlotsApi.generate(selector!),
    onMutate: () => setActionError(null),
    onSuccess: async () => {
      setSelectedRevisionId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: slotQueryKey }),
        queryClient.invalidateQueries({ queryKey: revisionsQueryKey }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? uiErrorDescriptor(error) ?? { raw: error.message } : { key: "final-components-a:summaryGenerationFailed" });
    },
  });

  const resumeSummarizer = useMutation({
    mutationFn: (agentId: string) => agentsApi.resume(agentId, companyId ?? undefined),
    onSuccess: async () => {
      if (companyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.builtInAgents.list(companyId) });
      }
    },
  });

  const revisions = revisionsQuery.data?.revisions ?? [];
  const latestDocument = slotQuery.data?.document ?? null;
  const selectedRevision = useMemo(
    () => revisions.find((revision) => revision.id === selectedRevisionId) ?? null,
    [revisions, selectedRevisionId],
  );
  const latestRevision = latestDocument
    ? revisions.find((revision) => revision.id === latestDocument.latestRevisionId) ?? null
    : null;
  const historicalRevision = selectedRevision && selectedRevision.id !== latestDocument?.latestRevisionId
    ? selectedRevision
    : null;
  const displayedBody = historicalRevision?.body ?? latestDocument?.body ?? "";
  const displayingHistoricalRevision = Boolean(historicalRevision);
  const historicalRevisionOptions = (latestDocument
    ? revisions.filter((revision) => revision.id !== latestDocument.latestRevisionId)
    : revisions)
    .toSorted((left, right) => right.revisionNumber - left.revisionNumber)
    .slice(0, MAX_REVISION_OPTIONS - (latestDocument ? 1 : 0));
  const revisionSelectValue = historicalRevision?.id ?? LATEST_REVISION_SELECT_VALUE;
  const latestSelectLabel = latestDocument ? latestRevisionOptionLabel(latestDocument, latestRevision) : t("task-components:latest_8730d3c2");
  const generatingIssue = slotQuery.data?.generatingIssue ?? null;
  const liveStatusLine = resolveGenerationStatusLine(useGenerationStatus(generatingIssue?.id ?? null));
  const draftStream = useSummaryDraftStream(companyId, generatingIssue);
  // The token-streamed STATUS line is more responsive than the server-derived
  // progress snippet; prefer it and fall back to the Phase 1 status line.
  const generationStatusLine = draftStream.statusLine ?? liveStatusLine;
  const isGenerating = slotQuery.data?.slot?.status === "generating"
    && generatingIssue
    && !TERMINAL_ISSUE_STATUSES.has(generatingIssue.status);
  const generationFailed = slotQuery.data?.slot?.status === "failed";
  const canGenerateFirstSummary = summarizerState?.status === "ready";

  if (experimentalQuery.isLoading || !summariesEnabled) return null;

  const startGeneration = () => {
    if (!selector || generateMutation.isPending) return;
    generateMutation.mutate();
  };

  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">{title}</h2>
            {isGenerating ? <Badge variant="secondary">{t("task-components:generating_3607d4f4")}</Badge> : null}
            {displayingHistoricalRevision ? <Badge variant="outline">{t("task-components:historicalRevision_d7c7ad26")}</Badge> : null}
            {latestDocument && !displayingHistoricalRevision ? <Badge variant="outline">{t("task-components:latestRevision_305ad7b9")}</Badge> : null}
          </div>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {displayingHistoricalRevision ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSelectedRevisionId(null)}
            >{t("task-components:latest_8730d3c2")}</Button>
          ) : null}
          {latestDocument && !generationFailed ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={startGeneration}
              disabled={!selector || generateMutation.isPending || Boolean(isGenerating)}
            >
              {generateMutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}{t("task-components:refresh_0e916101")}</Button>
          ) : null}
        </div>
      </div>

      {needsSetup ? (
        <>
          <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              {needsSetup.status === "pending_approval" ? (
                <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="space-y-1 text-sm">
                <p className="font-medium text-foreground">
                  {needsSetup.status === "pending_approval"
                    ? t("task-components:summarizerSetupIsPendingApproval_5b2d45d4")
                    : t("task-components:setUpTheSummarizer_9606ead9")}
                </p>
                <p className="text-muted-foreground">{t("task-components:summariesAreGeneratedByPaperclipSBuilt_df756a3d")}</p>
              </div>
            </div>
            {needsSetup.status === "pending_approval" ? null : (
              <Button type="button" size="sm" onClick={() => setConfigureOpen(true)}>{t("task-components:setUpSummarizer_3d691da8")}</Button>
            )}
          </div>
          {companyId ? (
            <ConfigureBuiltInAgentModal
              companyId={companyId}
              state={needsSetup}
              open={configureOpen}
              onOpenChange={setConfigureOpen}
              onConfigured={() => setActionError(null)}
            />
          ) : null}
        </>
      ) : null}

      {!needsSetup && summarizerState?.status === "paused" && summarizerState.agent ? (
        <InlineBanner
          tone="warning"
          title={t("task-components:summarizerIsPaused_f20b36c3")}
          actions={
            <Button
              type="button"
              size="sm"
              onClick={() => summarizerState.agent && resumeSummarizer.mutate(summarizerState.agent.id)}
              disabled={resumeSummarizer.isPending}
            >
              {resumeSummarizer.isPending ? t("task-components:resuming_4414358c") : t("task-components:resumeAgent_0bb60c45")}
            </Button>
          }
        >{t("task-components:existingSummariesRemainReadableButNewSummaries_819e45c3")}</InlineBanner>
      ) : null}

      {actionError ? (
        <InlineBanner tone="warning" title={t("task-components:summaryRequestFailed_0fdb9c43")}>
          {"raw" in actionError ? actionError.raw : resolveUiMessage(actionError)}
        </InlineBanner>
      ) : null}

      {slotView.kind === "error" ? (
        <QueryErrorState
          size="panel"
          error={slotView.error}
          action="load the summary"
          onRetry={slotView.retry}
          retrying={slotView.isFetching}
        />
      ) : null}

      {slotReady && generationFailed ? (
        <InlineBanner
          tone="danger"
          title={t("task-components:summaryGenerationFailed_3b09cc4b")}
          actions={
            <Button
              type="button"
              size="sm"
              onClick={startGeneration}
              disabled={!selector || generateMutation.isPending}
            >
              {generateMutation.isPending ? t("task-components:retrying_84a657bc") : t("task-components:retry_942087cc")}
            </Button>
          }
        >
          {slotQuery.data?.slot?.failureReason ?? t("task-components:theGenerationTaskEndedBeforeWritingA_1fa12fb6")}
        </InlineBanner>
      ) : null}

      {slotReady && isGenerating && generatingIssue ? (
        <div className="flex items-start gap-3 text-sm">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          <div className="min-w-0 space-y-1">
            <p className="font-medium text-foreground">{t("task-components:generatingSummary_d60065d5")}</p>
            {generationStatusLine ? (
              <p
                className="animate-pulse truncate text-muted-foreground"
                aria-live="polite"
                data-testid="summary-generation-status-line"
                title={generationStatusLine}
              >
                {generationStatusLine}
              </p>
            ) : null}
            {draftStream.draft ? (
              <div
                className="mt-2 rounded-md border border-border bg-muted/20 p-3"
                data-testid="summary-generation-draft"
                aria-live="polite"
              >
                <MarkdownBody className="text-sm leading-7 text-foreground">
                  {draftStream.draft}
                </MarkdownBody>
                {!draftStream.draftClosed ? (
                  <span
                    className="mt-1 inline-block h-4 w-px animate-pulse bg-foreground align-text-bottom"
                    aria-hidden="true"
                    data-testid="summary-generation-caret"
                  />
                ) : null}
              </div>
            ) : null}
            <p className="text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_6f079beb7494" components={{ part1: <>{<Link className="underline" to={`/issues/${generatingIssue.identifier ?? generatingIssue.id}`}>
                {issueLabel(generatingIssue)}
              </Link>}</> }} /></p>
          </div>
        </div>
      ) : null}

      {slotReady && !latestDocument && !isGenerating && !generationFailed && canGenerateFirstSummary ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">{t("task-components:noSummaryYet_f098ecd6")}</p>
            <p className="text-muted-foreground">{t("task-components:generateAConciseStatusSnapshotForThis_7923cb41")}</p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={startGeneration}
            disabled={!selector || generateMutation.isPending}
          >
            {generateMutation.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {generateMutation.isPending ? t("task-components:generating_49286f33") : t("task-components:generateSummary_ab35d87b")}
          </Button>
        </div>
      ) : null}

      {latestDocument ? (
        <div className="space-y-4">
          <MarkdownBody className="text-sm leading-7 text-foreground">
            {displayedBody}
          </MarkdownBody>

          <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span title={formatDateTime(historicalRevision?.createdAt ?? latestRevision?.createdAt ?? latestDocument.updatedAt)}><Trans ns="task-components" i18nKey="sentence_44d29d05f92a" components={{ part1: <>{relativeTime(historicalRevision?.createdAt ?? latestRevision?.createdAt ?? latestDocument.updatedAt)}</> }} /></span>

            {revisions.length > 1 ? (
              <Select
                value={revisionSelectValue}
                onValueChange={(value) => {
                  setSelectedRevisionId(value === LATEST_REVISION_SELECT_VALUE ? null : value);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="h-auto border-0 bg-transparent p-0 text-xs shadow-none hover:text-foreground focus-visible:ring-0"
                  aria-label={t("task-components:selectSummaryRevision_e9e258ba")}
                  title={historicalRevision ? revisionOptionLabel(historicalRevision) : latestSelectLabel}
                >
                  <SelectValue>
                    <History className="size-3.5" aria-hidden="true" />
                    <span><Trans ns="final-components-a" i18nKey="numeric_1124afd9574e" values={{ length: revisions.length }} /></span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end" position="popper">
                  <SelectItem value={LATEST_REVISION_SELECT_VALUE} className="text-xs">
                    {latestSelectLabel}
                  </SelectItem>
                  {historicalRevisionOptions.length > 0 ? <SelectSeparator /> : null}
                  {historicalRevisionOptions.map((revision) => (
                    <SelectItem
                      key={revision.id}
                      value={revision.id}
                      className="text-xs"
                      title={formatDateTime(revision.createdAt)}
                    >
                      {revisionOptionLabel(revision)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
