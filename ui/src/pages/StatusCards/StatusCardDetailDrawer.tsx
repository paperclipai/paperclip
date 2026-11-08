import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanySearchIssueSummary, StatusCardUpdate, SummarySlotIssueRef } from "@paperclipai/shared";
import { AlertTriangle, ChevronDown, ExternalLink, History, Loader2, RefreshCw, Wand2 } from "lucide-react";

import { statusCardsApi, type StatusCardDryRun } from "@/api/statusCards";
import { describeError } from "@/api/errors";
import { t, useTranslation } from "@/i18n";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { MarkdownBody } from "@/components/MarkdownBody";
import { useSummaryDraftStream } from "@/components/useSummaryDraftStream";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { IssueStatusBadge } from "@/components/StatusBadge";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InlineBanner } from "@/components/InlineBanner";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import {
  deriveStatusCardLifecycle,
  describeRefreshPolicy,
  STATUS_CARD_LIFECYCLE_PRESENTATION,
} from "@/lib/status-card-state";
import {
  StatusCardSettingsForm,
  defaultSettingsValue,
  type StatusCardSettingsValue,
} from "./StatusCardSettingsForm";
import { SummarizerAgentSelect } from "./SummarizerAgentSelect";
import {
  formatCents,
  formatTokens,
  formatTokenSplit,
  rollupUpdatesToday,
  updateKindLabel,
} from "./format";
import type { StatusCardView } from "./types";
import { taskStatusIconProps } from "@/lib/task-status-presentation";

