import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StatusCardUpdate, SummarySlotIssueRef } from "@paperclipai/shared";
import { History, Loader2, RefreshCw } from "lucide-react";

import { statusCardsApi } from "@/api/statusCards";
import { MarkdownBody } from "@/components/MarkdownBody";
import { useSummaryDraftStream } from "@/components/useSummaryDraftStream";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  formatCents,
  formatTokens,
  formatTokenSplit,
  rollupUpdatesToday,
  updateKindLabel,
} from "./format";
import type { StatusCardView } from "./types";

export function StatusCardDetailDrawer({
  card,
  companyId,
  open,
  onOpenChange,
  onOpenDebug,
}: {
  card: StatusCardView | null;
  companyId: string | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenDebug: () => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("summary");
  const [settings, setSettings] = useState<StatusCardSettingsValue>(defaultSettingsValue());
  const [actionError, setActionError] = useState<string | null>(null);
  // null → show the latest summary; otherwise a historical update id.
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);

  useEffect(() => {
    if (card) {
      setSettings({
        instructionsMode: card.instructionsMode,
        instructions: card.instructions ?? "",
        refreshPolicy: card.refreshPolicy,
      });
      setActionError(null);
      setSelectedRevisionId(null);
    }
  }, [card]);

  const updatesQuery = useQuery({
    queryKey: card ? queryKeys.statusCards.updates(card.id) : ["status-cards", "detail", "none", "updates"],
    queryFn: () => statusCardsApi.updates(card!.id),
    enabled: Boolean(card && open),
  });

  const lifecycle = card ? deriveStatusCardLifecycle(card) : "fresh";
  const generatingIssue = useMemo<SummarySlotIssueRef | null>(
    () =>
      card && lifecycle === "updating" && card.generatingIssueId
        ? { id: card.generatingIssueId, identifier: null, title: card.title ?? "Status update", status: "in_progress" }
        : null,
    [card, lifecycle],
  );
  const draftStream = useSummaryDraftStream(companyId, generatingIssue);

  const refreshMutation = useMutation({
    mutationFn: () => statusCardsApi.refresh(card!.id),
    onMutate: () => setActionError(null),
    onSuccess: async () => {
      if (!card) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.list(card.companyId, false) });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Could not refresh the card."),
  });

  const saveSettingsMutation = useMutation({
    mutationFn: () =>
      statusCardsApi.patch(card!.id, {
        instructionsMode: settings.instructionsMode,
        instructions: settings.instructionsMode === "none" ? null : settings.instructions.trim() || null,
        refreshPolicy: settings.refreshPolicy,
      }),
    onMutate: () => setActionError(null),
    onSuccess: async () => {
      if (!card) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.list(card.companyId, false) });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Could not save settings."),
  });

  if (!card) return null;

  const updates = updatesQuery.data ?? [];
  const latestUpdate = updates[0] ?? null;
  const todayRollup = rollupUpdatesToday(updates);

  // Each successful summary-producing update is a summary revision (reuses the
  // SummarySlotCard revision-history pattern). The full per-revision summary
  // body lands with the summary-document store (P4); until then a historical
  // pick surfaces that revision's change summary + integrated changes, which
  // are real P1 ledger data.
  const summaryRevisions = updates.filter(
    (update) => update.status === "ok" && (update.kind === "full" || update.kind === "incremental"),
  );
  const selectedRevision = selectedRevisionId
    ? summaryRevisions.find((update) => update.id === selectedRevisionId) ?? null
    : null;
  const latestRevisionNumber = summaryRevisions.length;
  const revisionNumberOf = (update: StatusCardUpdate) => latestRevisionNumber - summaryRevisions.indexOf(update);
  const displayedChanges = selectedRevision ? selectedRevision.changes : latestUpdate?.changes ?? [];
  const presentation = STATUS_CARD_LIFECYCLE_PRESENTATION[lifecycle];
  const hasSummary = Boolean(card.summaryBody && card.summaryBody.trim().length > 0);
  const watchedCount = card.watchedIssueCount ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border p-4">
          <div className="flex items-center gap-2 pr-8">
            <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", presentation.dotClassName)} aria-hidden="true" />
            <SheetTitle className="min-w-0 flex-1 truncate text-lg">{card.title ?? "Untitled card"}</SheetTitle>
            <Badge variant="outline">{presentation.label}</Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending || lifecycle === "updating"}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshMutation.isPending && "animate-spin")} />
              Refresh
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {card.lastGeneratedAt ? `Updated ${relativeTime(card.lastGeneratedAt)}` : "No summary yet"} ·{" "}
            {describeRefreshPolicy(card.refreshPolicy)}
            {watchedCount !== null ? ` · watching ${watchedCount} issues` : ""} ·{" "}
            <button type="button" onClick={onOpenDebug} className="underline hover:text-foreground">
              debug
            </button>
          </p>
        </SheetHeader>

        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList variant="line" className="w-full justify-start gap-4 border-b border-border px-4">
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="updates">Updates ({updates.length})</TabsTrigger>
            <TabsTrigger value="watched">Watched issues{watchedCount !== null ? ` (${watchedCount})` : ""}</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          {actionError ? (
            <div className="px-4 pt-3">
              <InlineBanner tone="warning" title="Heads up">{actionError}</InlineBanner>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <TabsContent value="summary" className="mt-0 space-y-5">
              {(hasSummary || summaryRevisions.length > 0) && lifecycle !== "compiling" ? (
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">
                      {selectedRevision
                        ? `Revision ${revisionNumberOf(selectedRevision)}`
                        : latestRevisionNumber > 0
                          ? `Revision ${latestRevisionNumber} · latest`
                          : "Latest"}
                    </Badge>
                    {selectedRevision ? (
                      <button
                        type="button"
                        onClick={() => setSelectedRevisionId(null)}
                        className="text-xs text-muted-foreground underline hover:text-foreground"
                      >
                        Back to latest
                      </button>
                    ) : null}
                  </div>
                  {summaryRevisions.length > 1 ? (
                    <Select
                      value={selectedRevisionId ?? "__latest__"}
                      onValueChange={(value) => setSelectedRevisionId(value === "__latest__" ? null : value)}
                    >
                      <SelectTrigger size="sm" className="w-auto gap-1.5" aria-label="Select summary revision">
                        <History className="h-3.5 w-3.5" aria-hidden="true" />
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end" position="popper">
                        <SelectItem value="__latest__" className="text-xs">
                          Latest (Rev {latestRevisionNumber})
                        </SelectItem>
                        <SelectSeparator />
                        {summaryRevisions.map((update) => (
                          <SelectItem
                            key={update.id}
                            value={update.id}
                            className="text-xs"
                            title={formatDateTime(update.startedAt)}
                          >
                            Rev {revisionNumberOf(update)} · {updateKindLabel(update.kind)} · {relativeTime(update.startedAt)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </div>
              ) : null}

              {lifecycle === "updating" && draftStream.draft && !selectedRevision ? (
                <MarkdownBody className="text-sm leading-7">{draftStream.draft}</MarkdownBody>
              ) : selectedRevision ? (
                <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground" title={formatDateTime(selectedRevision.startedAt)}>
                    Revision {revisionNumberOf(selectedRevision)} · {updateKindLabel(selectedRevision.kind)} ·{" "}
                    {relativeTime(selectedRevision.startedAt)}
                  </p>
                  {selectedRevision.changeSummary ? (
                    <MarkdownBody className="text-sm leading-7">{selectedRevision.changeSummary}</MarkdownBody>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No change summary was recorded for this revision.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground/70">
                    The full summary text for past revisions renders once the summary-document history store lands (P4).
                    The integrated changes below are the live ledger for this revision.
                  </p>
                </div>
              ) : hasSummary ? (
                <MarkdownBody className="text-sm leading-7">{card.summaryBody!}</MarkdownBody>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No summary has been generated yet. The first summary follows automatically once the query compiles.
                </p>
              )}

              {displayedChanges.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {selectedRevision ? "Integrated in this revision" : "Integrated in this update"} (
                    {displayedChanges.length} {displayedChanges.length === 1 ? "change" : "changes"})
                  </h3>
                  <div className="space-y-1.5">
                    {displayedChanges.map((change) => (
                      <ChangeRow key={change.issueId} change={change} />
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="space-y-1 border-t border-border pt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">History &amp; cost</h3>
                {updates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No updates recorded yet.</p>
                ) : (
                  <>
                    {updates.slice(0, 4).map((update) => (
                      <p key={update.id} className="text-xs text-muted-foreground">
                        {relativeTime(update.startedAt)} · {updateKindLabel(update.kind)} ·{" "}
                        {formatTokenSplit(update.inputTokens, update.outputTokens)} · {formatCents(update.costCents)}
                        {update.status === "failed" ? " · failed" : ""}
                      </p>
                    ))}
                    <p className="pt-1 text-xs text-foreground">
                      Today: {todayRollup.updateCount}{" "}
                      {todayRollup.updateCount === 1 ? "update" : "updates"} ·{" "}
                      {formatTokens(todayRollup.totalTokens)} · {formatCents(todayRollup.totalCostCents)}
                      {card.refreshPolicy.dailyTokenCap ? ` · daily cap ${formatTokens(card.refreshPolicy.dailyTokenCap)}` : ""}
                    </p>
                  </>
                )}
              </section>
            </TabsContent>

            <TabsContent value="updates" className="mt-0 space-y-2">
              {updatesQuery.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading updates…
                </div>
              ) : updates.length === 0 ? (
                <p className="text-sm text-muted-foreground">No updates recorded yet.</p>
              ) : (
                updates.map((update) => (
                  <div key={update.id} className="rounded-md border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {updateKindLabel(update.kind)}
                        <Badge variant={update.status === "failed" ? "destructive" : "secondary"}>
                          {update.status === "failed" ? "failed" : update.trigger}
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
                ))
              )}
            </TabsContent>

            <TabsContent value="watched" className="mt-0 space-y-3">
              <p className="text-sm text-muted-foreground">
                This card watches issues matched by its compiled query{watchedCount !== null ? ` (${watchedCount} right now)` : ""}.
              </p>
              <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                The live matched-issue list is provided by the P2 compile pipeline. Open{" "}
                <button type="button" onClick={onOpenDebug} className="underline hover:text-foreground">
                  Query debug
                </button>{" "}
                to inspect the compiled query.
              </div>
            </TabsContent>

            <TabsContent value="settings" className="mt-0 space-y-5">
              <StatusCardSettingsForm value={settings} onChange={setSettings} />
              <div className="flex justify-end border-t border-border pt-4">
                <Button onClick={() => saveSettingsMutation.mutate()} disabled={saveSettingsMutation.isPending}>
                  {saveSettingsMutation.isPending ? <Loader2 className="animate-spin" /> : null}
                  Save
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
  if (changeKind === "entered_query" || changeKind === "new") return "new issue matched the query";
  if (changeKind === "left_query") return "left the query";
  return changeKind.replace(/_/g, " ");
}
