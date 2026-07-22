import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SummarySlotIssueRef } from "@paperclipai/shared";
import { Loader2, RefreshCw } from "lucide-react";

import { statusCardsApi } from "@/api/statusCards";
import { MarkdownBody } from "@/components/MarkdownBody";
import { useSummaryDraftStream } from "@/components/useSummaryDraftStream";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  describeChange,
  formatCents,
  formatTokens,
  formatTokenSplit,
  rollupUpdates,
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

  useEffect(() => {
    if (card) {
      setSettings({
        instructionsMode: card.instructionsMode,
        instructions: card.instructions ?? "",
        refreshPolicy: card.refreshPolicy,
      });
      setActionError(null);
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
    onError: () =>
      setActionError("Manual refresh will be available when the update engine (P4) is enabled."),
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
  const rollup = rollupUpdates(updates);
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
              {lifecycle === "updating" && draftStream.draft ? (
                <MarkdownBody className="text-sm leading-7">{draftStream.draft}</MarkdownBody>
              ) : hasSummary ? (
                <MarkdownBody className="text-sm leading-7">{card.summaryBody!}</MarkdownBody>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No summary has been generated yet. The first summary follows automatically once the query compiles.
                </p>
              )}

              {latestUpdate && latestUpdate.changes.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Integrated in this update ({latestUpdate.changes.length}{" "}
                    {latestUpdate.changes.length === 1 ? "change" : "changes"})
                  </h3>
                  <div className="space-y-1.5">
                    {latestUpdate.changes.map((change) => (
                      <div key={change.issueId} className="rounded-md border border-border px-3 py-2 text-xs">
                        {describeChange(change)}
                      </div>
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
                      Today: {rollup.updateCount} updates · {formatTokens(rollup.totalTokens)} ·{" "}
                      {formatCents(rollup.totalCostCents)}
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