export function StatusCardDetailDrawer({
  card,
  companyId,
  open,
  onOpenChange,
  initialTab = "summary",
}: {
  card: StatusCardView | null;
  companyId: string | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: string;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("summary");
  const [settings, setSettings] = useState<StatusCardSettingsValue>(defaultSettingsValue());
  // Rename + interest ("query") are edited in Settings alongside the policy.
  const [title, setTitle] = useState("");
  const [interest, setInterest] = useState("");
  // "" → the built-in Summarizer; otherwise the id of the override agent.
  const [summarizerAgentId, setSummarizerAgentId] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  // A short confirmation after a build/refresh is queued (the state dot + badge
  // also update, but a card that finishes fast can look like "nothing happened").
  const [actionNote, setActionNote] = useState<string | null>(null);
  // null → show the latest summary; otherwise a historical update id.
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);

  useEffect(() => {
    if (card) {
      setSettings({ refreshPolicy: card.refreshPolicy });
      setTitle(card.title ?? "");
      setInterest(card.interestPrompt);
      setSummarizerAgentId(card.agentId ?? "");
      setActionError(null);
      setActionNote(null);
      setSelectedRevisionId(null);
    }
  }, [card]);

  // Open to the requested tab (e.g. "Query debug" on the tile deep-links to
  // Settings) whenever the drawer (re)opens.
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  const updatesQuery = useQuery({
    queryKey: card ? queryKeys.statusCards.updates(card.id) : ["status-cards", "detail", "none", "updates"],
    queryFn: () => statusCardsApi.updates(card!.id),
    enabled: Boolean(card && open),
  });
  const updatesView = useQueryView(updatesQuery);
  const summaryRevisionsQuery = useQuery({
    queryKey: card ? queryKeys.statusCards.summaryRevisions(card.id) : ["status-cards", "detail", "none", "summary-revisions"],
    queryFn: () => statusCardsApi.summaryRevisions(card!.id),
    enabled: Boolean(card && open && card.documentId),
  });
  const dryRunQuery = useQuery({
    queryKey: card ? queryKeys.statusCards.dryRun(card.id) : ["status-cards", "detail", "none", "dry-run"],
    queryFn: () => statusCardsApi.dryRun(card!.id),
    enabled: Boolean(card && open && tab === "watched" && (card.queries.length > 0 || (card.mentionedIssueIds?.length ?? 0) > 0)),
  });
  const dryRunView = useQueryView(dryRunQuery);
  const lifecycle = card ? deriveStatusCardLifecycle(card) : "fresh";
  const generatingIssue = useMemo<SummarySlotIssueRef | null>(
    () =>
      card && lifecycle === "updating" && card.generatingIssueId
        ? { id: card.generatingIssueId, identifier: null, title: card.title ?? "Status update", status: "in_progress" }
        : null,
    [card, lifecycle],
  );
  const draftStream = useSummaryDraftStream(companyId, generatingIssue);

  const invalidateCard = async () => {
    if (!card) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.list(card.companyId, false) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.detail(card.id) }),
    ]);
  };

  const refreshMutation = useMutation({
    mutationFn: () => statusCardsApi.refresh(card!.id),
    onMutate: () => {
      setActionError(null);
      setActionNote(null);
    },
    onSuccess: async () => {
      await invalidateCard();
      setActionNote(t("statusCards.drawer.refreshQueuedNote", { defaultValue: "Refresh queued — the Summarizer is updating this card." }));
    },
    onError: (err) => setActionError(describeError(err, { action: t("errorActions.refreshTheCard") }).body),
  });

  const recompileMutation = useMutation({
    mutationFn: () => statusCardsApi.recompile(card!.id),
    onMutate: () => {
      setActionError(null);
      setActionNote(null);
    },
    onSuccess: async () => {
      await invalidateCard();
      setActionNote(t("statusCards.drawer.runQueuedNote", { defaultValue: "Run queued — the Summarizer is updating this card." }));
    },
    onError: (err) => setActionError(describeError(err, { action: t("errorActions.runTheCard") }).body),
  });

  const saveSettingsMutation = useMutation({
    mutationFn: () => {
      const trimmedTitle = title.trim();
      const trimmedInterest = interest.trim();
      const interestChanged = trimmedInterest.length > 0 && trimmedInterest !== card!.interestPrompt.trim();
      return statusCardsApi.patch(card!.id, {
        // An explicit name pins the title so a recompile won't overwrite it;
        // clearing it hands naming back to the compiler.
        title: trimmedTitle || null,
        titlePinned: trimmedTitle.length > 0,
        // Editing the card prompt triggers a server-side recompile.
        ...(interestChanged ? { interestPrompt: trimmedInterest } : {}),
        agentId: summarizerAgentId || null,
        refreshPolicy: settings.refreshPolicy,
      });
    },
    onMutate: () => setActionError(null),
    onSuccess: async () => {
      if (!card) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.list(card.companyId, false) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.detail(card.id) }),
      ]);
    },
    onError: (err) => setActionError(describeError(err, { action: t("errorActions.saveTheSettings") }).body),
  });

  if (!card) return null;

  const updates = updatesQuery.data ?? [];
  const latestUpdate = updates[0] ?? null;
  const todayRollup = rollupUpdatesToday(updates);

  // Each successful summary-producing update is a summary revision (reuses the
  // SummarySlotCard revision-history pattern). The finishedAt check excludes
  // updates whose generation is still in flight — their document revision does
  // not exist yet.
  const summaryRevisions = updates.filter(
    (update) => update.status === "ok" && update.finishedAt && (update.kind === "full" || update.kind === "incremental"),
  );
  const selectedRevision = selectedRevisionId
    ? summaryRevisions.find((update) => update.id === selectedRevisionId) ?? null
    : null;
  // Updates (newest-first, completed content updates only) correspond 1:1 with
  // the card's summary-document revisions (newest-first): writeSummary creates
  // both in one transaction. Positional matching recovers the full summary
  // body for a historical pick; the change-summary fallback covers any gap.
  const documentRevisions = summaryRevisionsQuery.data ?? [];
  const selectedRevisionBody = selectedRevision
    ? documentRevisions[summaryRevisions.indexOf(selectedRevision)]?.body ?? null
    : null;
  const latestRevisionNumber = summaryRevisions.length;
  const revisionNumberOf = (update: StatusCardUpdate) => latestRevisionNumber - summaryRevisions.indexOf(update);
  const displayedChanges = selectedRevision ? selectedRevision.changes : latestUpdate?.changes ?? [];
  const presentation = STATUS_CARD_LIFECYCLE_PRESENTATION[lifecycle];
  const hasSummary = Boolean(card.summaryBody && card.summaryBody.trim().length > 0);
  // Setup is genuinely in flight only while a generation task exists; a null id
  // on a compiling card means the first run stalled and needs a manual re-kick.
  const setupRunning = lifecycle === "compiling" && Boolean(card.generatingIssueId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border p-4">
          <div className="flex items-center gap-2 pr-8">
            <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", presentation.dotClassName)} aria-hidden="true" />
            <SheetTitle className="min-w-0 flex-1 truncate text-lg">{card.title ?? t("statusCards.drawer.untitledCard", { defaultValue: "Untitled card" })}</SheetTitle>
            <Badge variant="outline">{presentation.label}</Badge>
            {lifecycle === "compiling" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => recompileMutation.mutate()}
                // While the setup run is live, "Run now" is disabled — kicking a
                // second run would race the one already building the card.
                disabled={recompileMutation.isPending || setupRunning}
              >
                {setupRunning || recompileMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wand2 className="h-3.5 w-3.5" />
                )}
                {setupRunning ? t("statusCards.drawer.settingUp", { defaultValue: "Setting up…" }) : recompileMutation.isPending ? t("statusCards.drawer.running", { defaultValue: "Running…" }) : t("statusCards.drawer.runNow", { defaultValue: "Run now" })}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => refreshMutation.mutate()}
                disabled={refreshMutation.isPending || lifecycle === "updating"}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", refreshMutation.isPending && "animate-spin")} />
                {refreshMutation.isPending ? t("statusCards.drawer.refreshing", { defaultValue: "Refreshing…" }) : t("statusCards.drawer.refresh", { defaultValue: "Refresh" })}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {card.lastGeneratedAt ? t("statusCards.drawer.updatedTime", { time: relativeTime(card.lastGeneratedAt), defaultValue: `Updated ${relativeTime(card.lastGeneratedAt)}` }) : t("statusCards.drawer.noSummaryYet", { defaultValue: "No summary yet" })} ·{" "}
            {describeRefreshPolicy(card.refreshPolicy)}
          </p>
        </SheetHeader>

        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList variant="line" className="w-full justify-start gap-4 border-b border-border px-4">
            <TabsTrigger value="summary">{t("statusCards.drawer.tabSummary", { defaultValue: "Summary" })}</TabsTrigger>
            <TabsTrigger value="settings">{t("statusCards.drawer.tabSettings", { defaultValue: "Settings" })}</TabsTrigger>
            <TabsTrigger value="watched">{t("statusCards.drawer.tabWatched", { defaultValue: "Watched issues" })}</TabsTrigger>
            <TabsTrigger value="history">{t("statusCards.drawer.tabHistory", { defaultValue: "History" })}</TabsTrigger>
          </TabsList>

          {actionError ? (
            <div className="px-4 pt-3">
              <InlineBanner tone="warning" title={t("statusCards.header.headsUp", { defaultValue: "Heads up" })}>{actionError}</InlineBanner>
            </div>
          ) : actionNote ? (
            <div className="px-4 pt-3">
              <InlineBanner tone="info" title={t("statusCards.drawer.workingOnIt", { defaultValue: "Working on it" })}>{actionNote}</InlineBanner>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <TabsContent value="summary" className="mt-0 space-y-5">
              {/* Revision picker lives on the right, unpilled. A single-revision
                  card shows a plain label; multi-revision cards get a dropdown
                  capped at the 30 most recent revisions. */}
              {(hasSummary || summaryRevisions.length > 0) && lifecycle !== "compiling" ? (
                <div className="flex items-center justify-end gap-2">
                  {summaryRevisions.length > 1 ? (
                    <Select
                      value={selectedRevisionId ?? "__latest__"}
                      onValueChange={(value) => setSelectedRevisionId(value === "__latest__" ? null : value)}
                    >
                      <SelectTrigger size="sm" className="w-auto gap-1.5" aria-label={t("statusCards.drawer.selectRevision", { defaultValue: "Select summary revision" })}>
                        <History className="h-3.5 w-3.5" aria-hidden="true" />
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end" position="popper">
                        <SelectItem value="__latest__" className="text-xs">
                          {t("statusCards.drawer.revisionLatest", { num: latestRevisionNumber, defaultValue: `Revision ${latestRevisionNumber} · latest` })}
                        </SelectItem>
                        <SelectSeparator />
                        {summaryRevisions.slice(0, 30).map((update) => (
                          <SelectItem
                            key={update.id}
                            value={update.id}
                            className="text-xs"
                            title={formatDateTime(update.startedAt)}
                          >
                            {t("statusCards.drawer.revShort", { num: revisionNumberOf(update), kind: updateKindLabel(update.kind), time: relativeTime(update.startedAt), defaultValue: `Rev ${revisionNumberOf(update)} · ${updateKindLabel(update.kind)} · ${relativeTime(update.startedAt)}` })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : latestRevisionNumber > 0 ? (
                    <span className="text-xs text-muted-foreground">{t("statusCards.drawer.revisionSimple", { num: latestRevisionNumber, defaultValue: `Revision ${latestRevisionNumber} · latest` })}</span>
                  ) : null}
                </div>
              ) : null}

              {lifecycle === "updating" && draftStream.draft && !selectedRevision ? (
                <MarkdownBody className="text-sm leading-7">{draftStream.draft}</MarkdownBody>
              ) : selectedRevision ? (
                <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground" title={formatDateTime(selectedRevision.startedAt)}>
                    {t("statusCards.drawer.revisionHeader", { num: revisionNumberOf(selectedRevision), kind: updateKindLabel(selectedRevision.kind), time: relativeTime(selectedRevision.startedAt), defaultValue: `Revision ${revisionNumberOf(selectedRevision)} · ${updateKindLabel(selectedRevision.kind)} · ${relativeTime(selectedRevision.startedAt)}` })}

                  </p>
                  {selectedRevisionBody ? (
                    <MarkdownBody className="text-sm leading-7">{selectedRevisionBody}</MarkdownBody>
                  ) : selectedRevision.changeSummary ? (
                    <>
                      <MarkdownBody className="text-sm leading-7">{selectedRevision.changeSummary}</MarkdownBody>
                      <p className="text-xs text-muted-foreground/70">
                        {t("statusCards.drawer.revisionUnavailable", { defaultValue: "The full summary text for this revision is unavailable — showing its change summary. The integrated changes below are the live ledger for this revision." })}

                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t("statusCards.drawer.noChangeSummary", { defaultValue: "No change summary was recorded for this revision." })}
                    </p>
                  )}
                </div>
              ) : hasSummary ? (
                <MarkdownBody className="text-sm leading-7">{card.summaryBody!}</MarkdownBody>
              ) : lifecycle === "compiling" ? (
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p className="flex items-center gap-2">
                    {setupRunning ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                    )}
                    {setupRunning
                      ? t("statusCards.drawer.settingUpSummaryWait", { defaultValue: "Setting up — the first summary is generated automatically once this finishes." })
                      : t("statusCards.drawer.setupDidntFinishRetry", { defaultValue: "Setup didn’t finish. Run it now to try again." })}
                  </p>
                  {setupRunning && card.generatingIssueId ? (
                    <Link
                      to={`/issues/${card.generatingIssueId}`}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground underline-offset-2 hover:underline"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {t("statusCards.drawer.viewSetupTask", { defaultValue: "View setup task" })}
                    </Link>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("statusCards.drawer.noSummaryYetFinished", { defaultValue: "No summary yet — the first one is generated automatically once this card finishes setting up." })}
                </p>
              )}

              {displayedChanges.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {selectedRevision ? t("statusCards.drawer.integratedInRevision", { defaultValue: "Integrated in this revision" }) : t("statusCards.drawer.integratedInUpdate", { defaultValue: "Integrated in this update" })} (
                    {displayedChanges.length} {displayedChanges.length === 1 ? t("statusCards.tile.changeSingular", { defaultValue: "change" }) : t("statusCards.tile.changePlural", { defaultValue: "changes" })})
                  </h3>
                  <div className="space-y-1.5">
                    {displayedChanges.map((change) => (
                      <ChangeRow key={change.issueId} change={change} />
                    ))}
                  </div>
                </section>
              ) : null}
            </TabsContent>

            <TabsContent value="history" className="mt-0 space-y-3">
              {/* History and cost live together: the today rollup up top, then
                  every recorded update (each update is one summary revision). */}
              {updatesQuery.isLoading || updatesView.kind === "reconnecting" ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("statusCards.drawer.loadingHistory", { defaultValue: "Loading history…" })}
                </div>
              ) : updates.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("statusCards.drawer.noUpdatesYet", { defaultValue: "No updates recorded yet." })}</p>
              ) : (
                <>
                  <div className="text-xs text-muted-foreground">
                    {t("statusCards.drawer.todayRollup", {
                      count: todayRollup.updateCount,
                      updateWord: todayRollup.updateCount === 1
                        ? t("statusCards.drawer.updateSingular", { defaultValue: "update" })
                        : t("statusCards.drawer.updatePlural", { defaultValue: "updates" }),
                      tokens: formatTokens(todayRollup.totalTokens),
                      cost: formatCents(todayRollup.totalCostCents),
                      defaultValue: `Today: ${todayRollup.updateCount} ${todayRollup.updateCount === 1 ? "update" : "updates"} · ${formatTokens(todayRollup.totalTokens)} · ${formatCents(todayRollup.totalCostCents)}`,
                    })}


                    {card.refreshPolicy.dailyTokenCap ? ` · ${t("statusCards.drawer.dailyCap", { tokens: formatTokens(card.refreshPolicy.dailyTokenCap), defaultValue: `daily cap ${formatTokens(card.refreshPolicy.dailyTokenCap)}` })}` : ""}
                  </div>
                  <div className="divide-y divide-border">
                    {updates.map((update) => (
                      <div key={update.id} className="py-2.5 first:pt-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2 text-sm font-medium">
                            {updateKindLabel(update.kind)}
                            <Badge variant={update.status === "failed" ? "destructive" : "secondary"}>
                              {update.status === "ok" ? update.trigger : update.status}
                            </Badge>
                          </span>
                          <span className="text-xs text-muted-foreground" title={formatDateTime(update.startedAt)}>
                            {relativeTime(update.startedAt)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatTokenSplit(update.inputTokens, update.outputTokens)} · {formatCents(update.costCents)}
                          {update.model ? ` · ${update.model}` : ""}
                          {update.changes.length > 0 ? ` · ${update.changes.length} changes` : ""}
                        </p>
                        {update.error ? <p className="mt-1 text-xs text-destructive">{update.error}</p> : null}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </TabsContent>

            <TabsContent value="watched" className="mt-0 space-y-3">
              {card.queries.length === 0 && (card.mentionedIssueIds?.length ?? 0) === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  {t("statusCards.drawer.cardStillSettingUpWatched", { defaultValue: "This card is still setting up — the issues it watches appear here once it's ready." })}
                </div>
              ) : dryRunQuery.isLoading || dryRunView.kind === "reconnecting" ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("statusCards.drawer.matchingIssues", { defaultValue: "Matching issues…" })}
                </div>
              ) : dryRunView.kind === "error" ? (
                <QueryErrorState
                  error={dryRunView.error}
                  action={t("statusCards.drawer.loadMatchedFailed", { defaultValue: "load matched issues" })}
                  onRetry={dryRunView.retry}
                  retrying={dryRunView.isFetching}
                />
              ) : (
                <MatchedIssueList
                  queries={dryRunQuery.data?.queries ?? []}
                  mentioned={dryRunQuery.data?.mentionedIssues ?? []}
                />
              )}
            </TabsContent>

            <TabsContent value="settings" className="mt-0 space-y-6">
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">{t("statusCards.drawer.cardNameLabel", { defaultValue: "Card name" })}</h3>
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={t("statusCards.drawer.cardNamePlaceholder", { defaultValue: "Auto-named from the query" })}
                  className="text-sm"
                  aria-label={t("statusCards.drawer.cardNameLabel", { defaultValue: "Card name" })}
                />
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">{t("statusCards.drawer.whatWatchesLabel", { defaultValue: "What this card watches & reports" })}</h3>
                <Textarea
                  value={interest}
                  onChange={(event) => setInterest(event.target.value)}
                  rows={3}
                  className="text-sm"
                  aria-label={t("statusCards.drawer.whatWatchesLabel", { defaultValue: "What this card watches & reports" })}
                />
                <p className="text-xs text-muted-foreground">
                  {t("statusCards.drawer.whatWatchesHelp", { defaultValue: "This one message drives the whole card: the agent compiles the watch query from it and follows it as the instructions for every update. Editing it rebuilds the card." })}

                </p>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">{t("statusCards.drawer.agentLabel", { defaultValue: "Agent" })}</h3>
                <SummarizerAgentSelect
                  companyId={card.companyId}
                  value={summarizerAgentId}
                  onChange={setSummarizerAgentId}
                  enabled={open}
                />
              </section>

              <StatusCardSettingsForm value={settings} onChange={setSettings} />

              <QueryDebugSection card={card} />

              <div className="flex justify-end border-t border-border pt-4">
                <Button onClick={() => saveSettingsMutation.mutate()} disabled={saveSettingsMutation.isPending}>
                  {saveSettingsMutation.isPending ? <Loader2 className="animate-spin" /> : null}
                  {t("statusCards.drawer.save", { defaultValue: "Save" })}
                </Button>
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The compiled query is agent-maintained (the Summarizer writes it from its
 * generation task) and normally hidden. Surfaced read-only here (moved out of
 * the old standalone debug drawer, PAP-15223) so the raw query + version stay
 * inspectable without leaving Settings.
 */
function QueryDebugSection({ card }: { card: StatusCardView }) {
  const queryJson = JSON.stringify({ queries: card.queries, limit: 50 }, null, 2);
  return (
    <Collapsible className="rounded-md border border-border">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2.5 text-sm font-semibold">
        <span className="flex items-center gap-2">
          {t("statusCards.drawer.queryDebug", { defaultValue: "Query debug" })}
          <Badge variant="secondary">v{card.queryVersion}</Badge>
        </span>
        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t border-border px-3 py-3">
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs text-foreground">
          {card.queries.length > 0 ? queryJson : t("statusCards.drawer.queryNotCompiledYet", { defaultValue: "// query not compiled yet" })}
        </pre>
        <p className="text-xs text-muted-foreground">
          {card.queryCompiledAt
            ? t("statusCards.drawer.queryCompiledHelp", {
                time: relativeTime(card.queryCompiledAt),
                version: card.queryVersion,
                defaultValue: `Compiled by Summarizer ${relativeTime(card.queryCompiledAt)} · version ${card.queryVersion}. Edit “What this card watches” above to rebuild it.`
              })
            : t("statusCards.drawer.queryNotCompiledHelp", { defaultValue: "Not compiled yet. The query builds automatically once the card finishes setting up." })}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Live matched-issue list for the Watched tab, fed by the dry-run endpoint.
 * Queries in the compiled array are a union, so issues matched by more than
 * one query are deduplicated by id. Issues mentioned in the latest summary
 * join the watched set too and render as their own group below the matches.
 */
function MatchedIssueList({ queries, mentioned }: { queries: StatusCardDryRun["queries"]; mentioned: CompanySearchIssueSummary[] }) {
  const seen = new Set<string>();
  const matched: CompanySearchIssueSummary[] = [];
  for (const { result } of queries) {
    for (const item of result.results) {
      if (!item.issue || seen.has(item.issue.id)) continue;
      seen.add(item.issue.id);
      matched.push(item.issue);
    }
  }
  const mentionedOnly = mentioned.filter((issue) => !seen.has(issue.id));
  if (matched.length === 0 && mentionedOnly.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
        {t("statusCards.drawer.matchesNoIssues", { defaultValue: "The compiled query matches no issues right now." })}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {matched.length > 0 ? (
        <div className="space-y-1.5">
          {matched.map((issue) => (
            <WatchedIssueRow key={issue.id} issue={issue} />
          ))}
        </div>
      ) : null}
      {mentionedOnly.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">{t("statusCards.drawer.mentionedInLatest", { defaultValue: "Mentioned in the latest update" })}</p>
          {mentionedOnly.map((issue) => (
            <WatchedIssueRow key={issue.id} issue={issue} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WatchedIssueRow({ issue }: { issue: CompanySearchIssueSummary }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        className="shrink-0 font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {issue.identifier ?? issue.id.slice(0, 8)}
      </Link>
      <IssueStatusBadge {...taskStatusIconProps(issue)} />
      <span className="min-w-0 flex-1 truncate">{issue.title}</span>
      <span className="shrink-0 text-muted-foreground">{relativeTime(issue.updatedAt)}</span>
    </div>
  );
}

/**
 * One row in the "Integrated in this update" change list. Status transitions
 * render with the product's issue status pills (recognition over recall,
 * design-system consistency) and every row deep-links to the issue.
 */
function ChangeRow({ change }: { change: StatusCardUpdate["changes"][number] }) {
  const isTransition = Boolean(change.from && change.to);
  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
      <Link
        to={`/issues/${change.identifier}`}
        className="shrink-0 font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {change.identifier}
      </Link>
      {isTransition ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <IssueStatusBadge status={change.from!} />
          <span aria-hidden="true" className="text-muted-foreground">→</span>
          <IssueStatusBadge status={change.to!} />
        </span>
      ) : (
        <span className="truncate text-muted-foreground">{describeChangeKind(change.changeKind)}</span>
      )}
    </div>
  );
}

function describeChangeKind(changeKind: string): string {
  if (changeKind === "entered_query" || changeKind === "new") return t("statusCards.drawer.newIssueMatchedQuery", { defaultValue: "new issue matched the query" });
  if (changeKind === "left_query") return t("statusCards.drawer.leftQuery", { defaultValue: "left the query" });
  return changeKind.replace(/_/g, " ");
}
